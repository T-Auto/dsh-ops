import './lib/ast-cli.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
/**
 * 端到端冒烟：在 .sandbox/ 的副本上跑，绝不碰用户原文件。
 * 用法：node scripts/smoke.mjs [esPath]
 */
import { cpSync, existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(resolve(tmpdir(), 'dsh-refactor-smoke-'));
const esPath = process.argv[2] ?? process.env.PTC_ES ?? resolve(root, 'vendor/es.exe');

mkdirSync(sandbox, { recursive: true });
const target = resolve(sandbox, 'fixture.ts');

const fixture = `function login(user: string): boolean {
  const ok = user.length > 0;
  return true;
}

function logout(): void {
  return;
}
`;
cpSync(resolve(root, 'lib/ast/agentbox.worker.cjs'), resolve(sandbox, 'agentbox.worker.cjs'), { force: true });
const { writeFileSync } = await import('node:fs');
writeFileSync(target, fixture, 'utf8');

const run = (args) =>
  spawnSync(process.execPath, [resolve(root, 'lib/ast/pipeline.cjs'), ...args], {
    cwd: sandbox,
    encoding: 'utf8',
    env: { ...process.env, PTC_ES: esPath, PTC_DEBUG: '1' },
  });

const cases = [
  {
    name: '① 正常改写（return true -> return false）',
    args: ['--file', 'fixture.ts', '--symbol', 'login', '--pattern', 'return true', '--rewrite', 'return false'],
    expect: (r) => r.status === 'ok' && r.hunks >= 1,
  },
  {
    name: '② 熔断：pattern 零命中',
    args: ['--file', 'fixture.ts', '--symbol', 'login', '--pattern', 'return 42', '--rewrite', 'return 43'],
    expect: (r) => r.status === 'error' && r.code === 'E_ASTGREP_NO_MATCH',
  },
  {
    name: '③ 熔断：符号不存在',
    args: ['--file', 'fixture.ts', '--symbol', 'nope', '--pattern', 'return false', '--rewrite', 'return true'],
    expect: (r) => r.status === 'error' && r.code === 'E_SANE_SYMBOL_NOT_FOUND',
  },
  {
    name: '④ 未命中 Everything 查询',
    args: ['--query', 'zzz_no_such_file_zzz', '--symbol', 'login', '--pattern', 'return false', '--rewrite', 'return true'],
    expect: (r) => r.status === 'error' && // 仓库不提交 es.exe：二进制缺失时这条路径的诚实答案是 E_BIN_MISSING
      (r.code === 'E_EVERYTHING_NOT_FOUND' || r.code === 'E_EVERYTHING_IPC' || r.code === 'E_BIN_MISSING'),
  },
  {
    name: '⑦ preview：只走内存审计，不落盘',
    args: [
      '--file', 'fixture.ts', '--symbol', 'login',
      '--pattern', 'return false', '--rewrite', 'return true', '--mode', 'preview',
    ],
    expect: (r) => r.status === 'ok' && r.mode === 'preview' && r.hunks >= 1,
  },
];

let failed = 0;
for (const c of cases) {
  const res = run(c.args);
  let out;
  try {
    out = JSON.parse(res.stdout);
  } catch {
    out = { status: 'error', code: 'E_BAD_JSON', message: res.stdout.slice(0, 200) + res.stderr.slice(0, 200) };
  }
  const ok = c.expect(out);
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name}`);
  console.log('     ' + JSON.stringify(out));
}

const after = readFileSync(target, 'utf8');
const mutated = after.includes('return false;');
console.log(`${mutated ? 'PASS' : 'FAIL'} ⑤ 文件已按补丁改写且分号未丢`);
if (!mutated) failed += 1;
console.log('----- fixture.ts -----');
console.log(after);

/* ── ⑥ CRLF + 中文：验证 \r\n 保留与 UTF-8 字节偏移都不出错 ── */
const crlf = resolve(sandbox, 'fixture-crlf.ts');
const crlfBody =
  '// 中文注释：登录校验，长度 3 个汉字占 9 字节，专门用来测偏移\r\n' +
  'function login(user: string): boolean {\r\n' +
  '  const ok = user.length > 0;\r\n' +
  '  return true;\r\n' +
  '}\r\n';
rmSync(crlf, { force: true });
writeFileSync(crlf, crlfBody, 'utf8');

const crlfRes = run(['--file', 'fixture-crlf.ts', '--symbol', 'login', '--pattern', 'return true', '--rewrite', 'return false']);
let crlfOut;
try {
  crlfOut = JSON.parse(crlfRes.stdout);
} catch {
  crlfOut = { status: 'error', code: 'E_BAD_JSON' };
}
const crlfAfter = readFileSync(crlf, 'utf8');
const crlfOk =
  crlfOut.status === 'ok' &&
  crlfAfter.includes('return false;') &&
  crlfAfter.includes('中文注释') &&
  !/(?<!\r)\n/.test(crlfAfter); // 不允许出现裸 LF
console.log(`${crlfOk ? 'PASS' : 'FAIL'} ⑥ CRLF + 中文源码：换行风格与 UTF-8 偏移无损`);
console.log('     ' + JSON.stringify(crlfOut));
if (!crlfOk) {
  failed += 1;
  console.log('     ' + JSON.stringify(crlfAfter));
}

process.exit(failed === 0 ? 0 : 1);
