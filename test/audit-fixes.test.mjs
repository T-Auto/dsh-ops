/**
 * Assertions for the boundary findings of the 0.3.1 Linux x64 audit.
 *
 * Each check names the finding it pins down, so a failure says which guarantee
 * regressed rather than only where. The metadata checks use python3 for extended
 * attributes because Node exposes no xattr API; a host without python3 skips that
 * one check instead of failing it, the same way test/file-metadata.test.mjs does.
 *
 * The privileged half of the metadata contract — an attribute the destination
 * refuses to hold — cannot be produced portably here: setting security.capability
 * needs CAP_SETFCAP, which a normal test process does not have. It is covered by
 * hand (see /root/Temp/fix方案.md, FIX-01c) and asserted here only through the
 * contract field, which must stay present and zero on the happy path.
 *
 * @module dsh-ops/test/audit-fixes
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { credentialPath } from '../lib/credential-policy.js'
import { refusesReservedStore } from '../lib/file/worker.js'
import { callTool, envelopeOf, requireWorker } from './lib/boundary.mjs'
import { PACKAGE_ROOT, assert, report, test, withTempDir } from './lib/harness.mjs'

requireWorker('audit-fixes')

const POSIX = process.platform !== 'win32'
const WORKER_BASENAME = POSIX ? 'dsh-ops-worker' : 'dsh-ops-worker.exe'

/** Whether a helper binary answers; a missing one skips its check, never fails it. */
const available = (command, args) => {
  try { return spawnSync(command, args, { stdio: 'ignore' }).status === 0 } catch { return false }
}
const PYTHON = available('python3', ['-c', 'pass'])
const SKIP_NO_PYTHON = 'python3 is not installed, so the xattr case cannot be exercised on this host'

/** Set/read one extended attribute through python3, which is the only xattr API here. */
const setXattr = (file, name, value) => spawnSync('python3',
  ['-c', "import os,sys; os.setxattr(sys.argv[1], sys.argv[2], sys.argv[3].encode())", file, name, value],
  { encoding: 'utf8' })
const getXattr = (file, name) => spawnSync('python3',
  ['-c', "import os,sys; sys.stdout.write(os.getxattr(sys.argv[1], sys.argv[2]).decode())", file, name],
  { encoding: 'utf8' }).stdout

const authority = workspace => ({ root: workspace, writeRoots: [workspace] })

await test('a copy carries the mode and the user attributes the source had', async () => {
  if (!PYTHON) { assert.ok(true, SKIP_NO_PYTHON); return }
  await withTempDir('audit-copy-metadata', async workspace => {
    const source = path.join(workspace, 'source.txt')
    fs.writeFileSync(source, 'PAYLOAD\n')
    fs.chmodSync(source, 0o640)
    setXattr(source, 'user.audit', 'kept')

    const body = envelopeOf(await callTool('batch',
      { action: 'run', operations: [{ op: 'copy', path: 'source.txt', to: 'copy.txt' }] },
      authority(workspace)), assert)
    assert.equal(body.status, 'completed', JSON.stringify(body))
    assert.equal(body.metadataNotPreserved, 0, 'an attribute the destination can hold must travel')

    const target = path.join(workspace, 'copy.txt')
    assert.equal(fs.readFileSync(target, 'utf8'), 'PAYLOAD\n')
    assert.equal(fs.statSync(target).mode & 0o777, 0o640, 'the mode is not optional')
    assert.equal(getXattr(target, 'user.audit'), 'kept', 'the attribute travels with the copy')
  })
})

await test('a same-device move renames the inode instead of copying it', async () => {
  if (!POSIX) { assert.ok(true, 'inode identity is a POSIX concept'); return }
  await withTempDir('audit-move-rename', async workspace => {
    const source = path.join(workspace, 'move-me.txt')
    fs.writeFileSync(source, 'PAYLOAD\n')
    const inode = fs.statSync(source).ino

    const body = envelopeOf(await callTool('batch',
      { action: 'run', operations: [{ op: 'move', path: 'move-me.txt', to: 'moved.txt' }] },
      authority(workspace)), assert)
    assert.equal(body.status, 'completed', JSON.stringify(body))
    assert.equal(body.metadataNotPreserved, 0)
    assert.equal(fs.statSync(path.join(workspace, 'moved.txt')).ino, inode,
      'a same-device move is a rename, so every attribute travels with the inode')
    assert.equal(fs.existsSync(source), false, 'the source is gone')
  })
})

await test('a move refuses an existing destination instead of overwriting it', async () => {
  await withTempDir('audit-move-noreplace', async workspace => {
    fs.writeFileSync(path.join(workspace, 'source.txt'), 'SOURCE\n')
    fs.writeFileSync(path.join(workspace, 'taken.txt'), 'TAKEN\n')

    const body = envelopeOf(await callTool('batch',
      { action: 'run', operations: [{ op: 'move', path: 'source.txt', to: 'taken.txt' }] },
      authority(workspace)), assert)
    assert.equal(body.error?.code, 'REVISION_CONFLICT', JSON.stringify(body))
    assert.equal(fs.readFileSync(path.join(workspace, 'taken.txt'), 'utf8'), 'TAKEN\n', 'the destination is untouched')
    assert.equal(fs.existsSync(path.join(workspace, 'source.txt')), true, 'the source is retained')
  })
})

await test('a plan states how many entries a directory remove would delete', async () => {
  await withTempDir('audit-remove-scale', async workspace => {
    fs.mkdirSync(path.join(workspace, 'tree', 'sub'), { recursive: true })
    for (const name of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(workspace, 'tree', name), 'x\n')
    fs.writeFileSync(path.join(workspace, 'tree', 'sub', 'd.txt'), 'x\n')

    const body = envelopeOf(await callTool('batch',
      { action: 'plan', operations: [{ op: 'remove', path: 'tree' }] },
      authority(workspace)), assert)
    assert.equal(body.status, 'planned', JSON.stringify(body))
    assert.equal(typeof body.entries, 'number', 'the plan states the scale of a recursive remove')
    assert.equal(body.entries, 6, 'tree + sub + four files')
  })
})

await test('POSIX-legal names are usable in batch operations', async () => {
  if (!POSIX) { assert.ok(true, 'reserved names are a Windows concern'); return }
  await withTempDir('audit-posix-names', async workspace => {
    const names = ['con.txt', 'q?.txt', 'trail.']
    for (const name of names) fs.writeFileSync(path.join(workspace, name), 'x\n')

    const body = envelopeOf(await callTool('batch',
      { action: 'run', operations: names.map(name => ({ op: 'copy', path: name, to: 'copy-' + name.replace(/\W/gu, '_') })) },
      authority(workspace)), assert)
    assert.equal(body.status, 'completed', JSON.stringify(body))
    assert.equal(body.done, names.length, 'every POSIX-legal name is copyable')
  })
})

await test('an out-of-range argument names the parameter, its range and the value', async () => {
  await withTempDir('audit-argument-message', async workspace => {
    const target = path.join(workspace, 'args.txt')
    fs.writeFileSync(target, 'x\n')

    const limit = envelopeOf(await callTool('inspect_local_file', { path: target, limit: 10_001 }, { root: workspace }), assert)
    assert.equal(limit.error?.code, 'INVALID_ARGUMENT', JSON.stringify(limit))
    assert.match(limit.error.message, /limit must be in 1\.\.=10000 \(got 10001\)/u)

    const encoding = envelopeOf(await callTool('inspect_local_file', { path: target, encoding: 'latin1' }, { root: workspace }), assert)
    assert.match(encoding.error.message, /encoding must be utf-8 \(got latin1\)/u)

    const count = envelopeOf(await callTool('replace',
      { path: target, pattern: 'x', replacement: 'y', dryRun: true, maxReplacements: 0 },
      authority(workspace)), assert)
    assert.match(count.error.message, /maxReplacements must be in 1\.\.=100000 \(got 0\)/u)
  })
})

await test('ops_result answers with the same status field as the other tools', async () => {
  await withTempDir('audit-result-status', async workspace => {
    const put = envelopeOf(await callTool('result', { action: 'put', items: [{ a: 1 }, { a: 2 }] }, authority(workspace)), assert)
    assert.equal(put.status, 'completed', JSON.stringify(put))
    const page = envelopeOf(await callTool('result', { action: 'page', id: put.id, limit: 5 }, authority(workspace)), assert)
    assert.equal(page.status, 'completed', JSON.stringify(page))
    assert.equal(page.items.length, 2)
  })
})

await test('the credential fence refuses backup spellings of a credential file', async () => {
  await withTempDir('audit-credential-backup', async workspace => {
    for (const name of ['credentials.json.bak', 'service-account-prod.json.bak', '.credentials.yaml.bak', 'id_rsa.bak']) {
      assert.equal(credentialPath(path.join(workspace, name)).denied, true, name + ' must be refused')
    }
    assert.equal(credentialPath(path.join(workspace, 'notes.md')).denied, false, 'an ordinary file stays readable')
    assert.equal(credentialPath(path.join(workspace, 'credentials.json')).denied, true, 'the original spelling still refuses')
  })
})

await test('the reserved audit store is refused without refusing lookalike paths', async () => {
  await withTempDir('audit-store-guard', async workspace => {
    assert.equal(refusesReservedStore(path.join(workspace, '.dsh-ops', 'audit.log')), true)
    assert.equal(refusesReservedStore(path.join(workspace, '.dsh-ops')), true)
    assert.equal(refusesReservedStore(path.join(workspace, 'node_modules', 'dsh-ops', 'package.json')), false,
      'a directory merely named dsh-ops is not the store')
    assert.equal(refusesReservedStore(path.join(workspace, 'notes.md')), false)
  })
})

await test('a runtime provenance mismatch is one diagnostic line with exit code 1', async () => {
  await withTempDir('audit-provenance', async workspace => {
    const root = path.join(workspace, 'pkg')
    const runtime = path.join(root, 'runtime', 'linux-x64')
    fs.mkdirSync(runtime, { recursive: true })
    const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    fs.copyFileSync(path.join(PACKAGE_ROOT, 'package.json'), path.join(root, 'package.json'))
    fs.writeFileSync(path.join(runtime, WORKER_BASENAME), 'not the staged worker')
    fs.writeFileSync(path.join(runtime, 'provenance.json'), JSON.stringify({
      version: manifest.version, target: 'linux-x64', executable: WORKER_BASENAME,
      sha256: '0'.repeat(64), source: 'audit-fixes fixture',
    }))

    const run = spawnSync(process.execPath,
      [path.join(PACKAGE_ROOT, 'bin', 'native-runtime.mjs'), 'check', '--staged', '--root', root],
      { encoding: 'utf8' })
    assert.equal(run.status, 1, 'a mismatched worker is refused: ' + run.stdout + run.stderr)
    const lines = (run.stderr ?? '').split('\n').filter(line => line.trim() !== '')
    assert.equal(lines.length, 1, 'the refusal is one line, not a stack trace: ' + JSON.stringify(lines.slice(0, 3)))
    assert.match(lines[0], /Runtime provenance mismatch: linux-x64/u)
    assert.match(lines[0], /receipt sha256 0{64}/u)
  })
})

report('audit-fixes')
