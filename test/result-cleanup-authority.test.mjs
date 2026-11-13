/** Cleanup readmission keeps the existing grant and refuses every unavailable authority. */
import fs from 'node:fs'
import path from 'node:path'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { resultStorage } from '../lib/kernel/result-storage.js'
import { expireResultSession, retryDeferredResultCleanup } from '../lib/kernel/result-lifecycle.js'
import { listPendingCleanup, setCleanupRegistryDir } from '../lib/kernel/result-cleanup-registry.js'

const completed = { exitCode: 0, interrupted: false, readers: true, lossy: false, stderr: '', value: { status: 'completed' } }
async function fixture(root, missing = false) {
  const session = { id: root, header: { cwd: root } }, calls = [], file = path.join(root, 'worker')
  const initial = { mode: 'workspace-write', workspaceRoot: root, sessionId: session.id }
  let current = initial, grantRoot = path.join(root, 'cache'), sid = 'S-1-4-123-456-1', duringPrepare
  fs.mkdirSync(grantRoot)
  const client = { file, async purgeResults(...args) { calls.push(args); return completed } }
  const sandbox = { async confine(argv) {
    duringPrepare?.()
    return { argv: ['runner', '--temp', grantRoot, '--temp-write-sid', sid, '--', ...argv], enforcement: 'partial' }
  } }
  const ctx = { get(name) {
    if (name === 'subprocess') assert.fail('cleanup must never use a public one-shot subprocess')
    return { opsKernel: missing ? undefined : client, sandboxPolicy: { resolve: () => current }, sandbox }[name]
  } }
  const storage = await resultStorage(ctx, session, undefined, file, 'result', initial, [], false)
  assert.ok(storage)
  return { ctx, client, session, storage, calls, initial,
    policy(value) { current = value }, grant(value) { grantRoot = value }, sid(value) { sid = value },
    prepare(callback) { duringPrepare = callback },
    restore() { current = initial; grantRoot = path.join(root, 'cache'); sid = 'S-1-4-123-456-1'; duringPrepare = undefined; client.file = file },
  }
}

await test('cleanup sends only the existing typed purge inputs to the resident client', () => withTempDir('cleanup-inputs', async root => {
  setCleanupRegistryDir(path.join(root, 'registry'))
  try {
    const f = await fixture(root)
    await expireResultSession(f.ctx, f.session)
    assert.equal(f.calls.length, 1)
    const [workspace, scope, storage, signal] = f.calls[0]
    assert.equal(workspace, root); assert.equal(scope, f.session.id); assert.deepEqual(storage, f.storage)
    assert.ok(signal instanceof AbortSignal); assert.equal(signal.aborted, false)
    assert.deepEqual(listPendingCleanup(), [])
  } finally { setCleanupRegistryDir(undefined) }
}))

const refusals = [
  ['read-only', f => f.policy({ ...f.initial, mode: 'read-only' })],
  ['changed workspace', f => f.policy({ ...f.initial, workspaceRoot: path.dirname(f.initial.workspaceRoot) })],
  ['changed extra write roots', f => f.policy({ ...f.initial, additionalWritableRoots: [path.dirname(f.initial.workspaceRoot)] })],
  ['mismatched worker identity', f => { f.client.file += '-other' }],
  ...(process.platform === 'win32' ? [
    ['changed session identity', f => f.policy({ ...f.initial, sessionId: 'other' })],
    ['changed cache root', f => f.grant(path.dirname(f.initial.workspaceRoot))],
    ['changed cache SID', f => f.sid('S-1-4-123-457-1')],
    ['policy changes during preparation', f => f.prepare(() => f.policy({ ...f.initial, mode: 'read-only' }))],
  ] : []),
]
for (const [name, change] of refusals) await test(`${name} refuses purge and retains a deferred cleanup record`, () => withTempDir('cleanup-denied', async root => {
  setCleanupRegistryDir(path.join(root, 'registry'))
  let f
  try {
    f = await fixture(root); change(f)
    await expireResultSession(f.ctx, f.session)
    assert.equal(f.calls.length, 0)
    assert.equal(listPendingCleanup().length, 1)
    f.restore()
    const retry = await retryDeferredResultCleanup(f.ctx, Date.now() + 60000)
    assert.equal(retry.completed, 1); assert.equal(f.calls.length, 1)
    assert.deepEqual(listPendingCleanup(), [])
  } finally { if (f) { f.restore(); await retryDeferredResultCleanup(f.ctx, Date.now() + 120000) } setCleanupRegistryDir(undefined) }
}))
for (const [name, outcome] of [
  ['lost transport', () => { throw new Error('Resident kernel connection lost') }],
  ['unconfirmed outcome', () => ({ ...completed, interrupted: true, exitCode: null })],
  ['partial native purge', () => ({ ...completed, value: { status: 'error', error: { code: 'CACHE_PURGE_FAILED', effectState: 'partial' } } })],
]) await test(`${name} is deferred without replay or one-shot fallback`, () => withTempDir('cleanup-failed', async root => {
  setCleanupRegistryDir(path.join(root, 'registry'))
  const f = await fixture(root)
  let attempts = 0
  try {
    f.client.purgeResults = async () => { attempts++; return outcome() }
    await expireResultSession(f.ctx, f.session)
    assert.equal(attempts, 1); assert.equal(listPendingCleanup().length, 1)
    f.client.purgeResults = async () => completed
    assert.equal((await retryDeferredResultCleanup(f.ctx, Date.now() + 60000)).completed, 1)
  } finally { setCleanupRegistryDir(undefined) }
}))
await test('missing owning provider is deferred without creating a replacement worker', () => withTempDir('cleanup-missing', async root => {
  setCleanupRegistryDir(path.join(root, 'registry'))
  try {
    const f = await fixture(root, true)
    await expireResultSession(f.ctx, f.session)
    assert.equal(f.calls.length, 0); assert.equal(listPendingCleanup().length, 1)
  } finally { setCleanupRegistryDir(undefined) }
}))
report('result-cleanup-authority')
