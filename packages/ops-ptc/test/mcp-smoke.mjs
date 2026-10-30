/**
 * MCP 层冒烟：以 stdio 客户端身份跑一次 initialize → tools/list → tools/call。
 * 断言「不加载也能看到完整 schema」「调用返回的是一行极简 JSON」。
 * 用法：node scripts/mcp-smoke.mjs [esPath]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = resolve(root, '.sandbox');
const esPath = process.argv[2] ?? process.env.PTC_ES ?? resolve(root, 'vendor/es.exe');

mkdirSync(sandbox, { recursive: true });
const target = resolve(sandbox, 'mcp-fixture.ts');
rmSync(target, { force: true });
writeFileSync(
  target,
  'export function flag(): boolean {\n  return true;\n}\n',
  'utf8',
);

const child = spawn(process.execPath, [resolve(root, 'dist/ptc/mcp.js')], {
  cwd: sandbox,
  env: { ...process.env, PTC_ES: esPath },
  stdio: ['pipe', 'pipe', 'pipe'],
});

const frames = [];
let buf = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => {
  buf += c;
  let nl = buf.indexOf('\n');
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    nl = buf.indexOf('\n');
    if (!line) continue;
    try {
      frames.push(JSON.parse(line));
    } catch {
      frames.push({ raw: line });
    }
  }
});
child.stderr.setEncoding('utf8');
let stderr = '';
child.stderr.on('data', (c) => (stderr += c));

const send = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke' } } });
send({ method: 'notifications/initialized', params: {} });
send({ id: 2, method: 'tools/list', params: {} });
send({
  id: 3,
  method: 'tools/call',
  params: {
    name: 'ops_ptc_refactor',
    arguments: { file: 'mcp-fixture.ts', symbol: 'flag', pattern: 'return true', rewrite: 'return false' },
  },
});
child.stdin.end();

const code = await new Promise((r) => child.on('close', r));
const byId = (id) => frames.find((f) => f.id === id);

let failed = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`);
};

const init = byId(1);
check('① initialize 返回 serverInfo', init?.result?.serverInfo?.name === 'ops-ptc');

const list = byId(2);
const tools = list?.result?.tools ?? [];
const toolNames = tools.map((t) => t?.name);
check(
  '② tools/list 暴露 5 个工具且标记 on-demand',
  tools.length === 5 &&
    list?.result?._meta?.load === 'on-demand' &&
    ['ops_ptc_locate', 'ops_ptc_inproc', 'ops_ptc_refactor'].every((n) => toolNames.includes(n)),
  `[${tools.map((t) => t.name).join(', ')}]`,
);

const call = byId(3);
const payload = (() => {
  try {
    return JSON.parse(call?.result?.content?.[0]?.text ?? '{}');
  } catch {
    return {};
  }
})();
check(
  '③ tools/call 返回极简 JSON 且后四段全绿',
  payload.status === 'ok' &&
    ['sane', 'astgrep', 'agentbox', 'difftastic'].every((s) => payload.stages?.includes(s)),
  JSON.stringify(payload),
);
check('④ 返回体 < 1KB（中间态没进上下文）', JSON.stringify(payload).length < 1024, `${JSON.stringify(payload).length} bytes`);
check('⑤ stderr 无协议噪音', !/unhandled|Error/i.test(stderr), stderr.slice(0, 120));

console.log(`[mcp child exit=${code}]`);
process.exit(failed === 0 && code === 0 ? 0 : 1);
