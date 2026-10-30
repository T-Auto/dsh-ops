import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Run current TypeScript sources without rebuilding or consuming stale dist artifacts.
const require = createRequire(import.meta.url);
const ts = require('typescript');
const oldLoader = require.extensions['.ts'];
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, file);
let stages, proc, runRefactorPipeline;
try {
  stages = require('../src/ptc/stages.js');
  proc = require('../src/ptc/proc.js');
  ({ runRefactorPipeline } = require('../src/ptc/pipeline.js'));
} finally {
  if (oldLoader) require.extensions['.ts'] = oldLoader;
  else delete require.extensions['.ts'];
}
const { agentBoxRestore, applyEditsInMemory, difftasticAudit, everythingFind, sha256 } = stages;
const root = realpathSync(mkdtempSync(join(tmpdir(), 'ptc-pipeline-regression-')));
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const worker = join(project, 'src/ptc/agentbox.worker.cjs');
const log = join(root, 'audit.jsonl');
const fixtureScript = join(root, 'external-fixture.cjs');
// Deterministic protocol fixtures run as real subprocesses. The real AST auditor
// and real AgentBox worker remain in the pipeline, including their write guards.
writeFileSync(fixtureScript, `
const fs = require('node:fs');
const [mode, log, ...args] = process.argv.slice(2);
if (mode === 'es') { process.stdout.write(fs.readFileSync(log)); }
else if (mode.startsWith('sg')) {
  const file = args[args.indexOf('--lang') + 2];
  const text = fs.readFileSync(file, 'utf8');
  const rewrite = args.includes('--rewrite');
  const token = /return [^;]+;/.exec(text);
  const start = rewrite ? Buffer.byteLength(text.slice(0, token.index)) : 0;
  const end = rewrite ? start + Buffer.byteLength(token[0]) : Buffer.byteLength(text);
  const record = {
    text: rewrite ? token[0] : text,
    range: { byteOffset: { start, end }, start: { line: 0, column: start }, end: { line: 0, column: end } },
    metaVariables: { single: { NAME: { text: 'demo' } } },
  };
  if (rewrite) { record.replacement = args[args.indexOf('--rewrite') + 1]; record.replacementOffsets = { start, end }; }
  if ((mode === 'sg-change-locate' && !rewrite) || (mode === 'sg-change-rewrite' && rewrite)) {
    fs.writeFileSync(file, text + '// concurrent change\\n');
  }
  process.stdout.write(JSON.stringify(record));
} else if (args.includes('--version')) {
  process.stdout.write('difftastic fixture 0.60');
  if (mode === 'probe-fail') process.exitCode = 1;
} else {
  const before = args.at(-2), after = args.at(-1);
  fs.appendFileSync(log, JSON.stringify({ before, after, beforeText: fs.readFileSync(before, 'utf8'), afterText: fs.readFileSync(after, 'utf8') }) + '\\n');
  if (mode === 'timeout') setTimeout(() => {}, 20000);
  else if (mode === 'exit') { process.stderr.write('forced audit failure'); process.exitCode = 7; }
  else if (mode === 'empty') process.stdout.write('');
  else setTimeout(() => process.stdout.write(JSON.stringify({ language: mode === 'text' ? 'Text' : 'TypeScript', chunks: [{}] })), 40);
}
`);
const realRun = proc.run;
const routes = new Map();
let serial = 0, passed = 0, workerCalls = 0;
const failures = [];
function fixture(content = 'function demo(){return 1;}\n') {
  const file = join(root, `target-${serial++}.ts`);
  writeFileSync(file, content);
  return file;
}
function bin(mode, data = log) {
  const file = join(root, `tool-${serial++}`);
  writeFileSync(file, 'protocol fixture');
  routes.set(file, { mode, data });
  return file;
}
proc.run = (exe, args, stage, opts) => {
  const route = routes.get(exe);
  if (route) {
    // A successful version probe followed by a thrown spawn error exercises
    // the path that used to bypass every explicit rm call.
    if (route.mode === 'throw' && !args.includes('--version')) {
      return Promise.reject(new proc.PtcOutcomeError('E_BIN_MISSING', 'difftastic', 'injected spawn failure'));
    }
    return realRun(process.execPath, [fixtureScript, route.mode, route.data, ...args], stage, opts);
  }
  if (stage === 'agentbox') workerCalls++;
  return realRun(exe, args, stage, opts);
};
const cfg = (over = {}) => proc.defaultConfig({
  cwd: root, agentBoxWorker: worker, sgPath: bin('sg'), difftPath: bin('success'),
  requireAudit: true, timeoutMs: 5000, ...over,
});
const tempDirs = () => readdirSync(tmpdir()).filter(n => n.startsWith(`ptc-${process.pid}-`)).sort();
const readLog = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
function assertAuditClean(baseline) {
  assert.deepEqual(tempDirs(), baseline, 'audit must remove exactly its owned temporary directories');
  for (const record of readLog()) {
    assert.equal(existsSync(dirname(dirname(record.before))), false, `leaked ${record.before}`);
  }
}
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack}`); }
}
const edits = [{ startByte: 0, endByte: 1, before: '1', text: '2' }];
const request = file => ({ file, query: '', symbol: 'demo', astPattern: 'return 1;', astRewrite: 'return 123456789;', mode: 'apply' });
try {
  for (const [name, original, current] of [
    ['growth', '原文\r\n', '原文扩展后的长文本\r\n'],
    ['shrinkage', 'original longer body\n', 'x'],
    ['empty current file', 'restore nonempty\n', ''],
    ['empty original', '', 'remove all current bytes'],
  ]) await test(`restore after ${name} replaces the entire current image`, async () => {
    const file = fixture(current), before = Buffer.from(original);
    await agentBoxRestore(cfg(), file, before, sha256(Buffer.from(current)));
    assert.deepEqual(readFileSync(file), before);
  });
  await test('restore rejects a stale hash and preserves the concurrent image', async () => {
    const file = fixture('new version');
    await assert.rejects(agentBoxRestore(cfg(), file, Buffer.from('old'), sha256(Buffer.from('stale image'))),
      e => e.code === 'E_AGENTBOX_REJECTED' && e.detail.code === 'E_AGENTBOX_HASH_MISMATCH');
    assert.equal(readFileSync(file, 'utf8'), 'new version');
  });
  await test('in-memory edits reject NaN, infinity, fractions, strings and unsafe offsets', () => {
    for (const bad of [NaN, Infinity, -Infinity, 0.5, -1, 4, Number.MAX_SAFE_INTEGER + 1, '1', undefined, null]) {
      for (const key of ['startByte', 'endByte']) {
        assert.throws(() => applyEditsInMemory(Buffer.from('abc'), [{ startByte: 0, endByte: 1, text: 'x', [key]: bad }]),
          e => e.code === 'E_AGENTBOX_REJECTED', `${key}=${String(bad)}`);
      }
    }
    assert.throws(() => applyEditsInMemory(Buffer.from('abc'), [
      { startByte: 0, endByte: 2, text: '' }, { startByte: 1, endByte: 3, text: '' },
    ]), e => e.code === 'E_AGENTBOX_REJECTED');
    assert.equal(applyEditsInMemory(Buffer.from('abc'), [{ startByte: 3, endByte: 3, text: '😀' }]).toString(), 'abc😀');
  });
  await test('Everything enforces cwd boundaries, explicit roots and global opt-in', async () => {
    // 仓库不提交二进制：没有 es.exe 时这条用例无意义，跳过并说明原因。
    const esBin = require('../src/ptc/proc.js').pickExistingEs(process.env.PTC_ES, process.cwd());
    if (!esBin) { console.log('SKIP Everything 边界：本机没有 es.exe（包内 vendor 不入库）'); return; }
    const cwd = join(root, 'inside');
    const inside = join(cwd, 'target.ts'), sibling = join(root, 'inside-sibling', 'target.ts');
    const other = join(root, 'other', 'target.ts'), traversal = join(cwd, '..', 'escape.ts');
    const data = join(root, 'es-output.txt');
    writeFileSync(data, [sibling, other, traversal, inside].join('\n'));
    const c = cfg({ cwd, esPath: bin('es', data) });
    // The child process needs an existing cwd, independent of indexed file existence.
    const { mkdirSync } = require('node:fs'); mkdirSync(cwd);
    assert.deepEqual(await everythingFind(c, { pattern: 'target.ts' }), [inside]);
    assert.deepEqual(await everythingFind(c, { pattern: 'target.ts', roots: [join(root, 'other')] }), [other]);
    assert.deepEqual(new Set(await everythingFind(c, { pattern: 'target.ts', scope: 'global' })), new Set([sibling, other, traversal, inside]));
    assert.deepEqual(await everythingFind(c, { pattern: 'target.ts', scope: 'global', roots: [cwd] }), [inside]);
    await assert.rejects(everythingFind(c, { pattern: 'target.ts', roots: [join(root, 'absent')] }), e => e.code === 'E_EVERYTHING_NOT_FOUND');
  });
  await test('concurrent audits use unique pairs even at identical timestamps and clean on success', async () => {
    const baseline = tempDirs(), offset = readLog().length;
    const clock = Date.now; Date.now = () => 1700000000000;
    let results;
    try {
      results = await Promise.all(Array.from({ length: 12 }, (_, i) => difftasticAudit(
        cfg(), Buffer.from(`before-${i}`), join(root, 'same.ts'), edits, Buffer.from(`after-${i}`),
      )));
    } finally { Date.now = clock; }
    const records = readLog().slice(offset);
    assert.equal(records.length, 12);
    assert.equal(new Set(records.map(r => dirname(dirname(r.before)))).size, 12);
    assert.deepEqual(new Set(records.map(r => `${r.beforeText}|${r.afterText}`)), new Set(Array.from({ length: 12 }, (_, i) => `before-${i}|after-${i}`)));
    assert.ok(results.every(r => r.dir === '' && r.audit.language === 'TypeScript'));
    assertAuditClean(baseline);
  });
  for (const [mode, code] of [['throw', 'E_BIN_MISSING'], ['exit', 'E_DIFF_FAILED'], ['empty', 'E_DIFF_EMPTY'], ['text', 'E_DIFF_FAILED'], ['timeout', 'E_TIMEOUT']]) {
    await test(`audit ${mode} cleans owned temporary files`, async () => {
      const baseline = tempDirs();
      await assert.rejects(difftasticAudit(cfg({ difftPath: bin(mode), timeoutMs: mode === 'timeout' ? 400 : 5000 }), Buffer.from('1'), join(root, 'audit.ts'), edits, Buffer.from('2')),
        e => e.code === code);
      assertAuditClean(baseline);
    });
  }
  await test('unavailable audit degrades and cleans its pair', async () => {
    const baseline = tempDirs();
    const result = await difftasticAudit(cfg({ difftPath: bin('probe-fail') }), Buffer.from('1'), join(root, 'audit.ts'), edits, Buffer.from('2'));
    assert.equal(result.audit.degraded, 'difftastic-unavailable'); assert.equal(result.dir, '');
    assertAuditClean(baseline);
  });
  await test('audit pair creation failure cleans the partial directory', async () => {
    const baseline = tempDirs();
    await assert.rejects(difftasticAudit(cfg(), Buffer.from('1'), join(root, 'missing.ts'), edits), e => e.code === 'ENOENT');
    assertAuditClean(baseline);
  });
  await test('null, non-object and invalid-mode pipeline requests return E_BAD_ARGS without spawning', async () => {
    const c = cfg(), before = workerCalls;
    for (const req of [null, undefined, [], 'bad', 1, { ...request(fixture()), mode: null }, { ...request(fixture()), mode: 'invalid' }]) {
      const outcome = await runRefactorPipeline(req, c);
      assert.equal(outcome.code, 'E_BAD_ARGS'); assert.equal(outcome.status, 'error'); assert.deepEqual(outcome.stages, []);
    }
    assert.equal(workerCalls, before);
  });
  await test('broken TypeScript candidate is rejected before any worker write', async () => {
    const file = fixture(), before = readFileSync(file), calls = workerCalls;
    const outcome = await runRefactorPipeline({ ...request(file), astRewrite: 'return (' }, cfg());
    assert.equal(outcome.status, 'error'); assert.equal(outcome.code, 'E_DIFF_FAILED');
    assert.deepEqual(readFileSync(file), before); assert.equal(workerCalls, calls);
  });
  await test('legal growth then shrinkage apply through the real worker', async () => {
    const file = fixture(), c = cfg();
    const grow = await runRefactorPipeline(request(file), c);
    assert.equal(grow.status, 'ok', JSON.stringify(grow));
    assert.equal(readFileSync(file, 'utf8'), 'function demo(){return 123456789;}\n');
    const shrink = await runRefactorPipeline({ ...request(file), astPattern: 'return 123456789;', astRewrite: 'return 0;' }, c);
    assert.equal(shrink.status, 'ok', JSON.stringify(shrink));
    assert.equal(readFileSync(file, 'utf8'), 'function demo(){return 0;}\n');
    assert.ok(grow.stages.indexOf('difftastic') < grow.stages.indexOf('agentbox'));
  });
  await test('preview audits the full candidate and leaves the source unchanged', async () => {
    const file = fixture(), before = readFileSync(file), calls = workerCalls;
    const outcome = await runRefactorPipeline({ ...request(file), mode: 'preview' }, cfg());
    assert.equal(outcome.status, 'ok', JSON.stringify(outcome));
    assert.deepEqual(readFileSync(file), before); assert.equal(workerCalls, calls);
  });
  await test('required unavailable audit aborts before writing', async () => {
    const file = fixture(), before = readFileSync(file), calls = workerCalls;
    const outcome = await runRefactorPipeline(request(file), cfg({ difftPath: bin('probe-fail') }));
    assert.equal(outcome.code, 'E_DIFF_FAILED'); assert.deepEqual(readFileSync(file), before); assert.equal(workerCalls, calls);
  });
  for (const mode of ['sg-change-locate', 'sg-change-rewrite']) await test(`${mode} detects concurrent source drift before writing`, async () => {
    const file = fixture(), before = readFileSync(file, 'utf8'), calls = workerCalls;
    const outcome = await runRefactorPipeline(request(file), cfg({ sgPath: bin(mode) }));
    assert.equal(outcome.status, 'error');
    assert.equal(readFileSync(file, 'utf8'), before + '// concurrent change\n'); assert.equal(workerCalls, calls);
  });
  console.log(`${passed}/${passed + failures.length} pipeline regression checks passed`);
  if (failures.length) throw new Error(`Pipeline regression failures: ${failures.join(', ')}`);
} finally {
  proc.run = realRun;
  // This exact mkdtemp-owned path is the only fixture tree removed.
  assert.equal(realpathSync(root), resolve(root));
  rmSync(root, { recursive: true, force: true });
}
