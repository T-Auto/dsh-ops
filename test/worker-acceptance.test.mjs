/**
 * Worker acceptance battery.
 *
 * Two layers, matching how the product actually drives the native worker:
 *
 * 1. **Direct requests** — `dsh-ops-worker` started with one JSON request on
 *    stdin, exactly like the bridges do. This is the worker's own contract:
 *    path intake, batch preflight, generations, reserved storage.
 * 2. **Host bridges** — `lib/file/worker.js#invoke` and `lib/ptc/worker.js#invoke`
 *    with simulated `sandboxPolicy`/`subprocess`/`sandbox` providers. This is the
 *    policy layer: write roots, read-only gating, session scope.
 *
 * NOT AN OS SANDBOX TEST. The confinement provider here is a pass-through
 * fixture, so nothing below says anything about kernel enforcement on any
 * platform — only about the worker and the bridge policy.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { PACKAGE_ROOT, assert, report, skipSuite, test, withTempDir } from './lib/harness.mjs'
import { invoke as invokeFile } from '../lib/file/worker.js'
import { invoke as invokePtc } from '../lib/ptc/worker.js'

const worker = process.env.DSH_OPS_WORKER_BIN
  ?? path.resolve(PACKAGE_ROOT, 'native/target/release', process.platform === 'win32' ? 'dsh-ops-worker.exe' : 'dsh-ops-worker')
if (!fs.existsSync(worker)) {
  skipSuite('worker acceptance', `build the worker first (npm run build:rust); looked for ${worker}`)
}

/** One worker process per request, one JSON response — the production shape. */
function request(root, tool, args, { scope = 'acceptance', readOnly = false, writeRoots } = {}) {
  const payload = { root, scope, tool, args, read_only: readOnly, ...(writeRoots ? { write_roots: writeRoots } : {}) }
  const run = spawnSync(worker, [], { input: JSON.stringify(payload), encoding: 'utf8' })
  assert.equal(run.status, 0, `worker exited ${run.status}: ${run.stderr}`)
  return JSON.parse(run.stdout)
}

const storeFiles = root => {
  const store = path.join(root, '.dsh-ops')
  return fs.existsSync(store) ? fs.readdirSync(store) : []
}

/** Bridge context: real policy shape, fixture confinement, real subprocess. */
async function withBridge({ mode, workspaceRoot }, body) {
  const ctx = new Context()
  ctx.logger.level = 0
  await ctx.plugin(Subprocess)
  const policy = { mode, workspaceRoot, sessionId: `${mode}-acceptance` }
  await ctx.plugin(inner => { inner.provide('sandboxPolicy', { resolve: () => policy }) })
  await ctx.plugin(inner => { inner.provide('sandbox', { confine: async argv => ({ enforcement: 'full', argv }) }) })
  const exec = (scope = policy.sessionId) => ({ agent: { session: { id: scope, mode, header: { cwd: workspaceRoot } } } })
  try {
    return await body({
      policy,
      file: (tool, args, scope) => invokeFile(ctx, worker, tool, args, exec(scope), new AbortController().signal),
      ptc: (tool, args, scope) => invokePtc(ctx, worker, tool, args, exec(scope), new AbortController().signal),
    })
  } finally {
    await ctx.fiber.dispose()
  }
}

const failure = value => value?.error?.code ?? null

// ── 1. Direct requests: file tools ────────────────────────────────────────────
test('file tools: inspect, grep, glob, replace and path intake', () => withTempDir('worker-files', async root => {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'a.txt'), 'alpha\nbeta\n')
  fs.writeFileSync(path.join(root, 'src', 'b.log'), 'beta\n')

  // Direct requests carry host-resolved absolute paths; the bridges do the resolving.
  const inspected = request(root, 'inspect_local_file', { path: path.join(root, 'src', 'a.txt') })
  assert.equal(inspected.status, 'completed', JSON.stringify(inspected))
  assert.match(JSON.stringify(inspected), /alpha/)

  const grepped = request(root, 'grep', { path: path.join(root, 'src'), pattern: 'beta' })
  assert.equal(grepped.status, 'completed')
  assert.equal(grepped.matched, 2, 'grep reports one match per file')

  const globbed = request(root, 'glob', { path: path.join(root, 'src'), pattern: ['**/*.txt'] })
  assert.equal(globbed.status, 'completed')
  assert.deepEqual(globbed.items.map(name => path.basename(name)), ['a.txt'])

  // replace reports a content revision and really changes the file.
  const replaced = request(root, 'replace', { path: path.join(root, 'src', 'a.txt'), pattern: 'beta', replacement: 'BETA' })
  assert.equal(replaced.status, 'completed')
  assert.equal(replaced.changed, 1)
  assert.match(replaced.items[0].revision, /^[0-9a-f]{64}$/, 'revision is a content hash')
  assert.equal(fs.readFileSync(path.join(root, 'src', 'a.txt'), 'utf8'), 'alpha\nBETA\n')
  assert.deepEqual(fs.readdirSync(path.join(root, 'src')).sort(), ['a.txt', 'b.log'], 'no temporary file is left behind')

  // Path intake is absolute-only and lexically normalized; no device paths.
  assert.equal(failure(request(root, 'inspect_local_file', { path: 'src/a.txt' })), 'INVALID_ARGUMENT', 'relative paths are the bridge\'s job')
  const dotdot = `${root}${path.sep}src${path.sep}..${path.sep}src${path.sep}a.txt`
  assert.equal(failure(request(root, 'inspect_local_file', { path: dotdot })), 'INVALID_ARGUMENT', 'non-normalized paths are refused')
  assert.equal(failure(request(root, 'inspect_local_file', { path: `${root}\u0000` })), 'INVALID_ARGUMENT', 'NUL bytes are refused')
}))

// ── 2. Direct requests: batch contract ────────────────────────────────────────
test('batch contract: removals, plan/resume, revisions, overlap, reserved storage', () => withTempDir('worker-batch', async root => {
  const write = (name, text = name) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.writeFileSync(path.join(root, name), text)
  }
  write('main/keep', 'protected')
  write('review/.git/objects/ro', 'readonly')
  fs.chmodSync(path.join(root, 'review', '.git', 'objects', 'ro'), 0o444)
  write('source/a', 'alpha')
  write('source/b', 'beta')

  // Removals: a tree that the platform may hand out as directory handles, a
  // read-only file inside it, and ordinary files.
  const removed = request(root, 'batch', { action: 'run', protect: ['main'], operations: [
    { op: 'remove', path: 'review' },
    { op: 'copy', path: 'source/a', to: 'copy-a' },
    { op: 'move', path: 'source/b', to: 'moved-b' },
  ] })
  assert.equal(removed.status, 'completed', JSON.stringify(removed))
  assert.equal(removed.done, 3)
  assert.equal(fs.existsSync(path.join(root, 'review')), false, 'non-empty directory removal completes')
  assert.equal(fs.existsSync(path.join(root, 'source', 'b')), false, 'move removes the source')
  assert.equal(fs.existsSync(path.join(root, 'main', 'keep')), true, 'protected path survives')
  assert.equal(fs.readFileSync(path.join(root, 'moved-b'), 'utf8'), 'beta')

  // Every execution leaves immutable generations plus the shared lock.
  const job = removed.id
  assert.match(job, /^j-[0-9a-f-]{36}$/, 'job id is a j-prefixed uuid')
  const owned = storeFiles(root).filter(name => name.startsWith(job))
  assert.equal(owned.length, 3, 'pending/unknown/completed generations')
  assert.ok(storeFiles(root).includes('lock'))

  // A planned job executes exactly the plan it recorded.
  write('planned.txt', 'PLAN')
  const plan = request(root, 'batch', { action: 'plan', operations: [{ op: 'copy', path: 'planned.txt', to: 'planned-out.txt' }] })
  assert.equal(plan.status, 'planned', JSON.stringify(plan))
  assert.equal(fs.existsSync(path.join(root, 'planned-out.txt')), false, 'plan has no effect')
  const resumed = request(root, 'batch', { action: 'resume', id: plan.id })
  assert.equal(resumed.status, 'completed')
  assert.equal(fs.readFileSync(path.join(root, 'planned-out.txt'), 'utf8'), 'PLAN')

  // Revision binding: a source that changed after planning is refused.
  write('source-c', 'V1')
  const stale = request(root, 'batch', { action: 'plan', operations: [{ op: 'copy', path: 'source-c', to: 'stale-out' }] })
  write('source-c', 'V2')
  const staleRun = request(root, 'batch', { action: 'resume', id: stale.id })
  assert.equal(staleRun.failed, 1, 'a failed item is counted, not swallowed')
  assert.equal(fs.existsSync(path.join(root, 'stale-out')), false)
  // Per-item detail is read back through the job's own page, not the run summary.
  const stalePage = request(root, 'result', { action: 'page', id: stale.id })
  assert.match(JSON.stringify(stalePage), /REVISION_CONFLICT/)

  // No overwrites, no overlapping sources, no escaping operation paths.
  write('exists.txt', 'ORIGINAL')
  const overwrite = request(root, 'batch', { action: 'plan', operations: [{ op: 'copy', path: 'planned.txt', to: 'exists.txt' }] })
  assert.equal(failure(overwrite), 'REVISION_CONFLICT')
  assert.equal(fs.readFileSync(path.join(root, 'exists.txt'), 'utf8'), 'ORIGINAL')
  const overlap = request(root, 'batch', { action: 'plan', operations: [
    { op: 'copy', path: 'planned.txt', to: 'o1' }, { op: 'copy', path: 'planned.txt', to: 'o2' },
  ] })
  assert.equal(failure(overlap), 'POLICY_DENIED')
  assert.equal(failure(request(root, 'batch', { action: 'plan', operations: [{ op: 'remove', path: '../outside' }] })), 'INVALID_ARGUMENT')
  assert.equal(failure(request(root, 'batch', { action: 'plan', operations: [{ op: 'remove', path: path.join(root, 'planned.txt') }] })), 'INVALID_ARGUMENT')

  // Audit storage is reserved: no operation may address it.
  const manifest = storeFiles(root).find(name => name.startsWith(job) && name.endsWith('.json'))
  const reserved = request(root, 'batch', { action: 'run', operations: [{ op: 'remove', path: `.dsh-ops/${manifest}` }] })
  assert.equal(failure(reserved), 'POLICY_DENIED')
  assert.equal(fs.existsSync(path.join(root, '.dsh-ops', manifest)), true)

  // Job audits are pageable and read-only by design.
  const page = request(root, 'result', { action: 'page', id: job })
  assert.equal(page.error, undefined, JSON.stringify(page))
  assert.equal(page.items.length >= 1, true, 'a job page lists its items')
  assert.equal(page.id, job)
  assert.equal(failure(request(root, 'result', { action: 'release', id: job })), 'POLICY_DENIED', 'job audit records cannot be released')
}))

// ── 3. Host bridge: policy layer ──────────────────────────────────────────────
test('bridge policy: write roots, read-only gating, no-follow, session scope', () => withTempDir('bridge-policy', async root => {
  const ws = path.join(root, 'ws')
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'src', 'a.txt'), 'alpha\n')
  fs.writeFileSync(path.join(root, 'outside.txt'), 'ORIGINAL')

  await withBridge({ mode: 'workspace-write', workspaceRoot: ws }, async bridge => {
    const inside = await bridge.file('replace', { path: 'src/a.txt', pattern: 'alpha', replacement: 'ALPHA' })
    assert.equal(inside.status, 'completed', JSON.stringify(inside))
    assert.equal(fs.readFileSync(path.join(ws, 'src', 'a.txt'), 'utf8'), 'ALPHA\n')

    const job = await bridge.ptc('batch', { action: 'run', operations: [{ op: 'copy', path: 'src/a.txt', to: 'copy.txt' }] })
    assert.equal(job.status, 'completed')
    const ownPage = await bridge.ptc('result', { action: 'page', id: job.id })
    assert.equal(ownPage.error, undefined, JSON.stringify(ownPage))
    assert.equal(ownPage.items.length >= 1, true, 'the owning session can page the job')
    assert.equal(failure(await bridge.ptc('result', { action: 'page', id: job.id }, 'other-session')), 'POLICY_DENIED')

    // A write outside the workspace is refused unless the fixture sits inside a
    // legitimate write root: `write_roots` includes the platform temp directory,
    // so a fixture created there is allowed (see issue #76 for why a temp
    // directory equal to a home directory matters).
    const escaped = await bridge.file('replace', { path: '../outside.txt', pattern: 'ORIGINAL', replacement: 'HACKED' })
    const tempIsAncestor = path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)
    if (tempIsAncestor) {
      console.log('note: fixture is under the platform temp directory (a write root); skipping the escape denial check')
    } else {
      assert.equal(failure(escaped), 'POLICY_DENIED')
      assert.equal(fs.readFileSync(path.join(root, 'outside.txt'), 'utf8'), 'ORIGINAL')
    }

    // Symlinked entries are refused at every level, so a swap cannot redirect an
    // operation — the property that keeps a classic TOCTOU race inside the root.
    let linked = true
    try { fs.symlinkSync(path.join(root, 'outside.txt'), path.join(ws, 'link.txt')) } catch { linked = false }
    if (linked) {
      assert.equal(failure(await bridge.file('inspect_local_file', { path: 'link.txt' })), 'POLICY_DENIED')
      assert.equal(failure(await bridge.file('glob', { path: 'link.txt', pattern: ['**/*'] })), 'POLICY_DENIED')
    } else {
      console.log('note: this account cannot create symlinks; skipping the no-follow checks')
    }
  })

  await withBridge({ mode: 'read-only', workspaceRoot: ws }, async bridge => {
    assert.equal(failure(await bridge.file('replace', { path: 'src/a.txt', pattern: 'ALPHA', replacement: 'x' })), 'POLICY_DENIED')
    assert.equal(failure(await bridge.ptc('batch', { action: 'run', operations: [{ op: 'copy', path: 'src/a.txt', to: 'y' }] })), 'POLICY_DENIED')
  })
}))

report('worker acceptance')
