import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, chmodSync, linkSync, openSync, closeSync, ftruncateSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ptc-worker-regression-')));
const worker = resolve(dirname(fileURLToPath(import.meta.url)), '../src/ptc/agentbox.worker.cjs');
const sha = b => createHash('sha256').update(b).digest('hex');
let serial = 0, passed = 0;
const failures = [];
const fixture = (content = 'abc') => {
  const file = join(root, `target-${serial++}.bin`);
  writeFileSync(file, content);
  return file;
};
const payload = (file, edits = [{ start: 1, end: 2, b64: Buffer.from('Z').toString('base64') }]) => ({ path: file, expectSha256: sha(readFileSync(file)), atomic: true, edits });
function run(input, hook) {
  const args = [];
  if (hook) {
    const preload = join(root, `preload-${serial++}.cjs`);
    writeFileSync(preload, hook);
    args.push('--require', preload);
  }
  args.push(worker);
  const result = spawnSync(process.execPath, args, { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
  assert.ifError(result.error);
  assert.ok(result.status === 0 || result.status === 2, `worker exit ${result.status}: ${result.stderr}`);
  const body = JSON.parse(result.stdout);
  assert.equal(result.status, body.ok ? 0 : 2);
  return body;
}
function rejectUnchanged(input, code, hook) {
  const before = readFileSync(input.path);
  const result = run(input, hook);
  assert.equal(result.ok, false);
  assert.equal(result.code, code);
  assert.deepEqual(readFileSync(input.path), before);
}
function noArtifacts(file) {
  const prefix = file.slice(file.lastIndexOf('\\') + 1).split('/').at(-1);
  assert.equal(readdirSync(root).filter(name => name.startsWith(`${prefix}.ptc-`) || name === `${prefix}.ops-ptc.lock`).length, 0);
}
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
try {
  test('byte edits preserve Unicode CRLF and report matching hashes', () => {
    const before = Buffer.from('// 中文😀\r\nabc\r\n');
    const file = fixture(before), start = before.indexOf(Buffer.from('abc'));
    const result = run(payload(file, [{ start, end: start + 3, b64: Buffer.from('XYZ').toString('base64') }]));
    const after = Buffer.from('// 中文😀\r\nXYZ\r\n');
    assert.equal(result.ok, true); assert.deepEqual(readFileSync(file), after);
    assert.equal(result.sha256Before, sha(before)); assert.equal(result.sha256After, sha(after)); noArtifacts(file);
  });
  test('arbitrary binary bytes are not transcoded', () => {
    const file = fixture(Buffer.from([255, 0, 128, 13, 10]));
    assert.equal(run(payload(file, [{ start: 1, end: 2, b64: '/g==' }])).ok, true);
    assert.deepEqual(readFileSync(file), Buffer.from([255, 254, 128, 13, 10])); noArtifacts(file);
  });
  test('malformed JSON and missing hash fail closed', () => {
    assert.equal(run('{').code, 'E_AGENTBOX_PAYLOAD');
    const file = fixture(), req = payload(file); delete req.expectSha256;
    rejectUnchanged(req, 'E_AGENTBOX_PAYLOAD');
  });
  test('non-atomic copy mode is rejected without writing', () => { const file = fixture(); rejectUnchanged({ ...payload(file), atomic: false }, 'E_AGENTBOX_ATOMIC'); });
  test('stale pre-image hash is rejected', () => { const file = fixture(); rejectUnchanged({ ...payload(file), expectSha256: '0'.repeat(64) }, 'E_AGENTBOX_HASH_MISMATCH'); });
  test('invalid ranges coercions and base64 fail closed', () => {
    const file = fixture();
    for (const edit of [{ start: '1', end: 2, b64: 'WA==' }, { start: 1.5, end: 2, b64: 'WA==' }, { start: 1, end: 2, b64: '!!!' }, null]) rejectUnchanged(payload(file, [edit]), 'E_AGENTBOX_PAYLOAD');
    rejectUnchanged(payload(file, [{ start: -1, end: 2, b64: '' }]), 'E_AGENTBOX_RANGE');
  });
  test('overlapping byte edits fail without writing', () => { const file = fixture(); rejectUnchanged(payload(file, [{ start: 0, end: 2, b64: '' }, { start: 1, end: 3, b64: '' }]), 'E_AGENTBOX_OVERLAP'); });
  test('stdin is bounded before JSON parsing', () => { assert.equal(run(' '.repeat(16 * 1024 * 1024 + 1)).code, 'E_AGENTBOX_PAYLOAD_TOO_BIG'); });
  test('oversized target is rejected before full allocation', () => {
    const file = fixture(), fd = openSync(file, 'r+');
    try { ftruncateSync(fd, 16 * 1024 * 1024 + 1); } finally { closeSync(fd); }
    const result = run({ path: file, expectSha256: '0'.repeat(64), edits: [] });
    assert.equal(result.code, 'E_AGENTBOX_TOO_BIG'); assert.equal(statSync(file).size, 16 * 1024 * 1024 + 1); noArtifacts(file);
  });
  test('oversized output is rejected before concatenation', () => {
    const file = fixture(Buffer.alloc(16 * 1024 * 1024));
    rejectUnchanged(payload(file, [{ start: 0, end: 0, b64: 'WA==' }]), 'E_AGENTBOX_TOO_BIG'); noArtifacts(file);
  });
  test('cooperative lock is respected and foreign lock survives', () => {
    const file = fixture(), lock = `${file}.ops-ptc.lock`; writeFileSync(lock, 'foreign');
    rejectUnchanged(payload(file), 'E_AGENTBOX_LOCKED'); assert.equal(readFileSync(lock, 'utf8'), 'foreign');
  });
  test('late snapshot change survives and owned artifacts are cleaned', () => {
    const file = fixture(), req = payload(file);
    const hook = `const fs=require('node:fs/promises'), native=require('node:fs'); const chmod=fs.chmod; fs.chmod=async function(path,mode){await chmod(path,mode); if(String(path).includes('.ptc-')) native.writeFileSync(${JSON.stringify(file)},'external');};`;
    const result = run(req, hook); assert.equal(result.code, 'E_AGENTBOX_CHANGED'); assert.equal(readFileSync(file, 'utf8'), 'external'); noArtifacts(file);
  });
  test('rename failure preserves original and cleans temp and lock', () => {
    const file = fixture();
    const hook = `const fs=require('node:fs/promises'); fs.rename=async()=>{throw Object.assign(new Error('injected rename failure'),{code:'EIO'});};`;
    rejectUnchanged(payload(file), 'EIO', hook); noArtifacts(file);
  });
  test('temporary files are unpredictable exclusive and preserve mode', () => {
    const file = fixture(), log = join(root, `opens-${serial++}.jsonl`); chmodSync(file, 0o640);
    const mode = statSync(file).mode & 0o777;
    const hook = `const fs=require('node:fs/promises'), native=require('node:fs'); const open=fs.open; fs.open=async function(path,flags,...args){if(String(path).includes('.ptc-')) native.appendFileSync(${JSON.stringify(log)},JSON.stringify({path:String(path),flags})+'\\n');return open.call(this,path,flags,...args);};`;
    assert.equal(run(payload(file), hook).ok, true); assert.equal(run(payload(file), hook).ok, true);
    const opens = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(opens.length, 2); assert.notEqual(opens[0].path, opens[1].path);
    for (const item of opens) { assert.equal(item.flags, 'wx'); assert.match(item.path, /\.ptc-[0-9a-f-]{36}\.tmp$/); }
    assert.equal(statSync(file).mode & 0o777, mode); noArtifacts(file);
  });
  test('exclusive temp collision preserves foreign temp', () => {
    const file = fixture(), log = join(root, `collision-${serial++}.txt`);
    const hook = `const fs=require('node:fs/promises'), native=require('node:fs');const open=fs.open;fs.open=async function(path,flags,...args){if(String(path).includes('.ptc-')){native.writeFileSync(path,'foreign');native.writeFileSync(${JSON.stringify(log)},String(path));}return open.call(this,path,flags,...args);};`;
    rejectUnchanged(payload(file), 'EEXIST', hook);
    assert.equal(readFileSync(readFileSync(log, 'utf8'), 'utf8'), 'foreign'); assert.ok(!readdirSync(root).some(name => name.endsWith('.ops-ptc.lock') && name.startsWith(file.split(/[\\/]/).at(-1))));
  });
  test('hardlinked targets are rejected without changing aliases', () => {
    const file = fixture(), alias = join(root, `alias-${serial++}`); linkSync(file, alias);
    rejectUnchanged(payload(file), 'E_AGENTBOX_FILE_TYPE'); assert.equal(readFileSync(alias, 'utf8'), 'abc'); noArtifacts(file);
  });
  console.log(`${passed}/${passed + failures.length} worker regression checks passed`);
  if (failures.length) throw new Error(`Worker regression failures: ${failures.join(', ')}`);
} finally {
  assert.equal(realpathSync(root), resolve(root));
  rmSync(root, { recursive: true, force: true });
}
