import fs from 'node:fs'
import path from 'node:path'
import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { SpillLedger } from '../lib/shells/spill-ledger.js'
import { inspectSpills, sweepSpills } from '../lib/shells/spill-retention.js'

const token = '1234567890abcdef1234567890abcdef'
const nativeDir = (root, pid = process.pid) => path.join(root, `dsh-ops-native-${pid}-${token}`)
const nativeFile = (root, pid = process.pid) => path.join(nativeDir(root, pid), `stdout-${token}.log`)
const future = () => Date.now() + 40 * 86400000

await test('native origin survives ledger reload and uses the existing bounded retention pass', async () => {
  await withTempDir('native-spill', async directory => {
    const root = fs.realpathSync(directory), file = nativeFile(root)
    fs.mkdirSync(path.dirname(file), { mode: 0o700 }); fs.writeFileSync(file, 'complete stream', { mode: 0o600 })
    const ledgerPath = path.join(root, 'ledger.jsonl'), ledger = new SpillLedger(ledgerPath)
    ledger.record({ origin: 'ops-native-v1', path: file, pid: process.pid, bytes: 15, sessionId: 'native' })
    const loaded = new SpillLedger(ledgerPath)
    assert.equal(loaded.entries()[0].origin, 'ops-native-v1')
    const observed = inspectSpills({ ledger: loaded, tmpdir: root })
    assert.equal(observed.existingFiles, 1); assert.deepEqual(observed.unknown, [])
    const result = sweepSpills({ ledger: loaded, tmpdir: root, now: future() })
    assert.deepEqual(result.deleted, [file]); assert.equal(fs.existsSync(file), false)
    assert.equal(fs.existsSync(path.dirname(file)), true, 'the shared pass still removes files only')
  })
})

await test('recording native origin requires its kernel PID and complete-file byte bound', async () => {
  await withTempDir('native-spill-reject', async root => {
    const ledger = new SpillLedger(path.join(root, 'ledger.jsonl')), file = nativeFile(root)
    for (const input of [
      { origin: 'other', pid: process.pid, bytes: 1 },
      { origin: 'ops-native-v1', pid: process.pid + 1, bytes: 1 },
      { origin: 'ops-native-v1', bytes: 1 },
      { origin: 'ops-native-v1', pid: process.pid, bytes: 64 * 1024 * 1024 + 1 },
      { origin: 'ops-native-v1', pid: process.pid, bytes: 1.5 },
    ]) ledger.record({ path: file, ...input })
    assert.deepEqual(ledger.entries(), [])
    ledger.record({ path: file, pid: process.pid, bytes: 1 })
    assert.equal(ledger.entries().length, 1, 'legacy records keep their original schema')
    assert.equal(ledger.entries()[0].origin, undefined)
    const observed = inspectSpills({ ledger, tmpdir: root })
    assert.equal(observed.existingFiles, 0, 'native names cannot masquerade as the host provider')
  })
})

await test('native retention refuses a junction ancestor without touching its target', async () => {
  await withTempDir('native-spill-link', async directory => {
    const root = fs.realpathSync(directory), target = path.join(root, 'target')
    fs.mkdirSync(target, { mode: 0o700 })
    const targetFile = path.join(target, `stdout-${token}.log`); fs.writeFileSync(targetFile, 'untouched')
    fs.symlinkSync(target, nativeDir(root), process.platform === 'win32' ? 'junction' : 'dir')
    const ledger = new SpillLedger(path.join(root, 'ledger.jsonl'))
    ledger.record({ origin: 'ops-native-v1', path: nativeFile(root), pid: process.pid, bytes: 9 })
    const result = sweepSpills({ ledger, tmpdir: root, now: future() })
    assert.deepEqual(result.deleted, []); assert.equal(result.unknown[0].reason, 'symlinked-directory')
    assert.equal(fs.readFileSync(targetFile, 'utf8'), 'untouched')
  })
})

await test('untrusted ledger lines cannot select a new origin or a mismatched native PID', async () => {
  await withTempDir('native-spill-load', async root => {
    const file = path.join(root, 'ledger.jsonl'), entry = { path: nativeFile(root), bytes: 1, pid: process.pid, recordedAt: Date.now() }
    fs.writeFileSync(file, [
      { ...entry, origin: 'ops-native-v2' },
      { ...entry, origin: 'ops-native-v1', pid: process.pid + 1 },
      { ...entry, origin: 'ops-native-v1' },
    ].map(value => JSON.stringify(value)).join('\n'))
    assert.deepEqual(new SpillLedger(file).entries(), [{ ...entry, origin: 'ops-native-v1' }])
  })
})
report('shells-native-spill')
