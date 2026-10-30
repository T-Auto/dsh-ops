import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'
import { definition } from '../lib/file/contract.js'
import { exposePosixCache, windowsCacheLocation, resultStorage } from '../lib/kernel/result-storage.js'
import { mountResultLifecycle, expireResultSession } from '../lib/kernel/result-lifecycle.js'
import { invoke } from '../lib/ptc/worker.js'
import { invokeResult } from '../lib/file/result.js'

requireWorker('result-storage-host')
await test('Native result defaults to live cwd and explicit original roots retain reference authority after cd', () => withTempDir('reference-live-cwd', async root => {
  const { ctx } = await bootHost(), session = { id: 'reference-live-cwd', header: { cwd: root } }, agent = { session }
  const live = path.join(root, 'tools'); fs.mkdirSync(live)
  let cwd = live, ensures = 0
  const signal = new AbortController().signal, exec = { agent, signal }
  try {
    await ctx.plugin(Subprocess); await ctx.plugin(Sandbox)
    await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root, sessionId: session.id }) }))
    await ctx.plugin(inner => mountResultLifecycle(inner))
    await ctx.plugin(inner => inner.provide('workingDirectory', { async ensure() { ensures++; return cwd }, get: () => cwd }))
    const put = await invoke(ctx, WORKER, 'result', { root: live, action: 'put', items: [{ value: 'live snapshot' }] }, exec, signal)
    assert.equal(put.status, 'completed', JSON.stringify(put))
    const call = args => invokeResult(ctx, WORKER, args, exec, signal, {})
    const page = await call({ action: 'page', id: put.id })
    assert.deepEqual(page.items, [{ value: 'live snapshot' }], JSON.stringify(page)); assert.equal(ensures, 1)
    cwd = root
    assert.equal((await call({ action: 'page', id: put.id })).error.code, 'POLICY_DENIED')
    assert.deepEqual((await call({ root: live, action: 'page', id: put.id })).items, [{ value: 'live snapshot' }])
    assert.equal(ensures, 2, 'explicit reference root does not depend on a live directory lookup')
    assert.equal((await call({ root: live, action: 'release', id: put.id })).status, 'released')
  } finally { await shutdown(ctx) }
}))
await test('cache flags accept only the trusted runner section and private-temp capability family', () => {
  const root = 'C:\\private\\cache', sid = 'S-1-4-123-456-1'
  assert.deepEqual(windowsCacheLocation(['runner', '--temp', root, '--temp-write-sid', sid, '--', 'worker']), { root, windowsWriteSid: sid })
  for (const bad of ['S-1-1-0', 'S-1-5-5-1-2', 'S-1-4-0-1-1', 'S-1-4-01-2-1', 'S-1-4-1073741824-2-1', 'S-1-4-1-2-2']) {
    assert.equal(windowsCacheLocation(['runner', '--temp', root, '--temp-write-sid', bad, '--', 'worker']), undefined)
  }
  assert.equal(windowsCacheLocation(['runner', '--', 'worker', '--temp', root, '--temp-write-sid', sid]), undefined)
  assert.equal(windowsCacheLocation(['runner', '--temp', root, '--temp', root, '--temp-write-sid', sid, '--', 'worker']), undefined)
  assert.equal(windowsCacheLocation(['runner', '--temp', 'relative', '--temp-write-sid', sid, '--', 'worker']), undefined)
})

await test('real host references bind live session, current authority and producer visibility; disposal purges only cache blobs', async () => {
  await withTempDir('storage-host', async root => {
    const { ctx } = await bootHost(), session = { id: 'host-reference-owner', header: { cwd: root } }, scope = { session }
    let mode = 'workspace-write', calls = 0
    try {
      await ctx.plugin(Subprocess); await ctx.plugin(Sandbox)
      await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: () => ({ mode, workspaceRoot: root, sessionId: session.id }) }))
      await ctx.plugin(inner => mountResultLifecycle(inner))
      const registration = await ctx.plugin(inner => {
        inner.inject(['tools'], scoped => { scoped.tools.register(definition('grep', async () => ({ status: 'completed' }))) })
      })
      const policy = () => ctx.get('sandboxPolicy').resolve({ session })
      const metadata = await resultStorage(ctx, session, undefined, WORKER, 'result', policy(), [], false)
      assert.ok(metadata, 'real host must provide private storage')
      assert.deepEqual(metadata.allowedTools, ['grep', 'result'])
      await registration.dispose()
      const hidden = await resultStorage(ctx, session, undefined, WORKER, 'result', policy(), [], false)
      assert.deepEqual(hidden.allowedTools, ['result']); assert.equal(hidden.authorityId, metadata.authorityId)
      const deniedRoots = await resultStorage(ctx, session, undefined, WORKER, 'result', policy(), [path.join(root, 'private')], false)
      assert.notEqual(deniedRoots.authorityId, metadata.authorityId)
      const call = args => { calls++; return invoke(ctx, WORKER, 'result', args, { agent: scope }, undefined, { denyCredentialReads: false }) }
      const stored = await call({ action: 'put', items: [{ value: 'snapshot' }] })
      assert.equal(stored.status, 'completed', JSON.stringify(stored)); assert.match(stored.id, /^ref:\/\//)
      assert.deepEqual((await call({ action: 'page', id: stored.id })).items, [{ value: 'snapshot' }])
      const cache = path.join(metadata.root, `s-${createHash('sha256').update(session.id).digest('hex')}`)
      const blob = path.join(cache, stored.id.split('/').at(-1) + '.json')
      assert.equal(fs.existsSync(blob), true)
      const original = fs.readFileSync(blob), modified = fs.statSync(blob).mtimeMs
      mode = 'read-only'
      const narrowed = await call({ action: 'page', id: stored.id })
      assert.equal(narrowed.error.code, 'POLICY_DENIED', JSON.stringify(narrowed))
      assert.deepEqual(fs.readFileSync(blob), original); assert.equal(fs.statSync(blob).mtimeMs, modified)
      mode = 'workspace-write'
      assert.equal((await call({ action: 'page', id: stored.id })).complete, true)
      assert.equal((await call({ action: 'purge' })).error.code, 'INVALID_ARGUMENT')
      assert.equal(fs.existsSync(blob), true)
      fs.mkdirSync(path.join(root, '.dsh-ops')); fs.writeFileSync(path.join(root, '.dsh-ops', 'audit'), 'durable')
      await expireResultSession(ctx, session)
      assert.equal(fs.existsSync(blob), false)
      assert.equal(fs.readFileSync(path.join(root, '.dsh-ops', 'audit'), 'utf8'), 'durable')
      assert.equal(fs.existsSync(path.join(cache, 'lock')), true)
      assert.equal(calls, 5)
    } finally { await shutdown(ctx) }
  })
})

await test('only a bwrap private /tmp gains a bind for the one session cache, before the wrapped program', () => {
  const storage = { root: '/tmp/dsh-ops-results-abc', authorityId: 'a', allowedTools: ['result'] }
  const bwrap = ['/usr/bin/bwrap', '--ro-bind', '/', '/', '--tmpfs', '/tmp', '--bind', '/w', '/w', '--', 'worker']
  assert.deepEqual(exposePosixCache(bwrap, storage),
    ['/usr/bin/bwrap', '--ro-bind', '/', '/', '--tmpfs', '/tmp', '--bind', '/w', '/w', '--bind', storage.root, storage.root, '--', 'worker'])
  assert.deepEqual(exposePosixCache(['bwrap', '--ro-bind', '/', '/', '--', 'worker'], storage), ['bwrap', '--ro-bind', '/', '/', '--', 'worker'])
  assert.deepEqual(exposePosixCache(['bwrap', '--', 'worker', '--tmpfs', '/tmp'], storage), ['bwrap', '--', 'worker', '--tmpfs', '/tmp'])
  assert.deepEqual(exposePosixCache(['landlock-run', '--rw', '/tmp', '--', 'worker'], storage), ['landlock-run', '--rw', '/tmp', '--', 'worker'])
  assert.deepEqual(exposePosixCache(bwrap, undefined), bwrap)
  assert.deepEqual(exposePosixCache(bwrap, { ...storage, windowsWriteSid: 'S-1-4-1-2-1' }), bwrap)
  assert.deepEqual(exposePosixCache(bwrap, { ...storage, root: 'relative' }), bwrap)
  // The single-token form mounts the same private tmpfs and must gain the same bind.
  assert.deepEqual(exposePosixCache(['/usr/bin/bwrap', '--tmpfs=/tmp', '--', 'worker'], storage),
    ['/usr/bin/bwrap', '--tmpfs=/tmp', '--bind', storage.root, storage.root, '--', 'worker'])
})

// Windows has no bwrap runner and keeps its cache in the runner's own --temp grant (checked above).
if (process.platform !== 'win32') await test('the worker argv binds the session cache before the wrapped program', async () => {
  await withTempDir('storage-bwrap', async root => {
    const runner = path.join(root, 'runner'), log = path.join(runner, 'argv.log'), shim = path.join(runner, 'bwrap')
    fs.mkdirSync(runner)
    // Records each runner argv, then runs the wrapped program after the separator. The shim does not
    // reproduce bwrap's private tmpfs, so this asserts the argv composition bwrap needs (the cache bind
    // last, before the separator), not in-sandbox visibility.
    fs.writeFileSync(shim, `#!/bin/sh\nfor a in "$@"; do printf '%s\\037' "$a"; done >> '${log}'\necho >> '${log}'\n`
      + 'while [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 })
    const { ctx } = await bootHost(), session = { id: 'bwrap-private-tmp', header: { cwd: root } }
    try {
      await ctx.plugin(Subprocess)
      await ctx.plugin(inner => inner.provide('sandbox', { confine: async argv => ({ enforcement: 'full', runnerFailureRules: [],
        argv: [shim, '--ro-bind', '/', '/', '--tmpfs', '/tmp', '--bind', root, root, '--', ...argv] }) }))
      await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root, sessionId: session.id }) }))
      await ctx.plugin(inner => mountResultLifecycle(inner))
      const call = args => invoke(ctx, WORKER, 'result', args, { agent: { session } }, undefined, { denyCredentialReads: false })
      const stored = await call({ action: 'put', items: [{ value: 'kept' }] })
      assert.equal(stored.status, 'completed', JSON.stringify(stored))
      assert.deepEqual((await call({ action: 'page', id: stored.id })).items, [{ value: 'kept' }])
      const cacheRoot = (await resultStorage(ctx, session, undefined, WORKER, 'result', ctx.get('sandboxPolicy').resolve({ session }), [], false)).root
      await expireResultSession(ctx, session)
      const runs = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => line.split('\x1f').slice(0, -1))
      assert.equal(runs.length, 3, 'put, page and the session purge each run through the runner')
      for (const argv of runs) {
        const separator = argv.indexOf('--'), bind = argv.lastIndexOf(cacheRoot, separator)
        assert.ok(bind > 0 && argv[bind - 2] === '--bind' && argv[bind - 1] === cacheRoot && bind === separator - 1, argv.join(' '))
      }
    } finally { await shutdown(ctx) }
  })
})

await test('read-only first use cannot create result storage or invoke a cache-preparation provider', async () => {
  await withTempDir('storage-readonly', async root => {
    const { ctx } = await bootHost(), session = { id: 'read-only-first', header: { cwd: root } }
    try {
      await ctx.plugin(inner => inner.provide('sandbox', { confine() { assert.fail('read-only must not prepare a writable cache') } }))
      const value = await resultStorage(ctx, session, undefined, WORKER, 'result', { mode: 'read-only', workspaceRoot: root, sessionId: session.id }, [], false)
      assert.equal(value, undefined); assert.deepEqual(fs.readdirSync(root), [])
      await expireResultSession(ctx, session)
    } finally { await shutdown(ctx) }
  })
})
report('result-storage-host')
