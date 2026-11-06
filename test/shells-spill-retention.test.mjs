/**
 * Bounded, ownership-checked retention for host subprocess spill files (#720).
 *
 * The pure planner is asserted exactly: the TTL window is strictly older-than
 * (mtime equal to the cutoff is kept, one millisecond older is evicted), the
 * budget evicts oldest-first, and one pass never exceeds its file cap. The
 * filesystem pass is then asserted against real host-shaped directories this
 * suite creates under the platform temp root: ledger ownership, the provider's
 * directory/file names, symlinks, non-0700 directories, paths outside the
 * temp root, pid mismatches, EPERM retention and report-vs-reality counts.
 * The CLI case drives the real `bin/dsh-ops.mjs` against the same fixtures.
 *
 * Only this suite's own fixture directories are created under the temp root and
 * removed in a `finally`; the production code only ever unlinks individual
 * ledger-recorded files and never removes a directory.
 *
 * @module dsh-ops/test/shells-spill-retention
 */

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseDocument } from 'yaml'
import { assert, PACKAGE_ROOT, report, test, TEST_HOME, wait, waitFor } from './lib/harness.mjs'
import { resolveConfig } from '../lib/config.js'
import { resolveModeConfig } from '../lib/presets/config.js'
import { SpillLedger, spillLedgerFile } from '../lib/shells/spill-ledger.js'
import {
  MAX_SPILL_FILES_PER_PASS,
  NODE_SPILL_FILESYSTEM,
  inspectSpills,
  planSpillEviction,
  spillRetentionConfig,
  sweepSpills,
} from '../lib/shells/spill-retention.js'
import { createSpillRetentionRuntime } from '../lib/shells/spill-retention-runtime.js'

const CLI = path.join(PACKAGE_ROOT, 'bin', 'dsh-ops.mjs')
const DAY = 24 * 60 * 60 * 1000
const realTemp = fs.realpathSync.native(os.tmpdir())
let sequence = 0

/** One host-shaped private spill directory under the real temp root. */
function makeSpillDirectory() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-subprocess-')))
}

/**
 * Run a case against one host-shaped directory, then remove this suite's own
 * fixture tree (the production code never does).
 * @param body - the case.
 * @returns the body's result.
 */
async function withSpillDirectory(body) {
  const directory = makeSpillDirectory()
  try { return await body(directory) } finally { fs.rmSync(directory, { recursive: true, force: true }) }
}

/** One unique ledger file for one case. */
function makeLedger() {
  return new SpillLedger(path.join(TEST_HOME, 'ledger-' + randomBytes(6).toString('hex') + '.jsonl'))
}

/**
 * Create a provider-shaped spill file.
 * @param directory - the host spill directory.
 * @param options - age, size and file-name facts.
 * @returns the absolute file path.
 */
function makeSpillFile(directory, { ageMs = 0, bytes = 8, pid = process.pid, label = 'stdout', name } = {}) {
  const file = path.join(directory, name ?? ('dsh-subprocess-' + String(pid) + '-' + String(++sequence) + '-' + randomBytes(6).toString('hex') + '-' + label + '.log'))
  fs.writeFileSync(file, Buffer.alloc(bytes, 120))
  if (ageMs !== 0) {
    const at = new Date(Date.now() - ageMs)
    fs.utimesSync(file, at, at)
  }
  return file
}

/** A config whose window has certainly passed for an aged file. */
const expiredConfig = { retentionDays: 1, totalBudgetMiB: 256, sweepEnabled: true }

const observed = (name, mtimeMs, size = 10) => ({ path: '/tmp/dsh-subprocess-AAAAAA/' + name, size, mtimeMs })

await test('the planner keeps the exact cutoff, evicts older files and honours budget and cap', () => {
  const now = 1_000 * DAY
  const atCutoff = observed('at.log', now - DAY)
  const justOlder = observed('older.log', now - DAY - 1)
  const ttl = planSpillEviction([atCutoff, justOlder], { now, retentionMs: DAY, maxTotalBytes: Number.POSITIVE_INFINITY, maxFilesPerPass: MAX_SPILL_FILES_PER_PASS })
  assert.deepEqual(ttl.expired.map(item => item.path), [justOlder.path], 'exactly at the cutoff is kept')
  assert.deepEqual(ttl.evict.map(item => item.path), [justOlder.path])
  assert.deepEqual(ttl.kept.map(item => item.path), [atCutoff.path])
  // Budget: oldest first until the total fits.
  const files = [
    { path: '/tmp/a', size: 100, mtimeMs: now - 30 },
    { path: '/tmp/b', size: 100, mtimeMs: now - 20 },
    { path: '/tmp/c', size: 100, mtimeMs: now - 10 },
  ]
  const budget = planSpillEviction(files, { now, retentionMs: null, maxTotalBytes: 250, maxFilesPerPass: MAX_SPILL_FILES_PER_PASS })
  assert.deepEqual(budget.evict, [], 'retentionDays: 0 never evicts, even over budget')
  const budgetExpired = planSpillEviction(files, { now, retentionMs: DAY, maxTotalBytes: 250, maxFilesPerPass: MAX_SPILL_FILES_PER_PASS })
  assert.deepEqual(budgetExpired.evict.map(item => item.path), ['/tmp/a'])
  assert.equal(budgetExpired.totalBytes, 300)
  // Pass cap.
  const capped = planSpillEviction(
    [observed('1.log', now - 3 * DAY), observed('2.log', now - 2 * DAY), observed('3.log', now - DAY - 1)],
    { now, retentionMs: DAY, maxTotalBytes: Number.POSITIVE_INFINITY, maxFilesPerPass: 2 },
  )
  assert.equal(capped.evict.length, 2)
  assert.deepEqual(capped.evict.map(item => path.basename(item.path)), ['1.log', '2.log'], 'oldest first')
  assert.equal(capped.expired.length, 3, 'the window is reported even when the pass cap stops the deletions')
})

await test('only ledger-owned host-shaped regular files are deleted; everything else is skipped', async () => {
  await withSpillDirectory(async directory => {
    const ledger = makeLedger()
    const now = Date.now()
    const old = age => makeSpillFile(directory, { ageMs: age })
    const owned = old(2 * DAY)
    const outsideLedger = old(2 * DAY)
    const wrongName = path.join(directory, 'dsh-subprocess-' + process.pid + '-999-' + '0'.repeat(12) + '-stdout.log.tmp')
    fs.writeFileSync(wrongName, 'x')
    const pidMismatch = makeSpillFile(directory, { ageMs: 2 * DAY, pid: process.pid + 1 })
    const missing = path.join(directory, 'dsh-subprocess-' + process.pid + '-998-' + '1'.repeat(12) + '-stderr.log')
    const remote = path.join(TEST_HOME, 'other-provider-' + randomBytes(4).toString('hex') + '.log')
    fs.mkdirSync(path.dirname(remote), { recursive: true })
    fs.writeFileSync(remote, 'remote')
    for (const file of [owned, wrongName, pidMismatch, missing, remote]) ledger.record({ path: file, bytes: 1 })
    const result = sweepSpills({ config: expiredConfig, ledger, now })
    assert.deepEqual(result.deleted, [owned], 'exactly the owned, provider-shaped file')
    assert.equal(fs.existsSync(owned), false)
    assert.equal(fs.existsSync(outsideLedger), true, 'a file no settlement recorded is never deleted')
    assert.equal(fs.existsSync(wrongName), true, 'a name outside the provider shape is never deleted')
    assert.equal(fs.existsSync(pidMismatch), true, 'a pid mismatch is never deleted')
    assert.equal(fs.existsSync(remote), true, 'a non-local path is only reported')
    assert.equal(fs.existsSync(directory), true, 'the spill directory is never removed')
    assert.equal(result.missing, 1)
    const reasons = new Map(result.unknown.map(item => [path.basename(item.path), item.reason]))
    assert.equal(reasons.get(path.basename(wrongName)), 'unexpected-file-name')
    assert.equal(reasons.get(path.basename(pidMismatch)), 'pid-mismatch')
    assert.equal(reasons.get(path.basename(remote)), 'unexpected-directory')
    // The missing entry is forgotten; the skipped entries stay for a later look.
    const remaining = new SpillLedger(ledger.file).entries().map(item => item.path)
    assert.deepEqual(remaining.sort(), [wrongName, pidMismatch, remote].sort())
    assert.equal(result.remainingFiles, 0)
  })
})

if (process.platform !== 'win32') {
  await test('POSIX ownership checks skip symlinks and non-0700 directories', async () => {
    await withSpillDirectory(async directory => {
      const ledger = makeLedger()
      const target = path.join(TEST_HOME, 'symlink-target-' + randomBytes(4).toString('hex'))
      fs.writeFileSync(target, 'target')
      const link = path.join(directory, 'dsh-subprocess-' + process.pid + '-997-' + '2'.repeat(12) + '-stdout.log')
      fs.symlinkSync(target, link)
      // A directory that carries the right name but grants group/other access.
      const loose = path.join(os.tmpdir(), 'dsh-subprocess-' + randomBytes(3).toString('hex'))
      fs.mkdirSync(loose, { mode: 0o755 })
      let looseFile
      try {
        fs.chmodSync(loose, 0o755)
        looseFile = path.join(loose, 'dsh-subprocess-' + process.pid + '-996-' + '3'.repeat(12) + '-stdout.log')
        fs.writeFileSync(looseFile, 'loose')
        ledger.record({ path: link, bytes: 1 })
        ledger.record({ path: looseFile, bytes: 1 })
        const result = sweepSpills({ config: expiredConfig, ledger, now: Date.now() })
        assert.deepEqual(result.deleted, [])
        assert.equal(fs.existsSync(link), true)
        assert.equal(fs.existsSync(target), true, 'the symlink target is untouched')
        assert.equal(fs.existsSync(looseFile), true)
        const reasons = new Map(result.unknown.map(item => [path.basename(item.path), item.reason]))
        assert.equal(reasons.get(path.basename(link)), 'not-a-regular-file')
        assert.equal(reasons.get(path.basename(looseFile)), 'directory-mode')
      } finally { fs.rmSync(loose, { recursive: true, force: true }) }
    })
  })
} else {
  console.log('  fixture unavailable: POSIX ownership and mode checks do not apply on this host')
}

await test('a directory outside the real temp root is skipped even with a provider-shaped name', async () => {
  const directory = fs.mkdtempSync(path.join(TEST_HOME, 'dsh-subprocess-'))
  const file = makeSpillFile(directory, { ageMs: 2 * DAY })
  const ledger = makeLedger()
  ledger.record({ path: file, bytes: 1 })
  const result = sweepSpills({ config: expiredConfig, ledger, now: Date.now() })
  assert.deepEqual(result.deleted, [])
  assert.equal(fs.existsSync(file), true)
  assert.equal(result.unknown.length, 1)
  assert.equal(result.unknown[0].reason, 'outside-temporary-root')
})

await test('the TTL boundary is enforced on real mtimes (cutoff kept, 1 ms older deleted)', async () => {
  await withSpillDirectory(async directory => {
    const ledger = makeLedger()
    const exact = makeSpillFile(directory, { bytes: 4 })
    const early = makeSpillFile(directory, { bytes: 5 })
    fs.utimesSync(exact, new Date(Date.now() - DAY), new Date(Date.now() - DAY))
    // Read the mtime the filesystem actually stored, so the case is exact on
    // every platform instead of assuming the timestamp round-tripped verbatim.
    const cutoff = fs.statSync(exact).mtimeMs
    fs.utimesSync(early, new Date(cutoff - 1), new Date(cutoff - 1))
    for (const file of [exact, early]) ledger.record({ path: file, bytes: 1 })
    const result = sweepSpills({ config: expiredConfig, ledger, now: cutoff + DAY })
    assert.deepEqual(result.deleted, [early], 'only the file strictly older than the cutoff is evicted')
    assert.equal(fs.existsSync(exact), true)
    const after = sweepSpills({ config: expiredConfig, ledger, now: cutoff + DAY + 2 })
    assert.deepEqual(after.deleted, [exact], 'a file exactly at a past cutoff is evicted by the next pass')
  })
})

await test('the byte budget evicts the oldest retained files first', async () => {
  await withSpillDirectory(async directory => {
    const ledger = makeLedger()
    const now = Date.now()
    const oldest = makeSpillFile(directory, { bytes: 600 * 1024, ageMs: 3 * 1000 })
    const newest = makeSpillFile(directory, { bytes: 600 * 1024, ageMs: 1 * 1000 })
    for (const file of [oldest, newest]) ledger.record({ path: file, bytes: 600 * 1024 })
    const result = sweepSpills({ config: { retentionDays: 30, totalBudgetMiB: 1, sweepEnabled: true }, ledger, now })
    assert.deepEqual(result.deleted, [oldest], '600 KiB + 600 KiB exceeds a 1 MiB budget; the older file goes')
    assert.equal(fs.existsSync(newest), true)
    assert.equal(result.expiredFiles, 0, 'neither file is past the window; this is a budget eviction')
  })
})

await test('one pass is capped and the next pass finishes the window', async () => {
  await withSpillDirectory(async directory => {
    const ledger = makeLedger()
    const now = Date.now()
    const files = [4, 3, 2].map(age => makeSpillFile(directory, { ageMs: age * DAY, bytes: 3 }))
    for (const file of files) ledger.record({ path: file, bytes: 3 })
    const first = sweepSpills({ config: expiredConfig, ledger, now, maxFilesPerPass: 2 })
    assert.equal(first.deleted.length, 2)
    assert.equal(first.expiredFiles, 3)
    assert.equal(files.filter(file => fs.existsSync(file)).length, 1)
    const second = sweepSpills({ config: expiredConfig, ledger, now })
    assert.equal(second.deleted.length, 1)
    assert.equal(files.filter(file => fs.existsSync(file)).length, 0)
  })
})

for (const code of ['EPERM', 'EACCES']) {
  await test('a ' + code + ' unlink keeps the ledger entry with lastError and the next pass retries it', async () => {
    await withSpillDirectory(async directory => {
      const ledger = makeLedger()
      const now = Date.now()
      const file = makeSpillFile(directory, { ageMs: 2 * DAY })
      ledger.record({ path: file, bytes: 1 })
      const failing = {
        ...NODE_SPILL_FILESYSTEM,
        unlink: target => {
          if (target === file) throw Object.assign(new Error(code + ': operation not permitted, unlink ' + target), { code })
          return NODE_SPILL_FILESYSTEM.unlink(target)
        },
      }
      const blocked = sweepSpills({ config: expiredConfig, ledger, now, fs: failing })
      assert.deepEqual(blocked.deleted, [])
      assert.equal(blocked.failures.length, 1)
      assert.match(blocked.failures[0].error, new RegExp(code))
      assert.equal(fs.existsSync(file), true)
      const retained = new SpillLedger(ledger.file).entries()
      assert.equal(retained.length, 1, 'the failed entry is retained')
      assert.match(retained[0].lastError, new RegExp(code))
      const retried = sweepSpills({ config: expiredConfig, ledger, now })
      assert.deepEqual(retried.deleted, [file], 'the next pass retries and now succeeds')
      assert.deepEqual(retried.failures, [])
      assert.equal(fs.existsSync(file), false)
    })
  })
}

await test('reported counts match the files on disk before and after a sweep', async () => {
  await withSpillDirectory(async directory => {
    const ledger = makeLedger()
    const now = Date.now()
    const expired = [makeSpillFile(directory, { ageMs: 2 * DAY, bytes: 100 }), makeSpillFile(directory, { ageMs: 3 * DAY, bytes: 200 })]
    const fresh = makeSpillFile(directory, { bytes: 300 })
    for (const file of [...expired, fresh]) ledger.record({ path: file, bytes: 1 })
    const remote = path.join(TEST_HOME, 'remote-' + randomBytes(4).toString('hex') + '.log')
    fs.writeFileSync(remote, 'remote')
    ledger.record({ path: remote, bytes: 1 })
    const before = inspectSpills({ config: expiredConfig, ledger, now })
    assert.equal(before.existingFiles, 3, 'the three host-shaped files are observed')
    assert.equal(before.existingBytes, 600)
    assert.equal(before.expiredFiles, 2)
    assert.equal(before.expiredBytes, 300)
    assert.equal(before.unknown.length, 1)
    assert.equal(before.planned, 2)
    const swept = sweepSpills({ config: expiredConfig, ledger, now })
    assert.equal(swept.deleted.length, before.planned)
    assert.equal(swept.remainingFiles, 1)
    assert.equal(swept.remainingBytes, 300)
    assert.equal(fs.readdirSync(directory).length, 1, 'the numbers agree with the directory')
    const after = inspectSpills({ config: expiredConfig, ledger, now })
    assert.equal(after.existingFiles, 1)
    assert.equal(after.existingBytes, 300)
    assert.equal(after.ledger.entries, 2, 'the fresh file and the untouched remote entry remain')
  })
})

await test('activation, interval and settlement triggers each run a bounded pass', async () => {
  await withSpillDirectory(async directory => {
    const ledger = makeLedger()
    const future = Date.now() + 2 * DAY
    const active = makeSpillFile(directory, { ageMs: 2 * DAY })
    ledger.record({ path: active, bytes: 1 })
    const runtime = createSpillRetentionRuntime(expiredConfig, { ledger, now: () => future, intervalMs: 60 * 60 * 1000 })
    try {
      await waitFor(() => !fs.existsSync(active), { what: 'the activation pass' })
    } finally { runtime.dispose() }
    // Every N settlements schedules one pass; the activation pass already ran.
    const settledLedger = makeLedger()
    const bySettlements = createSpillRetentionRuntime(expiredConfig, { ledger: settledLedger, now: () => future, settlementsPerSweep: 2, intervalMs: 60 * 60 * 1000 })
    try {
      await wait(50) // let the activation pass see the empty ledger settle
      const second = makeSpillFile(directory, { ageMs: 2 * DAY })
      settledLedger.record({ path: second, bytes: 1 })
      bySettlements.noteSettled()
      await wait(50)
      assert.equal(fs.existsSync(second), true, 'one settlement is below the threshold')
      bySettlements.noteSettled()
      await waitFor(() => !fs.existsSync(second), { what: 'the settlement-triggered pass' })
    } finally { bySettlements.dispose() }
    // The unref'ed interval is the only remaining trigger; the 1000 ms floor keeps it cheap.
    const third = makeSpillFile(directory, { ageMs: 2 * DAY })
    const intervalLedger = makeLedger()
    const byInterval = createSpillRetentionRuntime(expiredConfig, { ledger: intervalLedger, now: () => future, intervalMs: 1000, settlementsPerSweep: 1000 })
    try {
      await wait(50)
      intervalLedger.record({ path: third, bytes: 1 })
      await waitFor(() => !fs.existsSync(third), { timeoutMs: 5000, what: 'the interval pass' })
    } finally { byInterval.dispose() }
  })
})

await test('the documented config keys, defaults and bundle patch agree', () => {
  const defaults = resolveConfig({})
  assert.equal(defaults.spillRetentionDays, 30)
  assert.equal(defaults.spillTotalBudgetMiB, 256)
  assert.equal(defaults.spillSweepEnabled, true)
  assert.deepEqual(spillRetentionConfig(defaults), { retentionDays: 30, totalBudgetMiB: 256, sweepEnabled: true })
  const patch = parseDocument(fs.readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')).toJS()
  const config = patch[0].insert[0].config
  for (const mode of ['minimal', 'standard', 'ptc', 'cordis']) {
    const { enabled, ...rest } = config[mode]
    assert.equal(enabled, true)
    const resolved = resolveModeConfig(rest)
    assert.equal(resolved.spillRetentionDays, defaults.spillRetentionDays, mode)
    assert.equal(resolved.spillTotalBudgetMiB, defaults.spillTotalBudgetMiB, mode)
    assert.equal(resolved.spillSweepEnabled, defaults.spillSweepEnabled, mode)
  }
  for (const [raw, key] of [
    [{ spillRetentionDays: -1 }, 'spillRetentionDays'],
    [{ spillRetentionDays: 1.5 }, 'spillRetentionDays'],
    [{ spillRetentionDays: '30' }, 'spillRetentionDays'],
    [{ spillTotalBudgetMiB: -1 }, 'spillTotalBudgetMiB'],
    [{ spillTotalBudgetMiB: Number.MAX_SAFE_INTEGER }, 'spillTotalBudgetMiB'],
    [{ spillSweepEnabled: 'yes' }, 'spillSweepEnabled'],
  ]) {
    assert.throws(() => resolveConfig(raw), error => String(error.message).includes(key), JSON.stringify(raw))
  }
  assert.equal(resolveConfig({ spillRetentionDays: 0 }).spillRetentionDays, 0, '0 is the documented report-only value')
})

await test('bash-runtime spill-report reports, previews and then deletes only owned files', async () => {
  const directory = makeSpillDirectory()
  try {
    const ledger = new SpillLedger(spillLedgerFile())
    const now = Date.now()
    // The CLI applies the code defaults: a 30-day window, so this fixture is older.
    const expired = makeSpillFile(directory, { ageMs: 31 * DAY, bytes: 40 })
    const fresh = makeSpillFile(directory, { bytes: 50 })
    for (const file of [expired, fresh]) ledger.record({ path: file, bytes: 1 })
    const run = args => spawnSync(process.execPath, [CLI, 'bash-runtime', 'spill-report', ...args], {
      cwd: PACKAGE_ROOT, encoding: 'utf8', env: { ...process.env, DSH_HOME: TEST_HOME }, timeout: 60_000,
    })
    const reported = run(['--json'])
    assert.equal(reported.status, 0, reported.stderr)
    const value = JSON.parse(reported.stdout)
    assert.equal(value.ledger.entries, 2)
    assert.equal(value.existingFiles, 2)
    assert.equal(value.expiredFiles, 1)
    assert.equal(value.planned, 1)
    const preview = run(['--sweep'])
    assert.equal(preview.status, 0, preview.stderr)
    assert.match(preview.stdout, /would be deleted/)
    assert.equal(fs.existsSync(expired), true, 'a preview never deletes')
    assert.equal(fs.existsSync(fresh), true)
    const applied = run(['--sweep', '--yes'])
    assert.equal(applied.status, 0, applied.stderr)
    assert.match(applied.stdout, /deleted:\s+1 file/)
    assert.equal(fs.existsSync(expired), false)
    assert.equal(fs.existsSync(fresh), true)
    assert.equal(new SpillLedger(spillLedgerFile()).entries().length, 1)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

report('shells-spill-retention')
