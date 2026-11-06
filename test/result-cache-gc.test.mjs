/** Result-cache retention: deferred cleanup ledger, structural sweep and aggregate budgets. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { parse } from 'yaml'
import { spawnSync } from 'node:child_process'
import { assert, test, report, withTempDir, waitFor, PACKAGE_ROOT } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { DEFAULT_RESULT_CACHE, resolveConfig, resolveResultCacheConfig } from '../lib/config.js'
import { resolveMergedConfig } from '../lib/settings/merged.js'
import { runResultCacheGc, configureResultCacheGc } from '../lib/kernel/result-cache-gc.js'
import {
  completeCleanupRoot, listPendingCleanup, markCleanupRootLive, registerCleanupRoot, releaseCleanupRootLive,
  resetCleanupHostBoot, setCleanupRegistryDir,
} from '../lib/kernel/result-cleanup-registry.js'
import { mountResultLifecycle } from '../lib/kernel/result-lifecycle.js'
import { resultStorage } from '../lib/kernel/result-storage.js'

const POSIX = process.platform !== 'win32'
const SNAPSHOT = '11111111-1111-4111-8111-111111111111.json'
const digest = value => createHash('sha256').update(value).digest('hex')
const rootName = seed => `dsh-ops-results-${digest(seed)}`
const shardName = scope => `s-${digest(scope)}`
/** Default budget with the age grace removed: the fixture roots are seconds old, not hours. */
const budget = (overrides = {}) => ({ ...DEFAULT_RESULT_CACHE, maxAgeMs: 0, ...overrides })

function makeRoot(dir, seed, build) {
  const root = path.join(dir, rootName(seed))
  fs.mkdirSync(root, { mode: 0o700 })
  build?.(root)
  return root
}

function makeShard(root, scope, files = {}) {
  const shard = path.join(root, shardName(scope))
  fs.mkdirSync(shard, { mode: 0o700 })
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(shard, name), contents, { mode: 0o600 })
  return shard
}

/** Per-test registry isolation; production uses <tmpdir>/dsh-ops-cleanup-registry. */
async function withRegistry(dir, body) {
  setCleanupRegistryDir(dir)
  try { return await body() } finally {
    setCleanupRegistryDir(undefined)
    resetCleanupHostBoot()
  }
}

await test('the shipped retention budget is conservative and the patch section matches the resolver', () => {
  const shipped = resolveConfig({}).resultCache
  assert.deepEqual(shipped, { maxRoots: 0, maxTotalBytes: 0, maxAgeMs: 3600000, sweepEnabled: true })
  const row = parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')).flatMap(entry => entry.insert ?? [])[0]
  assert.equal(row.config.resultCache.enabled, true)
  assert.deepEqual(resolveMergedConfig(row.config).resultCache.config, shipped,
    'cordis.patch.yml must repeat the code defaults')
  assert.deepEqual(resolveResultCacheConfig({ maxRoots: 3, maxTotalBytes: 1024, maxAgeMs: 0, sweepEnabled: false }),
    { maxRoots: 3, maxTotalBytes: 1024, maxAgeMs: 0, sweepEnabled: false })
  for (const bad of [{ maxRoots: -1 }, { maxTotalBytes: 1.5 }, { maxAgeMs: '1h' }, { sweepEnabled: 'yes' }, { maxRoot: 1 }]) {
    assert.throws(() => resolveResultCacheConfig(bad))
  }
  // A configured section keeps the switch but nowhere forbids the aggregate limits.
  const configured = resolveMergedConfig({ resultCache: { maxRoots: 2 } })
  assert.equal(configured.resultCache.enabled, true)
  assert.equal(configured.resultCache.config.maxRoots, 2)
})

if (POSIX) await test('the sweep reclaims roots whose cache data is gone and never a live root', () => withTempDir('result-gc-sweep', dir => {
  const empty = makeRoot(dir, 'empty')
  const emptyToo = makeRoot(dir, 'empty-too')
  const lockOnly = makeRoot(dir, 'lock-only', root => makeShard(root, 'one', { lock: '' }))
  const data = makeRoot(dir, 'data', root => makeShard(root, 'two', { lock: '', [SNAPSHOT]: 'x'.repeat(32) }))
  const live = makeRoot(dir, 'live')
  markCleanupRootLive(live)
  try {
    // Three disposed-session roots in the shapes a successful purge leaves behind.
    const swept = runResultCacheGc({ budget: budget(), dir, apply: true, scope: 'all' })
    assert.equal(swept.removed, 3, JSON.stringify(swept.errors))
    assert.equal(fs.existsSync(empty), false)
    assert.equal(fs.existsSync(emptyToo), false)
    assert.equal(fs.existsSync(lockOnly), false)
    assert.equal(fs.existsSync(data), true, 'a root that still holds a snapshot is never reclaimed by default')
    assert.equal(fs.existsSync(live), true, 'the live set is excluded even when the structure looks reclaimable')
    assert.equal(swept.states.data, 1)
    assert.equal(swept.states.live, 1)
    assert.equal(swept.details.find(entry => entry.name === path.basename(live)).reason, 'live-in-this-process')
    assert.equal(swept.details.find(entry => entry.name === path.basename(data)).reason, 'within-budget')
    assert.equal(swept.removedBytes, 0)
    assert.deepEqual(swept.errors, [])
  } finally { releaseCleanupRootLive(live) }
  // The same root becomes reclaimable once the session stops using it.
  const after = runResultCacheGc({ budget: budget(), dir, apply: true, scope: 'all' })
  assert.equal(after.removed, 1)
  assert.equal(fs.existsSync(live), false)
}))

if (POSIX) await test('reclaim plans without deleting until apply is requested', () => withTempDir('result-gc-dry-run', dir => {
  const empty = makeRoot(dir, 'dry-run')
  const planned = runResultCacheGc({ budget: budget(), dir, scope: 'all' })
  assert.equal(planned.applied, false)
  assert.equal(planned.reclaimable, 1)
  assert.equal(planned.removed, 0)
  assert.equal(planned.planned, 1)
  assert.equal(fs.existsSync(empty), true, 'a status pass never removes a root')
  const applied = runResultCacheGc({ budget: budget(), dir, scope: 'all', apply: true })
  assert.equal(applied.removed, 1)
  assert.equal(fs.existsSync(empty), false)
}))

if (POSIX) await test('structure validation skips symlinks, forged names, foreign modes and unknown contents', () => withTempDir('result-gc-structure', dir => {
  fs.mkdirSync(path.join(dir, 'elsewhere'), { mode: 0o700 })
  const target = path.join(dir, 'elsewhere')
  const link = path.join(dir, rootName('symlink'))
  fs.symlinkSync(target, link)
  const forged = path.join(dir, 'dsh-ops-results-not-a-digest')
  fs.mkdirSync(forged, { mode: 0o700 })
  const unknownEntry = makeRoot(dir, 'unknown-entry', root => { fs.writeFileSync(path.join(root, 'notes.txt'), 'keep me', { mode: 0o600 }) })
  const unknownShardFile = makeRoot(dir, 'unknown-shard-file', root => makeShard(root, 'three', { arbitrary: 'keep me' }))
  const publicMode = makeRoot(dir, 'public-mode')
  fs.chmodSync(publicMode, 0o750)
  const swept = runResultCacheGc({ budget: budget(), dir, apply: true, scope: 'all' })
  assert.equal(swept.removed, 0)
  assert.equal(fs.existsSync(link), true)
  assert.equal(fs.existsSync(forged), true)
  assert.equal(fs.existsSync(unknownEntry), true, 'one unknown name skips the whole root')
  assert.equal(fs.existsSync(unknownShardFile), true)
  assert.equal(fs.existsSync(publicMode), true)
  assert.equal(swept.scanned, 4, 'a forged name is never even considered a root')
  const reasons = new Map(swept.details.map(entry => [entry.name, [entry.state, entry.reason]]))
  assert.deepEqual(reasons.get(path.basename(link)), ['unknown', 'not-a-directory'])
  assert.deepEqual(reasons.get(path.basename(unknownEntry)), ['unknown', 'unknown-entry'])
  assert.deepEqual(reasons.get(path.basename(unknownShardFile)), ['unknown', 'unknown-entry'])
  assert.deepEqual(reasons.get(path.basename(publicMode)), ['unknown', 'foreign-owner'])
  assert.deepEqual(swept.errors, [])
}))

if (POSIX) await test('an aggregate budget evicts data roots oldest first, and only when configured', () => withTempDir('result-gc-budget', dir => {
  const older = makeRoot(dir, 'older', root => makeShard(root, 'four', { [SNAPSHOT]: 'x'.repeat(16) }))
  const newer = makeRoot(dir, 'newer', root => makeShard(root, 'five', { [SNAPSHOT]: 'y'.repeat(16) }))
  const past = new Date(Date.now() - 86_400_000)
  fs.utimesSync(older, past, past)
  const reported = runResultCacheGc({ budget: budget(), dir, apply: true, scope: 'all' })
  assert.equal(reported.removed, 0, 'both aggregate budgets are 0: report only')
  assert.equal(reported.reclaimable, 0)
  assert.equal(fs.existsSync(older), true)
  const bounded = runResultCacheGc({ budget: budget({ maxRoots: 1 }), dir, apply: true, scope: 'all' })
  assert.equal(bounded.removed, 1)
  assert.equal(fs.existsSync(older), false, 'the oldest data root is evicted first')
  assert.equal(fs.existsSync(newer), true)
  const bytes = runResultCacheGc({ budget: budget({ maxTotalBytes: 8 }), dir, apply: false, scope: 'all' })
  assert.equal(bytes.reclaimable, 1)
  assert.equal(fs.existsSync(newer), true)
}))

if (POSIX) await test('a pending record survives a restart, reclaims its root and is then cleared', () => withTempDir('result-gc-pending', async dir => {
  const registry = path.join(dir, 'registry'), roots = path.join(dir, 'roots')
  fs.mkdirSync(roots, { mode: 0o700 })
  const pendingRoot = makeRoot(roots, 'pending')
  const missingRoot = path.join(roots, rootName('missing'))
  await withRegistry(registry, () => {
    assert.ok(registerCleanupRoot(pendingRoot, { sessionHeading: digest('session-a'), workspaceRoot: dir }))
    assert.ok(registerCleanupRoot(missingRoot, { sessionHeading: digest('session-b'), workspaceRoot: dir }))
    const before = listPendingCleanup().map(record => record.root)
    assert.deepEqual(before.sort(), [missingRoot, pendingRoot].sort())
    // Simulate the next host process: same ledger directory, new boot identity.
    resetCleanupHostBoot()
    assert.equal(listPendingCleanup().length, 2, 'a start-up reload sees the previous process records')
    const swept = runResultCacheGc({ budget: budget(), dir: roots, apply: true, scope: 'all' })
    assert.equal(swept.removed, 1)
    assert.equal(fs.existsSync(pendingRoot), false)
    assert.deepEqual(listPendingCleanup(), [], 'a completed cleanup and a vanished root both leave no record')
  })
}))

if (POSIX) await test('a root removed behind the session is recreated instead of failing the next call', () => withTempDir('result-gc-self-heal', async dir => {
  await withRegistry(path.join(dir, 'registry'), async () => {
    const ctx = { get: () => undefined, logger: { warn() {} } }
    const session = { id: 'self-heal', header: { cwd: dir } }
    const policy = { mode: 'workspace-write', workspaceRoot: dir, sessionId: session.id }
    const first = await resultStorage(ctx, session, undefined, 'worker', 'result', policy, [], false)
    assert.ok(first)
    try {
      assert.equal(fs.existsSync(first.root), true)
      fs.rmSync(first.root, { recursive: true, force: true })
      const second = await resultStorage(ctx, session, undefined, 'worker', 'result', policy, [], false)
      assert.equal(second.root, first.root, 'the same session keeps its cache identity')
      assert.equal(fs.existsSync(second.root), true, 'a removed root is recreated before the worker sees it')
    } finally {
      completeCleanupRoot(first.root)
      fs.rmSync(first.root, { recursive: true, force: true })
    }
  })
}))

if (POSIX) await test('the plugin lifecycle sweeps at start-up and again when the last owner unloads', () => withTempDir('result-gc-lifecycle', async dir => {
  const roots = path.join(dir, 'roots')
  fs.mkdirSync(roots, { mode: 0o700 })
  await withRegistry(path.join(dir, 'registry'), async () => {
    configureResultCacheGc(budget(), { dir: roots, startupDelayMs: 0 })
    const { ctx } = await bootHost()
    try {
      const startupRoot = makeRoot(roots, 'startup')
      markCleanupRootLive(startupRoot); releaseCleanupRootLive(startupRoot)
      const fiber = await ctx.plugin(inner => mountResultLifecycle(inner))
      await waitFor(() => !fs.existsSync(startupRoot), { what: 'the start-up retention sweep' })
      const unloadRoot = makeRoot(roots, 'unload')
      markCleanupRootLive(unloadRoot); releaseCleanupRootLive(unloadRoot)
      await fiber.dispose()
      assert.equal(fs.existsSync(unloadRoot), false, 'the shutdown sweep reclaims roots this process created')
    } finally {
      configureResultCacheGc(undefined)
      await shutdown(ctx)
    }
  })
}))

await test('the operator command reports the inventory and removes nothing without --apply', () => {
  const cli = (...args) => spawnSync(process.execPath, [path.join(PACKAGE_ROOT, 'bin/dsh-ops.mjs'), 'result-cache', ...args], { encoding: 'utf8' })
  const status = cli('status', '--json')
  assert.equal(status.status, 0, status.stderr)
  const listed = JSON.parse(status.stdout)
  assert.equal(listed.action, 'status')
  assert.equal(listed.applied, false)
  assert.equal(listed.removed, 0)
  assert.equal(typeof listed.roots, 'number')
  assert.equal(typeof listed.states.empty, 'number')
  const preview = cli('reclaim')
  assert.equal(preview.status, 0, preview.stderr)
  assert.match(preview.stdout, /Preview only: no root was removed/)
  const refused = cli('nonsense')
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /Expected result-cache status or reclaim/)
})

report('result-cache-gc')
