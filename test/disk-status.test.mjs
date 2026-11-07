/** #723: `disk status` measures a fixture read-only, ignores unknown names and never follows links. */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_DISK_CONFIG, resolveDiskConfig } from '../lib/disk/ownership.js'
import { DISK_STATUS_SCHEMA, diskStatus, renderDiskStatus } from '../lib/disk/status.js'
import { measureFamily, measureTree } from '../lib/disk/measure.js'
import { PACKAGE_ROOT, assert, report, test, withTempDir } from './lib/harness.mjs'

const CLI = path.join(PACKAGE_ROOT, 'bin', 'dsh-ops.mjs')
const NOW_MS = Date.UTC(2026, 10, 6, 12, 0, 0)
const OLD_MS = NOW_MS - 3 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

function write(file, size, mtimeMs = OLD_MS) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'x'.repeat(size))
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs))
}

/** One fixture with every family, plus forged names that must never count. */
function seed(dir) {
  const home = path.join(dir, 'home')
  const tmp = path.join(dir, 'tmp')
  const workspace = path.join(dir, 'workspace')
  fs.mkdirSync(path.join(home, 'dsh-ops'), { recursive: true })
  fs.mkdirSync(tmp, { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })

  write(path.join(tmp, 'dsh-ops-niu-exec-abcdef', 'niu.exe'), 100)
  const rootA = path.join(tmp, 'dsh-ops-results-' + 'a'.repeat(64))
  write(path.join(rootA, 's-' + 'b'.repeat(64), 'snap.json'), 200)
  write(path.join(rootA, '.dsh-ops', 'r-00000000-0000-0000-0000-000000000000.000000.json'), 50)
  fs.mkdirSync(path.join(tmp, 'dsh-ops-results-' + 'c'.repeat(64)), { recursive: true })
  write(path.join(tmp, 'dsh-ops-session-' + 'd'.repeat(16), 'work.txt'), 30)
  write(path.join(workspace, '.dsh-ops', 'panel', 's1.json'), 70)
  write(path.join(tmp, 'dsh-subprocess-abcdef', 'dsh-subprocess-1-1-aaaa-stdout.log'), 40)
  write(path.join(home, 'dsh-ops', 'bash-ipc', 'e'.repeat(24), 'usr', 'bin', 'bash.exe'), 10)
  write(path.join(home, 'dsh-ops', 'shells', 'niubash', 'niu.exe'), 20)
  write(path.join(home, 'dsh-ops', 'shells', 'niubash.stage-abcdef', 'tmp.bin'), 5)
  write(path.join(home, 'dsh-ops', 'acl-backups', 'ws.json'), 8)
  write(path.join(tmp, 'dsh-ops-niubash-abcdef', 'niubash.tar.gz'), 15)
  write(path.join(tmp, 'dsh-ops-review-abcdef', 'probe.txt'), 12)
  write(path.join(tmp, 'dsh-ops-gate-abcdef', 'home.txt'), 3)
  write(path.join(tmp, 'ops-ipc-build-abcdef', 'build.txt'), 4)

  // Unknown, forged and truncated names are not any family the registry owns.
  write(path.join(tmp, 'dsh-ops-results-deadbeef', 'forged.bin'), 99)
  write(path.join(tmp, 'dsh-ops-niu-exec-abc', 'forged.bin'), 99)
  write(path.join(tmp, 'dsh-ops-gate-abc', 'forged.bin'), 99)
  return { home, tmp, workspace }
}

const reportFor = (fixture, overrides = {}) => diskStatus({
  home: fixture.home, tempRoot: fixture.tmp, workspace: fixture.workspace,
  platform: 'linux', config: DEFAULT_DISK_CONFIG, now: () => NOW_MS, ...overrides,
})
const row = (value, id) => value.resources.find((entry) => entry.id === id)

/** Every path and size below a root, so "nothing changed" is a real comparison. */
function snapshot(root) {
  const rows = []
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(file)
      else rows.push([path.relative(root, file), fs.lstatSync(file).size])
    }
  }
  walk(root)
  return rows
}

await test('the report has a stable schema and measures every family from the fixture', async () => {
  await withTempDir('disk-status-fixture', (dir) => {
    const fixture = seed(dir)
    const value = reportFor(fixture)
    assert.equal(value.schema, DISK_STATUS_SCHEMA)
    assert.deepEqual(Object.keys(value), ['schema', 'generatedAt', 'platform', 'home', 'tempRoot', 'workspace', 'config', 'resources', 'totals', 'notes'])
    assert.deepEqual(Object.keys(value.resources[0]), ['id', 'name', 'category', 'owner', 'action', 'cleanupEntry', 'description', 'paths', 'samples', 'bytes', 'files', 'count', 'ageMs', 'reclaimableBytes', 'reclaimBlocked', 'truncated', 'skippedCount', 'skipped'])
    assert.deepEqual(value.resources.map((entry) => entry.id), ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R11', 'R9b', 'R10', 'R12', 'R13'])
    const expected = { R1: [100, 1, 1], R2: [250, 2, 2], R3: [200, 1, 1], R4: [50, 1, 1], R5: [30, 1, 1], R6: [70, 1, 1], R7: [40, 1, 1], R8: [10, 1, 1], R9: [25, 2, 1], R11: [5, 1, 1], R9b: [8, 1, 1], R10: [15, 1, 1], R12: [12, 1, 1], R13: [0, 0, 0] }
    for (const [id, [bytes, files, count]] of Object.entries(expected)) {
      const entry = row(value, id)
      assert.equal(entry.bytes, bytes, id + '.bytes')
      assert.equal(entry.files, files, id + '.files')
      assert.equal(entry.count, count, id + '.count')
    }
    assert.equal(row(value, 'R6').paths[0], path.join(fixture.workspace, '.dsh-ops', 'panel'))
    assert.equal(row(value, 'R2').samples.length, 2, 'both result roots are sampled')
    assert.equal(row(value, 'R2').samples[0].endsWith('a'.repeat(64)), true, 'samples are sorted by name')
  })
})

await test('nested rows are explained but excluded from the totals', async () => {
  await withTempDir('disk-status-totals', (dir) => {
    const value = reportFor(seed(dir))
    const top = value.resources.filter((entry) => !['R3', 'R4', 'R11'].includes(entry.id))
    assert.equal(value.totals.bytes, top.reduce((sum, entry) => sum + entry.bytes, 0))
    assert.equal(value.totals.files, top.reduce((sum, entry) => sum + entry.files, 0))
    assert.equal(value.totals.count, top.reduce((sum, entry) => sum + entry.count, 0))
    assert.equal(value.totals.bytes, 560)
    assert.deepEqual(value.totals.byCategory, { renewable: 412, diagnostic: 78, 'user-artifact': 30, 'host-owned': 40 })
    for (const id of ['R3', 'R4', 'R11']) assert.equal(row(value, id).paths.length > 0, true, id + ' names its parent path')
  })
})

await test('the default action per category is reported and never executed', async () => {
  await withTempDir('disk-status-actions', (dir) => {
    const fixture = seed(dir)
    const before = snapshot(dir)
    const value = reportFor(fixture)
    assert.equal(row(value, 'R7').owner, 'host-subprocess-local')
    assert.equal(row(value, 'R7').action, 'report-only')
    assert.equal(row(value, 'R7').cleanupEntry, null)
    for (const id of ['R4', 'R5', 'R6', 'R9b']) assert.equal(row(value, id).action, 'never-touch', id)
    assert.equal(row(value, 'R8').action, 'explicit-command')
    assert.match(row(value, 'R8').cleanupEntry, /clean-cache --yes --all-hosts-stopped/u)
    assert.equal(row(value, 'R9').action, 'explicit-command')
    for (const entry of value.resources) {
      if (entry.reclaimableBytes > 0) assert.equal(entry.category, 'renewable', entry.id + ' is the only kind that can report reclaimable bytes')
    }
    assert.deepEqual(snapshot(dir), before, 'a report changes no file and creates no directory')
  })
})

await test('reclaim evidence stays conservative: forged and unknown trees are never reclaimable', async () => {
  await withTempDir('disk-status-reclaim', (dir) => {
    const fixture = seed(dir)
    const value = reportFor(fixture)
    assert.equal(row(value, 'R1').reclaimableBytes, 0)
    assert.equal(row(value, 'R1').reclaimBlocked.reason, 'no-orphan-registry')
    assert.equal(row(value, 'R2').reclaimBlocked.reason, 'authority-bound-purge')
    assert.equal(row(value, 'R8').reclaimableBytes, 0)
    assert.equal(row(value, 'R8').reclaimBlocked.reason, 'current-generation-unknown')
    assert.equal(value.totals.reclaimableBytes, 0)
    // A forged managed marker inside a bash-ipc generation does not make it idle.
    write(path.join(fixture.home, 'dsh-ops', 'bash-ipc', 'e'.repeat(24), '.ops-lifecycle.json'), 12)
    assert.equal(reportFor(fixture).totals.reclaimableBytes, 0)
  })
})

await test('includeRepository and maxEntries come from the disk configuration', async () => {
  await withTempDir('disk-status-config', (dir) => {
    const fixture = seed(dir)
    const withRepo = reportFor(fixture, { config: resolveDiskConfig({ status: { includeRepository: true } }) })
    assert.deepEqual([row(withRepo, 'R13').bytes, row(withRepo, 'R13').files, row(withRepo, 'R13').count], [7, 2, 2])
    assert.equal(withRepo.totals.bytes, 567, 'the repository scratch is counted only when enabled')
    const truncated = reportFor(fixture, { config: resolveDiskConfig({ status: { maxEntries: 1 } }) })
    assert.equal(row(truncated, 'R2').count, 1, 'only one family member fits the entry budget')
    assert.equal(row(truncated, 'R2').truncated, true)
    assert.equal(row(truncated, 'R2').skipped.some((skip) => skip.reason === 'entry-budget'), true)
  })
})

await test('links are reported and never followed, and an out-of-root target is refused', async () => {
  if (process.platform === 'win32') {
    console.log('  skip links are reported and never followed — creating symlinks needs a Windows privilege')
    return
  }
  await withTempDir('disk-status-links', (dir) => {
    const fixture = seed(dir)
    const outside = path.join(dir, 'outside')
    write(path.join(outside, 'secret.bin'), 4096)
    fs.symlinkSync(outside, path.join(fixture.tmp, 'dsh-ops-niu-exec-abcdef', 'escape'))
    fs.symlinkSync(outside, path.join(fixture.tmp, 'dsh-ops-review-sym123'))
    const value = reportFor(fixture)
    assert.equal(row(value, 'R1').bytes, 100, 'the link target is not counted')
    assert.equal(row(value, 'R1').skipped.some((skip) => skip.reason === 'symlink'), true)
    assert.equal(row(value, 'R12').count, 1, 'a symlinked family member is skipped, not traversed')
    assert.equal(row(value, 'R12').bytes, 12)
    const refused = measureTree(path.join(fixture.tmp, 'dsh-ops-niu-exec-abcdef'), { boundary: fixture.workspace })
    assert.equal(refused.bytes, 0)
    assert.equal(refused.skipped[0].reason, 'out-of-root')
    const refusedFamily = measureFamily(fixture.tmp, /^dsh-ops-niu-exec-[A-Za-z0-9]{6}$/u, { boundary: fixture.workspace })
    assert.equal(refusedFamily.skipped[0].reason, 'out-of-root')
  })
})

await test('permission failures degrade to a skip instead of throwing', async () => {
  const posix = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0
  if (!posix) {
    console.log('  skip permission failures degrade to a skip — this host cannot drop read permission reliably')
    return
  }
  await withTempDir('disk-status-denied', (dir) => {
    const fixture = seed(dir)
    const blocked = path.join(fixture.tmp, 'dsh-ops-session-' + 'f'.repeat(16))
    fs.mkdirSync(blocked, { recursive: true })
    write(path.join(blocked, 'hidden.txt'), 64)
    fs.chmodSync(blocked, 0o000)
    try {
      const value = reportFor(fixture)
      const entry = row(value, 'R5')
      assert.equal(entry.count, 2)
      assert.equal(entry.skipped.some((skip) => skip.reason === 'unreadable' && skip.code === 'EACCES'), true)
    } finally {
      fs.chmodSync(blocked, 0o755)
    }
  })
})

await test('a missing environment is an empty report, not an exception', async () => {
  const missing = path.join(PACKAGE_ROOT, 'no-such-fixture-' + process.pid)
  const value = diskStatus({ home: path.join(missing, 'home'), tempRoot: path.join(missing, 'tmp'), workspace: path.join(missing, 'ws'), platform: 'linux', config: DEFAULT_DISK_CONFIG, now: () => NOW_MS })
  assert.equal(value.resources.length, 14)
  assert.equal(value.totals.bytes, 0)
  for (const entry of value.resources) {
    assert.equal(entry.bytes, 0)
    assert.equal(entry.count, 0)
    assert.equal(entry.ageMs, null)
  }
  assert.match(renderDiskStatus(value), /\(missing\)/u)
})

await test('a corrupted family member is reported without aborting the whole report', async () => {
  await withTempDir('disk-status-corrupt', (dir) => {
    const fixture = seed(dir)
    // A result root that is a regular file where the family expects a directory.
    fs.writeFileSync(path.join(fixture.tmp, 'dsh-ops-results-' + '9'.repeat(64)), 'not a tree\n')
    const value = reportFor(fixture)
    assert.equal(row(value, 'R2').count, 3)
    assert.equal(row(value, 'R3').count, 1, 'the snapshot bucket still measures the valid root')
    assert.match(renderDiskStatus(value), /^R2 /mu)
  })
})

await test('the CLI prints the same report as JSON and as a human table, deleting nothing', async () => {
  await withTempDir('disk-status-cli', (dir) => {
    const fixture = seed(dir)
    const before = [snapshot(fixture.home), snapshot(fixture.tmp), snapshot(fixture.workspace)]
    const env = { ...process.env, DSH_HOME: fixture.home, HOME: dir, USERPROFILE: dir, TMPDIR: fixture.tmp, TEMP: fixture.tmp, TMP: fixture.tmp }
    const run = (args) => {
      const result = spawnSync(process.execPath, [CLI, 'disk', ...args], { cwd: fixture.workspace, encoding: 'utf8', env, timeout: 120_000 })
      return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
    }
    const machine = run(['status', '--json'])
    assert.equal(machine.status, 0, machine.stderr)
    const parsed = JSON.parse(machine.stdout)
    assert.equal(parsed.schema, DISK_STATUS_SCHEMA)
    assert.equal(parsed.resources.length, 14)
    assert.equal(parsed.totals.bytes, 560)
    assert.equal(parsed.home, fixture.home)
    assert.equal(parsed.tempRoot, fixture.tmp)
    assert.equal(row(parsed, 'R13').count, 0)

    const human = run(['status'])
    assert.equal(human.status, 0, human.stderr)
    assert.match(human.stdout, /^dsh-ops disk status - read-only report; nothing was created or deleted$/mu)
    assert.ok(human.stdout.includes('host-subprocess-local'))
    assert.ok(human.stdout.includes('never-touch'))
    assert.ok(human.stdout.includes('report-only'))
    assert.ok(human.stdout.includes('retention=disabled'))
    assert.ok(human.stdout.includes('R1'))

    // The configuration file turns repository scratch on for this report only.
    const configFile = path.join(dir, 'row.json')
    fs.writeFileSync(configFile, JSON.stringify({ disk: { status: { includeRepository: true, maxEntries: 100 } } }) + '\n')
    const configured = run(['status', '--json', '--config', configFile])
    assert.equal(configured.status, 0, configured.stderr)
    assert.equal(row(JSON.parse(configured.stdout), 'R13').count, 2)

    assert.equal(run(['nope']).status, 2)
    assert.match(run(['nope']).stderr, /expected the status subcommand/u)
    fs.writeFileSync(configFile, JSON.stringify({ disk: { status: { maxEntries: 0 } } }) + '\n')
    const broken = run(['status', '--json', '--config', configFile])
    assert.equal(broken.status, 1)
    assert.match(broken.stderr, /disk\.status\.maxEntries must be an integer/u)
    assert.equal(broken.stdout, '')
    assert.deepEqual([snapshot(fixture.home), snapshot(fixture.tmp), snapshot(fixture.workspace)], before,
      'no CLI invocation changed or created a file under the measured roots')
  })
})

report('disk-status')
