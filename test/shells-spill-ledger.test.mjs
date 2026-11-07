/**
 * The settled-spill ledger and the real host behaviour it records (#720).
 *
 * The boundary cases drive the actual `@deepseek-ai/dsh-subprocess-local`
 * provider through the plugin's own executor: exactly 64,000 bytes must stay
 * in memory, 64,001 bytes must create a host spill file, and a stream above the
 * provider's 64 MiB cap must leave no file and no ledger entry at all. The
 * ledger is then read back from `$DSH_HOME/ops-spill-ledger.jsonl`, and the
 * recorded file is proven to survive settlement (the old behaviour) before a
 * retention pass far in the future removes it.
 *
 * Everything else here is isolated to `TEST_HOME` files that the suite writes
 * itself; no host spill directory is created directly for these cases.
 *
 * @module dsh-ops/test/shells-spill-ledger
 */

import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import fs from 'node:fs'
import path from 'node:path'
import { assert, report, test, TEST_HOME, withTempDir } from './lib/harness.mjs'
import { bashToolDefinition } from '../lib/shells/tool.js'
import {
  MAX_SPILL_LEDGER_ENTRIES,
  SpillLedger,
  getSpillLedger,
  recordSettledSpill,
  spillLedgerFile,
} from '../lib/shells/spill-ledger.js'
import { DEFAULT_SPILL_RETENTION, inspectSpills, sweepSpills } from '../lib/shells/spill-retention.js'

/** The host provider needs a Cordis context; nothing else is mounted. */
async function bootSubprocess() {
  const ctx = new Context()
  ctx.logger.level = 0
  await ctx.plugin(Subprocess)
  return { ctx, subprocess: ctx.get('subprocess') }
}

/**
 * Read the ledger file as raw records.
 * @param file - the ledger path.
 * @returns every parsed non-empty line.
 */
function readLedger(file = spillLedgerFile()) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return [] }
  return text.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
}

/**
 * Write an emitter script that prints exactly `bytes` bytes.
 * @param dir - fixture directory.
 * @param name - file name.
 * @param source - script body.
 * @returns the absolute script path.
 */
function emitter(dir, name, source) {
  const file = path.join(dir, name)
  fs.writeFileSync(file, source)
  return file
}

/** A stream that prints exactly this many bytes, nothing else. */
const exactBytes = bytes => 'process.stdout.write(Buffer.alloc(' + String(bytes) + ', 120))\n'

/** A stream above the provider's 64 MiB spill cap; the provider must discard its file. */
const OVERSIZED_SOURCE = [
  'const chunk = Buffer.alloc(1 << 20, 120)',
  'for (let index = 0; index < 65; index++) {',
  '  if (!process.stdout.write(chunk)) await new Promise(resolve => process.stdout.once("drain", resolve))',
  '}',
  '',
].join('\n')

/** The spill directory of this process, discovered from the boundary case. */
let spillDirectory
/** The one recorded spill file this suite created under the host's temp root. */
let recordedSpill

await test('exactly 64,000 bytes stays in memory; 64,001 bytes creates a host spill the ledger records', async () => {
  const { ctx, subprocess } = await bootSubprocess()
  try {
    assert.ok(subprocess, 'the host subprocess service must be available')
    await withTempDir('spill-ledger-boundary', async dir => {
      const definition = bashToolDefinition({ file: process.execPath, source: 'config', subprocess })
      const run = script => definition.execute({ script_path: script, workdir: dir, timeoutMs: 60_000 })
      const atCap = await run(emitter(dir, 'emit-64000.mjs', exactBytes(64_000)))
      assert.equal(atCap.exitCode, 0)
      assert.equal(atCap.stdout.truncated, false)
      assert.equal(atCap.stdout.spillPath, undefined, 'exactly 64,000 bytes must not overflow')
      assert.equal(readLedger().length, 0, 'no spill file means no ledger entry')
      const overCap = await run(emitter(dir, 'emit-64001.mjs', exactBytes(64_001)))
      assert.equal(overCap.exitCode, 0)
      assert.equal(overCap.stdout.truncated, true)
      recordedSpill = overCap.stdout.spillPath
      assert.equal(typeof recordedSpill, 'string', JSON.stringify(overCap.stdout))
      spillDirectory = path.dirname(recordedSpill)
      assert.equal(fs.statSync(recordedSpill).size, 64_001, 'the spill file holds the complete stream')
      const entries = readLedger()
      const entry = entries.find(candidate => candidate.path === recordedSpill)
      assert.ok(entry, 'the settled spill path is recorded exactly once')
      assert.equal(entries.filter(candidate => candidate.path === recordedSpill).length, 1)
      assert.equal(entry.bytes, 64_001)
      assert.equal(entry.pid, process.pid)
      assert.equal(typeof entry.recordedAt, 'number')
      assert.equal(fs.existsSync(recordedSpill), true, 'settlement only records; the file still exists')
    })
  } finally { await ctx.fiber.dispose() }
})

await test('a stream above the 64 MiB cap leaves no spill file and no ledger entry', async () => {
  if (recordedSpill === undefined) {
    console.log('  fixture unavailable: the boundary case produced no spill path to locate the host directory')
    return
  }
  const before = new Set(fs.readdirSync(spillDirectory))
  const ledgerBefore = readLedger().length
  const { ctx, subprocess } = await bootSubprocess()
  try {
    await withTempDir('spill-ledger-oversized', async dir => {
      const definition = bashToolDefinition({ file: process.execPath, source: 'config', subprocess })
      const value = await definition.execute({ script_path: emitter(dir, 'emit-oversized.mjs', OVERSIZED_SOURCE), workdir: dir, timeoutMs: 120_000 })
      assert.equal(value.exitCode, 0, JSON.stringify(value.stderr))
      assert.equal(value.stdout.truncated, true)
      assert.equal(value.stdout.spillPath, undefined, 'the provider discards its spill above the 64 MiB cap')
      // A discarded spill is unlinked by the provider; the process must not have
      // left a second file behind in the private directory.
      const after = fs.readdirSync(spillDirectory).filter(name => !before.has(name))
      assert.deepEqual(after, [], 'no residue from the discarded spill')
      assert.equal(readLedger().length, ledgerBefore, 'a discarded spill path is not recorded')
    })
  } finally { await ctx.fiber.dispose() }
})

await test('a recorded spill survives settlement and is evicted only after its window', async () => {
  if (recordedSpill === undefined) {
    console.log('  fixture unavailable: the boundary case produced no spill path')
    return
  }
  const ledger = new SpillLedger(spillLedgerFile())
  const entry = ledger.entries().find(candidate => candidate.path === recordedSpill)
  assert.ok(entry, 'the ledger file reloads the recorded entry')
  assert.equal(fs.existsSync(recordedSpill), true)
  const fresh = inspectSpills({ ledger })
  assert.equal(fresh.existingFiles, 1, 'the one settled spill is the only eligible file')
  assert.equal(fresh.expiredFiles, 0, 'a just-written spill is inside the default window')
  assert.deepEqual(fresh.unknown, [])
  const future = Date.now() + (DEFAULT_SPILL_RETENTION.retentionDays + 1) * 24 * 60 * 60 * 1000
  const swept = sweepSpills({ ledger, now: future })
  assert.deepEqual(swept.deleted, [recordedSpill])
  assert.equal(fs.existsSync(recordedSpill), false, 'the expired file is gone')
  assert.equal(fs.existsSync(spillDirectory), true, 'the host spill directory itself is never removed')
  assert.equal(new SpillLedger(spillLedgerFile()).entries().length, 0, 'the deleted entry leaves the ledger')
})

await test('the ledger deduplicates paths, caps entries and ignores malformed lines', async () => {
  const file = path.join(TEST_HOME, 'ledger-normalise-' + String(process.pid) + '.jsonl')
  const entry = (name, bytes, recordedAt) => JSON.stringify({ path: path.join(TEST_HOME, name), bytes, pid: process.pid, recordedAt })
  fs.writeFileSync(file, [
    entry('a.log', 1, 100),
    'not json',
    entry('a.log', 2, 200),
    JSON.stringify({ path: 'relative.log', bytes: 1, pid: 1, recordedAt: 1 }),
    JSON.stringify({ path: path.join(TEST_HOME, 'b.log'), bytes: -1, pid: 1, recordedAt: 1 }),
    entry('b.log', 3, 300),
    '',
  ].join('\n'))
  const ledger = new SpillLedger(file)
  const loaded = ledger.entries()
  assert.deepEqual(loaded.map(candidate => path.basename(candidate.path)), ['a.log', 'b.log'])
  assert.deepEqual(loaded.map(candidate => candidate.bytes), [2, 3], 'the last record for one path wins')
  // Loading rewrote the file without the malformed and duplicate lines.
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2)
  const small = new SpillLedger(path.join(TEST_HOME, 'ledger-cap-' + String(process.pid) + '.jsonl'), { maxEntries: 2, now: () => 1000 })
  for (const name of ['c', 'd', 'e']) small.record({ path: path.join(TEST_HOME, name + '.log'), bytes: 1 })
  assert.deepEqual(small.entries().map(candidate => path.basename(candidate.path)), ['d.log', 'e.log'])
  assert.equal(MAX_SPILL_LEDGER_ENTRIES, 4096)
})

await test('an unwritable ledger degrades to memory and reports once without failing the record', async () => {
  const messages = []
  const blocker = path.join(TEST_HOME, 'ledger-blocker-' + String(process.pid))
  fs.writeFileSync(blocker, 'not a directory')
  const ledger = new SpillLedger(path.join(blocker, 'ledger.jsonl'), { report: message => messages.push(message) })
  ledger.record({ path: path.join(TEST_HOME, 'm1.log'), bytes: 1 })
  ledger.record({ path: path.join(TEST_HOME, 'm2.log'), bytes: 2 })
  assert.equal(ledger.entries().length, 2, 'both records stay in the memory ledger')
  assert.equal(typeof ledger.degraded(), 'string')
  assert.equal(messages.length, 1, 'the degradation is reported once, not per record')
  assert.match(messages[0], /spill ledger cannot be written/)
  // The same degradation is visible through the report seam.
  const reportValue = inspectSpills({ ledger })
  assert.equal(reportValue.ledger.entries, 2)
  assert.equal(reportValue.ledger.degraded, ledger.degraded())
})

if (process.platform !== 'win32') {
  await test('the ledger file is created private (0600)', () => {
    const file = path.join(TEST_HOME, 'ledger-mode-' + String(process.pid) + '.jsonl')
    const ledger = new SpillLedger(file)
    ledger.record({ path: path.join(TEST_HOME, 'mode.log'), bytes: 1 })
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  })
} else {
  console.log('  fixture unavailable: POSIX file modes are not meaningful on this host')
}

await test('the settlement recorder stores absolute paths and ignores relative ones', () => {
  assert.equal(recordSettledSpill({ path: 'relative.log', bytes: 1 }), true)
  assert.equal(getSpillLedger().entries().some(candidate => candidate.path === 'relative.log'), false)
  assert.equal(recordSettledSpill({ path: '', bytes: 1 }), true)
  assert.equal(recordSettledSpill({ path: path.join(TEST_HOME, 'not-a-spill.log'), bytes: 1 }), true)
  assert.equal(getSpillLedger().entries().some(candidate => candidate.path.endsWith('not-a-spill.log')), true)
})

report('shells-spill-ledger')
