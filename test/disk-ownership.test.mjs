/** #723: the ownership registry, the category contract, and the disk config skeleton. */
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_DISK_CONFIG, RESOURCES, resolveDiskConfig } from '../lib/disk/ownership.js'
import { resolveMergedConfig, hostConfig } from '../lib/settings/merged.js'
import { resolveConfig } from '../lib/config.js'
import { assert, test, report, PACKAGE_ROOT } from './lib/harness.mjs'

const spec = (id) => RESOURCES.find((entry) => entry.id === id)
const context = (overrides = {}) => ({
  home: '/home/operator/.dsh', tempRoot: '/tmp/fixture-temp', workspace: '/work/checkout',
  platform: 'linux', config: DEFAULT_DISK_CONFIG, ...overrides,
})

await test('the registry covers R1-R13 and states one category, owner and default action per family', () => {
  assert.deepEqual(RESOURCES.map((entry) => entry.id), ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R11', 'R9b', 'R10', 'R12', 'R13'])
  const expected = {
    R1: ['renewable', 'dsh-ops', 'report-only'],
    R2: ['renewable', 'dsh-ops', 'report-only'],
    R3: ['renewable', 'dsh-ops', 'report-only'],
    R4: ['diagnostic', 'dsh-ops', 'never-touch'],
    R5: ['user-artifact', 'session', 'never-touch'],
    R6: ['diagnostic', 'workspace', 'never-touch'],
    R7: ['host-owned', 'host-subprocess-local', 'report-only'],
    R8: ['renewable', 'dsh-ops', 'explicit-command'],
    R9: ['renewable', 'dsh-ops', 'explicit-command'],
    R11: ['renewable', 'dsh-ops', 'report-only'],
    R9b: ['diagnostic', 'dsh-ops', 'never-touch'],
    R10: ['renewable', 'dsh-ops', 'report-only'],
    R12: ['renewable', 'dsh-ops', 'report-only'],
    R13: ['renewable', 'repository-tooling', 'report-only'],
  }
  for (const [id, [category, owner, action]] of Object.entries(expected)) {
    const entry = spec(id)
    assert.ok(entry, id + ' is registered')
    assert.equal(entry.category, category, id + '.category')
    assert.equal(entry.owner, owner, id + '.owner')
    assert.equal(entry.action, action, id + '.action')
    assert.equal(typeof entry.description, 'string')
    assert.ok(entry.description.length > 0, id + ' has a description')
  }
})

await test('only renewable families name a cleanup command; diagnostics, user work and host state never do', () => {
  for (const entry of RESOURCES) {
    if (entry.category === 'renewable') continue
    assert.equal(entry.cleanupEntry, null, entry.id + ' must not name a cleanup command: ' + entry.category)
    assert.ok(entry.blocked, entry.id + ' states why it is retained')
    assert.equal(typeof entry.blocked.reason, 'string')
    assert.equal(typeof entry.blocked.evidence, 'string')
  }
  // Two renewable families have an operator entry today; the rest are report-only until the GC slices land.
  assert.equal(spec('R8').cleanupEntry, 'dsh-ops bash-runtime clean-cache --yes --all-hosts-stopped')
  assert.equal(spec('R9').cleanupEntry, 'dsh-ops bash-runtime remove --yes')
  for (const entry of RESOURCES) {
    if (entry.category === 'renewable' && entry.id !== 'R8' && entry.id !== 'R9') assert.equal(entry.cleanupEntry, null, entry.id)
  }
})

await test('nested rows point at an existing parent bucket and never duplicate the parent bytes', () => {
  const parents = new Map(RESOURCES.filter((entry) => entry.nested === undefined).map((entry) => [entry.id, entry]))
  for (const entry of RESOURCES.filter((candidate) => candidate.nested !== undefined)) {
    const parent = parents.get(entry.nested.parent)
    assert.ok(parent, entry.id + ' names a top-level parent')
    const resolved = parent.resolve(context())
    assert.ok(resolved.some((target) => target.buckets !== undefined && Object.hasOwn(target.buckets, entry.nested.bucket)),
      entry.id + ' bucket is measured by its parent')
    assert.deepEqual(entry.resolve(context()), [], entry.id + ' does not traverse on its own')
  }
})

await test('the panel row follows the workspace rule: never inside the DSH home', () => {
  const outside = spec('R6').resolve(context())
  assert.equal(outside.length, 1)
  assert.equal(outside[0].path, path.join('/work/checkout', '.dsh-ops', 'panel'))
  assert.equal(outside[0].boundary, '/work/checkout')
  assert.deepEqual(spec('R6').resolve(context({ workspace: path.join('/home/operator/.dsh', 'profiles', 'web') })), [])
  assert.deepEqual(spec('R6').resolve(context({ workspace: '/home/operator/.dsh' })), [])
})

await test('repository gate scratch is reported only when includeRepository is on', () => {
  assert.deepEqual(spec('R13').resolve(context()), [])
  const on = spec('R13').resolve(context({
    config: resolveDiskConfig({ status: { includeRepository: true } }),
  }))
  assert.equal(on.length, 2)
  assert.ok(on[0].match.test('dsh-ops-gate-abc123'))
  assert.ok(on[0].match.test('dsh-ops-pack-abc123'))
  assert.ok(on[0].match.test('dsh-ops-legacy-bash-fixture-abc123'))
  assert.equal(on[0].match.test('dsh-ops-gate-abc'), false, 'a short suffix is not a mkdtemp name')
  assert.equal(on[0].match.test('dsh-ops-gate-abc1234'), false, 'a longer suffix is not a mkdtemp name')
  assert.equal(on[0].match.test('dsh-ops-other-abc123'), false)
  assert.ok(on[1].match.test('ops-ipc-build-abc123'))
})

await test('no resource target is a user artifact or a shared store', () => {
  for (const entry of RESOURCES) {
    for (const target of entry.resolve(context({ config: resolveDiskConfig({ status: { includeRepository: true } }) }))) {
      assert.equal(/Downloads|node_modules|[/\\]target([/\\]|$)|pnpm-store|\.cargo/u.test(target.path), false,
        entry.id + ' must not measure ' + target.path)
      assert.equal(path.isAbsolute(target.path), true, entry.id + ' resolves an absolute path')
      assert.equal(path.isAbsolute(target.boundary), true, entry.id + ' states an absolute boundary')
    }
  }
})

await test('the disk defaults are the shipped values and resolveDiskConfig applies them', () => {
  assert.deepEqual(DEFAULT_DISK_CONFIG, {
    status: { includeRepository: false, maxEntries: 5000 },
    retention: { enabled: false, maxAgeDays: 0, maxBytes: 0 },
  })
  assert.deepEqual(resolveDiskConfig(), DEFAULT_DISK_CONFIG)
  assert.deepEqual(resolveDiskConfig(null), DEFAULT_DISK_CONFIG)
  assert.deepEqual(resolveDiskConfig({}), DEFAULT_DISK_CONFIG)
  assert.deepEqual(resolveDiskConfig({ enabled: true }), DEFAULT_DISK_CONFIG, 'the section-level enable switch is reserved')
  assert.deepEqual(resolveDiskConfig({ status: { maxEntries: 7 } }).status, { includeRepository: false, maxEntries: 7 })
})

await test('a malformed disk section fails loud and names the dotted key', () => {
  assert.throws(() => resolveDiskConfig([]), /disk must be an object/u)
  assert.throws(() => resolveDiskConfig({ status: [] }), /disk.status must be an object/u)
  assert.throws(() => resolveDiskConfig({ nope: true }), /unknown key.*disk\.nope/u)
  assert.throws(() => resolveDiskConfig({ status: { nope: true } }), /unknown key.*disk\.status\.nope/u)
  assert.throws(() => resolveDiskConfig({ retention: { nope: true } }), /unknown key.*disk\.retention\.nope/u)
  assert.throws(() => resolveDiskConfig({ status: { maxEntries: 0 } }), /disk\.status\.maxEntries must be an integer from 1 to 100000/u)
  assert.throws(() => resolveDiskConfig({ status: { includeRepository: 'yes' } }), /disk\.status\.includeRepository must be a boolean/u)
  assert.throws(() => resolveDiskConfig({ retention: { maxAgeDays: 1.5 } }), /disk\.retention\.maxAgeDays must be an integer/u)
  assert.throws(() => resolveDiskConfig({ retention: { maxBytes: -1 } }), /disk\.retention\.maxBytes must be an integer/u)
})

await test('cordis.patch.yml ships the same disk defaults the code applies', () => {
  const patch = fs.readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')
  const start = patch.indexOf('        disk:')
  assert.ok(start >= 0, 'the row carries a disk section')
  const lines = patch.slice(start).split('\n').slice(0, 12).map((line) => line.trim())
  const expect = (key, value) => assert.ok(lines.includes(key + ': ' + String(value)),
    'cordis.patch.yml states ' + key + ': ' + String(value) + ' inside the disk block')
  expect('includeRepository', DEFAULT_DISK_CONFIG.status.includeRepository)
  expect('maxEntries', DEFAULT_DISK_CONFIG.status.maxEntries)
  expect('enabled', DEFAULT_DISK_CONFIG.retention.enabled)
  expect('maxAgeDays', DEFAULT_DISK_CONFIG.retention.maxAgeDays)
  expect('maxBytes', DEFAULT_DISK_CONFIG.retention.maxBytes)
})

await test('the merged row and the core config accept the same disk section', () => {
  const disk = { status: { includeRepository: true, maxEntries: 9 }, retention: { enabled: false, maxAgeDays: 2, maxBytes: 1024 } }
  const merged = resolveMergedConfig({ disk })
  assert.equal(merged.disk.enabled, true, 'disk status is available by default')
  assert.deepEqual(merged.disk.config, disk)
  assert.deepEqual(hostConfig({}).disk, { enabled: true }, 'an untouched row adds no disk keys; the code defaults apply')
  const roundTrip = resolveMergedConfig(hostConfig(resolveMergedConfig({ disk })))
  assert.deepEqual(roundTrip.disk.config, disk, 'hostConfig output re-enters the same validator')
  assert.deepEqual(resolveConfig({ disk }).disk, disk)
  assert.deepEqual(resolveConfig({}).disk, DEFAULT_DISK_CONFIG)
  assert.throws(() => resolveMergedConfig({ disk: { status: { nope: true } } }), /disk\.status\.nope/u)
})

report('disk-ownership')
