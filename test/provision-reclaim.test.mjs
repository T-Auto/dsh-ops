/**
 * Kept provision downloads and Niubash staging siblings: the durable record, the
 * budget that reclaims it, and the three sibling decisions (reuse, restore,
 * remove) plus the "kept when it does not verify" case.
 *
 * No real 101 MiB download and no real 108 MiB payload: the directory is the
 * record's own, and the verifier is injected — the decision is what is asserted.
 */
import fs from 'node:fs'
import path from 'node:path'
import { assert, report, test, withTempDir } from './lib/harness.mjs'
import {
  PENDING_KEEP_AGE_MS, pendingRoot, planPendingSweep, recordPendingScratch, sweepPendingScratch,
} from '../lib/cli/pending-scratch.js'
import { reclaimNiubashSiblings } from '../lib/cli/niubash-payload.js'
import { shellReceiptText } from '../lib/cli/provision-shells.js'

/** A 64-character hex digest that differs per index. */
const digest = (index) => index.toString(16).padStart(2, '0').repeat(32)

/** One registered scratch directory with a known size. */
function seedScratch(scratchRoot, home, { name, bytes, at, kind = 'pwsh', pinIndex = 1, now }) {
  const directory = path.join(scratchRoot, name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'payload.bin'), Buffer.alloc(bytes))
  recordPendingScratch({
    root: pendingRoot(home), kind, pinSha256: digest(pinIndex), scratch: directory,
    reason: 'the downloaded archive did not match the pinned sha256', now: () => at,
  })
  return directory
}


await test('the receipt one provisioned version carries is exactly one JSON document', async () => {
  const text = shellReceiptText({
    name: 'pwsh', platform: 'win32', arch: 'x64', version: '0.0.1', assetFile: 'a.zip',
    url: 'https://example.invalid/a.zip', sha256: 'a'.repeat(64), bytes: 1,
    extractor: 'zip', extractTo: 'bin', executableRelativePath: 'bin/pwsh.exe',
  })
  assert.ok(text.endsWith('\n'), 'the receipt ends with one newline')
  const receipt = JSON.parse(text)
  assert.equal(receipt.sha256, 'a'.repeat(64))
  assert.equal(receipt.version, '0.0.1')
  assert.equal(receipt.executable, 'bin/pwsh.exe')
  assert.equal(receipt.schemaVersion, 1)
})

await test('a sweep reclaims only the registered directories outside the count budget', async () => {
  await withTempDir('pending-budget', (root) => {
    const home = path.join(root, 'home'), scratchRoot = path.join(root, 'tmp')
    fs.mkdirSync(scratchRoot, { recursive: true })
    const now = Date.parse('2026-01-10T00:00:00.000Z')
    const oldest = seedScratch(scratchRoot, home, { name: 'dsh-ops-pwsh-aaa', bytes: 10, at: now - 3000, pinIndex: 1 })
    const middle = seedScratch(scratchRoot, home, { name: 'dsh-ops-pwsh-bbb', bytes: 20, at: now - 2000, pinIndex: 2 })
    const newest = seedScratch(scratchRoot, home, { name: 'dsh-ops-pwsh-ccc', bytes: 30, at: now - 1000, pinIndex: 3 })

    const plan = planPendingSweep({ home, tmpRoot: scratchRoot, keepCount: 1, now: () => now })
    assert.deepEqual(plan.items.filter((item) => item.decision === 'reclaimable').map((item) => item.scratch).sort(),
      [oldest, middle].sort())
    assert.equal(plan.items.find((item) => item.scratch === newest).decision, 'kept')

    const swept = sweepPendingScratch({ home, tmpRoot: scratchRoot, keepCount: 1, now: () => now, log: () => {} })
    assert.deepEqual(swept.removed.sort(), [oldest, middle].sort())
    assert.deepEqual(swept.kept, [newest])
    assert.equal(swept.bytes, 30, 'the report names the bytes it freed')
    assert.equal(fs.existsSync(oldest), false)
    assert.equal(fs.existsSync(middle), false)
    assert.equal(fs.existsSync(newest), true)
    // A reclaimed directory loses its record; the kept one keeps its record.
    const records = fs.readdirSync(pendingRoot(home))
    assert.equal(records.length, 1, 'only the kept download still has a record: ' + records.join(','))
  })
})

await test('the byte and age budgets reclaim a download that would otherwise be kept', async () => {
  await withTempDir('pending-budgets', (root) => {
    const home = path.join(root, 'home'), scratchRoot = path.join(root, 'tmp')
    fs.mkdirSync(scratchRoot, { recursive: true })
    const now = Date.parse('2026-01-10T00:00:00.000Z')
    const big = seedScratch(scratchRoot, home, { name: 'dsh-ops-pwsh-big', bytes: 40, at: now - 1000, pinIndex: 4 })
    assert.equal(planPendingSweep({ home, tmpRoot: scratchRoot, keepCount: 4, keepBytes: 20, now: () => now })
      .items[0].decision, 'reclaimable')
    assert.equal(fs.existsSync(big), true, 'a plan removes nothing')

    const aged = Date.parse('2026-01-01T00:00:00.000Z')
    const stale = seedScratch(scratchRoot, home, { name: 'dsh-ops-bash-old', bytes: 5, at: aged, kind: 'bash', pinIndex: 5 })
    const plan = planPendingSweep({ home, tmpRoot: scratchRoot, now: () => now })
    const staleItem = plan.items.find((item) => item.scratch === stale)
    assert.equal(staleItem.decision, 'reclaimable', 'older than the age budget')
    assert.match(staleItem.detail ?? '', /age budget/u)
    assert.ok(now - aged > PENDING_KEEP_AGE_MS)
  })
})

await test('a record that does not own its directory is never reclaimed', async () => {
  await withTempDir('pending-unverified', (root) => {
    const home = path.join(root, 'home'), scratchRoot = path.join(root, 'tmp')
    fs.mkdirSync(scratchRoot, { recursive: true })
    const now = Date.parse('2026-01-10T00:00:00.000Z')
    const foreign = path.join(scratchRoot, 'some-other-cache')
    fs.mkdirSync(foreign)
    fs.writeFileSync(path.join(foreign, 'keep.bin'), 'keep\n')
    recordPendingScratch({ root: pendingRoot(home), kind: 'pwsh', pinSha256: digest(6), scratch: foreign, reason: 'x', now: () => now })
    const linked = path.join(scratchRoot, 'dsh-ops-pwsh-link')
    // A Windows runner may lack SeCreateSymbolicLinkPrivilege; the foreign-directory
    // case above already proves ownership, so this case is additive.
    try {
      fs.symlinkSync(foreign, linked, 'dir')
      recordPendingScratch({ root: pendingRoot(home), kind: 'pwsh', pinSha256: digest(7), scratch: linked, reason: 'x', now: () => now })
    } catch (error) {
      console.log('  note: this host cannot create a directory symlink; the link case is covered by the path checks: ' + String(error.message ?? error))
    }
    // A malformed record cannot authorize anything either.
    fs.mkdirSync(pendingRoot(home), { recursive: true })
    fs.writeFileSync(path.join(pendingRoot(home), 'broken.json'), '{not json')

    const plan = planPendingSweep({ home, tmpRoot: scratchRoot, keepCount: 0, now: () => now })
    assert.equal(plan.items.every((item) => item.decision === 'unverified'), true, JSON.stringify(plan.items))
    assert.equal(plan.invalid.length, 1, 'the unreadable record is named')
    const swept = sweepPendingScratch({ home, tmpRoot: scratchRoot, keepCount: 0, now: () => now, log: () => {} })
    assert.deepEqual(swept.removed, [])
    assert.equal(fs.existsSync(foreign), true)
    assert.equal(fs.existsSync(path.join(foreign, 'keep.bin')), true)
  })
})

await test('a refused removal keeps the aside directory and its rewritten record for the next sweep', async () => {
  await withTempDir('pending-refused', (root) => {
    const home = path.join(root, 'home'), scratchRoot = path.join(root, 'tmp')
    fs.mkdirSync(scratchRoot, { recursive: true })
    const now = Date.parse('2026-01-10T00:00:00.000Z')
    const directory = seedScratch(scratchRoot, home, { name: 'dsh-ops-pwsh-held', bytes: 7, at: now - 5000, pinIndex: 8 })
    const swept = sweepPendingScratch({
      home, tmpRoot: scratchRoot, keepCount: 0, now: () => now, log: () => {},
      remove: () => { throw new Error('EBUSY: held by a scanner') },
    })
    assert.deepEqual(swept.removed, [])
    const aside = fs.readdirSync(scratchRoot).find((name) => name.startsWith('dsh-ops-pwsh-held.reclaim-'))
    assert.ok(aside !== undefined, 'the tree was moved aside, not left under its original name')
    const record = fs.readFileSync(path.join(pendingRoot(home), fs.readdirSync(pendingRoot(home))[0]), 'utf8')
    assert.ok(record.includes(aside), 'the record now names the aside directory so the next sweep retries it')
    assert.equal(fs.existsSync(directory), false)
  })
})

/** Seed one Niubash target directory with named siblings. */
function seedNiubashRoot(root, siblings) {
  const target = path.join(root, 'dsh-ops', 'shells', 'niubash')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  for (const name of siblings) {
    fs.mkdirSync(path.join(path.dirname(target), name), { recursive: true })
    fs.writeFileSync(path.join(path.dirname(target), name, 'marker'), name + '\n')
  }
  return target
}

await test('sibling reuse, restore, removal and unverified-kept are decided by verification', async () => {
  await withTempDir('niubash-siblings', (root) => {
    // A complete staged tree is reused when the target is missing, and the
    // previous tree beside it is removed because the target now exists.
    {
      const target = seedNiubashRoot(path.join(root, 'reuse'), ['niubash.stage-s1', 'niubash.previous-p1'])
      const decisions = reclaimNiubashSiblings(target, { verify: () => 'ok', log: () => {} })
      const byPath = new Map(decisions.map((decision) => [path.basename(decision.path), decision.action]))
      assert.equal(byPath.get('niubash.stage-s1'), 'reused')
      assert.equal(byPath.get('niubash.previous-p1'), 'removed')
      assert.equal(fs.existsSync(target), true, 'the staged tree became the target')
      assert.deepEqual(fs.readdirSync(path.dirname(target)).sort(), ['niubash'])
    }
    // Only a previous tree: it is renamed back, which is the rollback that failed.
    {
      const target = seedNiubashRoot(path.join(root, 'restore'), ['niubash.previous-p2'])
      const decisions = reclaimNiubashSiblings(target, { verify: () => 'ok', log: () => {} })
      assert.deepEqual(decisions.map((decision) => decision.action), ['restored'])
      assert.equal(fs.existsSync(target), true)
    }
    // A tree that does not verify is kept, and so is everything when nothing verifies.
    {
      const target = seedNiubashRoot(path.join(root, 'unverified'), ['niubash.stage-s3', 'niubash.previous-p3'])
      const decisions = reclaimNiubashSiblings(target, { verify: () => { throw new Error('checksum') }, log: () => {} })
      assert.deepEqual(decisions.map((decision) => decision.action), ['kept', 'kept'])
      assert.equal(fs.readdirSync(path.dirname(target)).length, 2)
    }
    // A dry run reports the same decisions and changes nothing.
    {
      const target = seedNiubashRoot(path.join(root, 'dry'), ['niubash.stage-s4'])
      const decisions = reclaimNiubashSiblings(target, { dryRun: true, verify: () => 'ok', log: () => {} })
      assert.deepEqual(decisions.map((decision) => decision.action), ['reused'])
      assert.equal(fs.existsSync(target), false)
      assert.equal(fs.existsSync(path.join(path.dirname(target), 'niubash.stage-s4')), true)
    }
  })
})

await test('a sibling directory that is a link is kept, never followed', async () => {
  await withTempDir('niubash-link', (root) => {
    const target = seedNiubashRoot(path.join(root, 'links'), [])
    const outside = path.join(root, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep\n')
    try {
      fs.symlinkSync(outside, path.join(path.dirname(target), 'niubash.stage-link'), 'dir')
    } catch (error) {
      console.log('  note: this host cannot create a directory symlink; the sibling-link case needs that capability: ' + String(error.message ?? error))
      return
    }
    const decisions = reclaimNiubashSiblings(target, { verify: () => 'ok', log: () => {} })
    assert.deepEqual(decisions.map((decision) => decision.action), ['kept'])
    assert.equal(fs.existsSync(path.join(outside, 'keep.txt')), true)
  })
})

report('provision-reclaim')
