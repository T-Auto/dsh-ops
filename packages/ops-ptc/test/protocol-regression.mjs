/** Run after npm run build: node scripts/protocol-regression.mjs */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { run } = createRequire(import.meta.url)(resolve(root, 'dist/ptc/proc.js'));
const limit = 1 << 20;
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}
const slowBootstrap = `
  const tools = require(${JSON.stringify(resolve(root, 'dist/ptc/tools.js'))});
  let active = 0, peak = 0, calls = 0;
  tools.opsPtcAddition.handlers.__protocol_slow = async (args) => {
    active++; calls++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 80));
    active--;
    return { status: 'ok', peak, calls, ...(args.bytes ? { blob: 'x'.repeat(args.bytes) } : {}) };
  };
  require(${JSON.stringify(resolve(root, 'dist/ptc/mcp.js'))});
`;
function rpc(input, { slow = false, recoverAfter = 0 } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, slow ? ['-e', slowBootstrap] : [resolve(root, 'dist/ptc/mcp.js')], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', recovered = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP timeout')); }, 10000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.stdout.on('data', (c) => {
      out += c;
      if (out.length > 4 * limit) { child.kill(); reject(new Error('unbounded output')); }
      if (recoverAfter && !recovered && out.split('\n').length - 1 >= recoverAfter) {
        recovered = true;
        child.stdin.end(req(999, 'tools/call', { name: '__protocol_slow' }));
      }
    });
    child.stderr.on('data', (c) => { err = (err + c).slice(-4096); });
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      clearTimeout(timer);
      try { assert.equal(code, 0, err); resolveResult(out.trim() ? out.trim().split('\n').map(JSON.parse) : []); }
      catch (e) { reject(e); }
    });
    for (const c of Array.isArray(input) ? input : [input]) child.stdin.write(c);
    if (!recoverAfter) child.stdin.end();
  });
}
const req = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) }) + '\n';
const errorCode = (frames, code, id = null) => {
  assert.equal(frames.length, 1);
  assert.equal(frames[0].error?.code, code);
  assert.equal(frames[0].id, id);
};
await test('inflight 32 cap, silent overload notifications, recovery', async () => {
  const batch = Array.from({ length: 40 }, (_, i) => req(i, 'tools/call', { name: '__protocol_slow' })).join('')
    + req(undefined, 'tools/call', { name: '__protocol_slow' }).repeat(8);
  const frames = await rpc(batch, { slow: true, recoverAfter: 40 });
  assert.equal(frames.length, 41);
  const busy = frames.filter(f => f.error);
  assert.equal(busy.length, 8);
  assert.deepEqual(busy.map(f => f.id), Array.from({ length: 8 }, (_, i) => i + 32));
  for (const f of busy) { assert.equal(f.error.code, -32000); assert.equal(f.error.message, 'Server busy'); }
  const success = frames.filter(f => f.result);
  assert.equal(success.length, 33);
  for (const f of success) assert.equal(f.result.structuredContent.peak, 32);
  assert.equal(success.find(f => f.id === 999).result.structuredContent.calls, 33);
});
await test('stalled stdout Writable exits on 8MiB pending output', async () => {
  await new Promise((resolveResult, reject) => {
    // Windows OS pipes can block synchronously; inject a real async Writable
    // whose write callback never drains to exercise the application buffer gate.
    const stalledStdout = `Object.defineProperty(process, 'stdout', { value: new (require('node:stream').Writable)({ write(chunk, encoding, done) {} }) });`;
    const child = spawn(process.execPath, ['-e', stalledStdout + slowBootstrap], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('slow reader did not terminate')); }, 10000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.stderr.on('data', c => { err = (err + c).slice(-4096); });
    child.stdin.on('error', () => {});
    // Drain the inherited OS pipe after exit; test traffic goes to the injected Writable.
    child.on('exit', () => child.stdout.resume());
    child.on('close', code => {
      clearTimeout(timer);
      try { assert.equal(code, 1); assert.match(err, /Output buffer limit exceeded \(8388608 bytes\)/); resolveResult(); }
      catch (e) { reject(e); }
    });
    child.stdin.end(Array.from({ length: 32 }, (_, i) => req(i, 'tools/call', { name: '__protocol_slow', arguments: { bytes: 512 * 1024 } })).join(''));
  });
});
await test('parse error', async () => errorCode(await rpc('{bad\n'), -32700));
for (const v of [null, [], 1, 'request', {}, { jsonrpc: '1.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: {}, method: 'ping' }, { jsonrpc: '2.0', method: 7 }, { jsonrpc: '2.0', method: 'ping', params: null }]) {
  await test(`invalid request ${JSON.stringify(v)}`, async () => errorCode(await rpc(JSON.stringify(v) + '\n'), -32600));
}
await test('null id gets method error', async () => errorCode(await rpc(req(null, 'unknown')), -32601));
await test('zero and empty string ids', async () => assert.deepEqual((await rpc(req(0, 'ping') + req('', 'ping'))).map(f => f.id), [0, '']));
await test('all notifications silent', async () => {
  const frames = await rpc(['initialize', 'ping', 'tools/list', 'unknown', 'notifications/initialized', 'notifications/cancelled'].map(m => req(undefined, m)).join('') + req(undefined, 'tools/call', { name: 'ops_ptc_inproc', arguments: {} }) + req(undefined, 'tools/call', { name: 'missing' }) + req(undefined, 'tools/call', { name: 'ops_ptc_inproc', arguments: null }));
  assert.deepEqual(frames, []);
});
await test('business errors have isError and structured outcome', async () => {
  const [f] = await rpc(req(1, 'tools/call', { name: 'ops_ptc_inproc', arguments: {} }));
  assert.equal(f.result.isError, true);
  assert.equal(f.result.structuredContent.code, 'E_BAD_ARGS');
  assert.deepEqual(JSON.parse(f.result.content[0].text), f.result.structuredContent);
});
for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
  await test(`prototype ${name}`, async () => errorCode(await rpc(req(1, 'tools/call', { name })), -32602, 1));
}
for (const params of [[], { name: 42 }, { name: 'ops_ptc_inproc', arguments: null }, { name: 'ops_ptc_inproc', arguments: [] }]) {
  await test(`invalid tool params ${JSON.stringify(params)}`, async () => errorCode(await rpc(req(1, 'tools/call', params)), -32602, 1));
}
await test('oversize discard and recovery', async () => {
  const frames = await rpc([' '.repeat(limit), 'x'.repeat(32), '\n', req(8, 'ping')]);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].error?.code, -32600);
  assert.deepEqual(frames[1], { jsonrpc: '2.0', id: 8, result: {} });
});
await test('UTF8 byte limit', async () => errorCode(await rpc(req(1, 'ping', { text: '汉'.repeat(Math.ceil(limit / 3)) })), -32600));
await test('EOF final frame', async () => assert.deepEqual((await rpc(req(1, 'ping').trimEnd()))[0].result, {}));
await test('split UTF8 and CRLF', async () => {
  const bytes = Buffer.from(req('汉', 'ping').trimEnd() + '\r\n');
  const i = bytes.indexOf(Buffer.from('汉')) + 1;
  assert.equal((await rpc([bytes.subarray(0, i), bytes.subarray(i)]))[0].id, '汉');
});
await test('server release version', async () => assert.equal((await rpc(req(1, 'initialize')))[0].result.serverInfo.version, createRequire(import.meta.url)(resolve(root, 'package.json')).version));
const childRun = (code, options = {}) => run(process.execPath, ['-e', code], 'pipeline', { maxOutputBytes: 1024, timeoutMs: 1000, ...options });
for (const [name, code] of [
  ['stdout overflow', "process.stdout.write('x'.repeat(65536))"],
  ['stderr overflow', "process.stderr.write('x'.repeat(65536))"],
  ['combined output overflow', "process.stdout.write('x'.repeat(700));process.stderr.write('y'.repeat(700))"],
  ['continuing writer terminated', "setInterval(()=>process.stderr.write('x'.repeat(2048)),10)"],
]) await test(name, async () => assert.rejects(childRun(code), { code: 'E_OUTPUT_LIMIT' }));
await test('exact boundary preserves both streams', async () => {
  const out = await childRun("process.stdout.write('x'.repeat(512));process.stderr.write('y'.repeat(512))");
  assert.equal(out.code, 0); assert.equal(out.stdout.length + out.stderr.length, 1024); assert.equal(out.truncated, false);
});
for (const maxOutputBytes of [0, -1, NaN, Infinity]) {
  await test(`invalid output budget ${maxOutputBytes}`, async () => assert.rejects(childRun('', { maxOutputBytes }), { code: 'E_BAD_ARGS' }));
}
console.log(`protocol regression: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
