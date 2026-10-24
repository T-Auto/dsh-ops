/** Authority regressions: real host/services, with controlled policy snapshots only for races. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { createScope } from '@deepseek-ai/dsh-scope'
import { assert, test, report, withTempDir, skipSuite, waitFor } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { invoke as fileCall } from '../lib/file/worker.js'
import { invoke as ptcCall } from '../lib/ptc/worker.js'
import { tryResolveWorker } from '../lib/ptc/runtime.js'
import { mountSessionBash } from '../lib/session-shells.js'
import { bashToolDefinition, renderBashResult } from '../lib/shells.js'
import { normalizeNativeDenial } from '../lib/permissions.js'
import { anchoredPath } from '../lib/authority-paths.js'
import { sessionTempDir, ensureSessionTemp } from '../lib/session-temp.js'

const signal = () => new AbortController().signal
// SessionStore keeps one exact Session object throughout a live session, including mode changes.
const sessions = new Map()
const execution = root => {
  if (!sessions.has(root)) sessions.set(root, { id: 'authority-test', header: { cwd: root } })
  return { agent: { session: sessions.get(root) }, signal: signal() }
}
const writeArgs = file => ({ path: file, content: 'new', expectedRevision: 'absent' })

await test('native normalization requires a recognized stable reason and preserves effect facts', () => {
  const policy = { mode: 'workspace-write', workspaceRoot: process.cwd() }
  for (const reason of [undefined, 'future-reason']) {
    const value = { status: 'error', error: { code: 'POLICY_DENIED', reason, effectState: 'applied' } }
    assert.equal(normalizeNativeDenial(value, policy, 'copy', 'workspace-write'), value)
  }
  for (const code of ['PATH_RESTRICTED', 'CREDENTIAL_DENIED', 'METADATA_UNSUPPORTED']) {
    const value = { status: 'error', error: { code, reason: 'write-roots' } }
    assert.equal(normalizeNativeDenial(value, policy, 'copy', 'workspace-write'), value)
  }
  for (const reason of ['read-only', 'write-roots']) {
    const value = normalizeNativeDenial({ status: 'error', changed: 1, error: {
      code: 'POLICY_DENIED', reason, phase: 'publish', effectState: 'applied', retryable: true,
    } }, policy, 'move', 'workspace-write')
    assert.equal(value.error.permission.current, 'workspace-write')
    assert.equal(value.error.permission.required, reason === 'write-roots' ? 'danger-full-access' : 'workspace-write')
    assert.equal(value.error.permission.operation, 'move')
    assert.equal(value.error.effectState, 'applied'); assert.equal(value.error.phase, 'publish')
    assert.equal(value.changed, 1); assert.equal(value.error.retryable, false)
    assert.match(value.error.nextAction, /Do not retry.*bypass/)
  }
})

await test('untrusted native reason shapes never invent permission advice or lose execution facts', () => {
  const policy = { mode: 'workspace-write', workspaceRoot: process.cwd() }
  for (const value of [undefined, null, 0, 'error', [], {}, { error: null }, { error: [] },
    { error: { code: 'POLICY_DENIED', reason: ['write-roots'] } },
    { error: { code: 'POLICY_DENIED', reason: { toString: () => 'write-roots' } } }]) {
    assert.equal(normalizeNativeDenial(value, policy, 'copy'), value)
  }
  const value = { status: 'error', changed: 1, receipt: { complete: false }, error: {
    code: 'POLICY_DENIED', reason: 'write-roots', phase: 'publish', effectState: 'partial', customReceipt: { written: 1 },
  } }
  const normalized = normalizeNativeDenial(value, policy, 'copy')
  assert.equal(normalized.receipt, value.receipt)
  assert.equal(normalized.error.customReceipt, value.error.customReceipt)
  assert.equal(normalized.error.phase, 'publish'); assert.equal(normalized.error.effectState, 'partial')
  assert.equal(normalized.error.permission.required, 'danger-full-access')
  assert.equal(value.status, 'error', 'normalization never mutates the original worker result')
})

await test('missing sessions and credentials are not selector authorization failures', async () => {
  for (const call of [fileCall, ptcCall]) {
    const value = await call({}, 'unused', 'stat', {}, {}, signal())
    assert.equal(value.error.code, 'EXECUTOR_UNAVAILABLE')
    assert.equal(value.error.permission, undefined)
  }
  await withTempDir('authority-credential', async root => {
    const { ctx } = await bootHost()
    try {
      await ctx.plugin(Subprocess)
      await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) }))
      const value = await fileCall(ctx, 'unused', 'stat', { path: '.env' }, execution(root), signal())
      assert.equal(value.error.code, 'CREDENTIAL_DENIED')
      assert.equal(value.error.permission, undefined)
      assert.match(value.error.nextAction, /selector does not remove/)
    } finally { await shutdown(ctx) }
  })
})

await test('file snapshot changes distinguish actual insufficiency from still-allowed requests', async () => {
  await withTempDir('authority-race', async root => {
    const { ctx } = await bootHost()
    let mode = 'danger-full-access', next = 'workspace-write', resolves = 0, spawned = 0
    try {
      await ctx.plugin(inner => inner.provide('subprocess', { spawn() { spawned++; throw new Error('must not spawn') } }))
      await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: () => ({ mode: ++resolves === 1 ? mode : next, workspaceRoot: root }) }))
      const outside = path.join(path.dirname(root), 'external.txt')
      for (const [initial, current, tool, args, code, required] of [
        ['danger-full-access', 'workspace-write', 'write_file', writeArgs(outside), 'POLICY_DENIED', 'danger-full-access'],
        ['workspace-write', 'read-only', 'write_file', writeArgs('local.txt'), 'POLICY_DENIED', 'workspace-write'],
        ['danger-full-access', 'workspace-write', 'write_file', writeArgs('local.txt'), 'AUTHORITY_CHANGED'],
        ['danger-full-access', 'read-only', 'stat', { path: 'local.txt' }, 'AUTHORITY_CHANGED'],
      ]) {
        mode = initial; next = current; resolves = 0
        const value = await fileCall(ctx, 'unused', tool, args, execution(root), signal())
        assert.equal(value.error.code, code, JSON.stringify(value))
        assert.equal(value.error.permission?.required, required)
        if (required) {
          assert.equal(value.error.permission.current, current)
          assert.equal(value.error.permission.operation, tool)
          assert.match(value.error.nextAction, /Do not retry.*bypass/)
        }
      }
      assert.equal(spawned, 0)
    } finally { await shutdown(ctx) }
  })
})

await test('PTC stderr restrictions do not prove selector denial; runner failure stays infrastructure', async () => {
  await withTempDir('authority-ptc', async root => {
    const { ctx } = await bootHost()
    let stderr = 'permission denied', exitCode = 1
    try {
      await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: () => ({ mode: 'read-only', workspaceRoot: root }) }))
      await ctx.plugin(inner => inner.provide('sandbox', { confine: async argv => ({ argv, enforcement: 'full', denialSignatures: ['permission denied'], runnerFailureRules: [{ fatalSignatures: ['runner failed'] }] }) }))
      await ctx.plugin(inner => inner.provide('subprocess', { spawn: () => ({ done: Promise.resolve({ exitCode }), collected: {
        stdout: { readFrom: () => ({ text: '', lossy: false }) }, stderr: { readFrom: () => ({ text: stderr, lossy: false }) },
      } }) }))
      const call = () => ptcCall(ctx, 'unused', 'result', { action: 'page' }, execution(root), signal())
      let value = await call()
      assert.equal(value.error.code, 'EXECUTION_RESTRICTED')
      assert.equal(value.error.effectState, 'unknown'); assert.equal(value.error.permission, undefined)
      assert.match(value.error.nextAction, /Inspect.*Do not blindly retry/)
      stderr = 'runner failed: permission denied'
      value = await call()
      assert.equal(value.error.code, 'EXECUTOR_UNAVAILABLE'); assert.equal(value.error.effectState, 'none')
    } finally { await shutdown(ctx) }
  })
})

await test('PTC canonical containment rejects an external linked root without rewriting root selection', async () => {
  await withTempDir('authority-ptc-root', async base => {
    const root = path.join(base, 'workspace'), outside = path.join(base, 'outside')
    fs.mkdirSync(root); fs.mkdirSync(outside)
    const link = path.join(root, 'linked'); fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    const { ctx } = await bootHost()
    let mode = 'workspace-write', spawned = 0, received
    try {
      await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: () => ({ mode, workspaceRoot: root }) }))
      await ctx.plugin(inner => inner.provide('sandbox', { confine: async argv => ({ argv, enforcement: 'full' }) }))
      await ctx.plugin(inner => inner.provide('subprocess', { spawn: spec => {
        spawned++; received = JSON.parse(spec.stdio.stdin.data)
        return { done: Promise.resolve({ exitCode: 0 }), collected: {
          stdout: { readFrom: () => ({ text: '{"status":"completed"}', lossy: false }) }, stderr: { readFrom: () => ({ text: '', lossy: false }) },
        } }
      } }))
      let value = await ptcCall(ctx, 'unused', 'result', { root: link, action: 'page' }, execution(root), signal())
      assert.equal(value.error.code, 'POLICY_DENIED'); assert.equal(value.error.permission.required, 'danger-full-access')
      assert.equal(spawned, 0)
      for (const current of ['read-only', 'danger-full-access']) {
        mode = current
        value = await ptcCall(ctx, 'unused', 'result', { root: link, action: 'page' }, execution(root), signal())
        assert.equal(value.status, 'completed', JSON.stringify(value)); assert.equal(received.request.root, link)
      }
    } finally { await shutdown(ctx) }
  })
})

await test('PTC preparation snapshot changes stop before spawn without inventing insufficiency', async () => {
  await withTempDir('authority-ptc-race', async root => {
    const { ctx } = await bootHost()
    let mode = 'read-only', spawned = 0
    try {
      await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: () => ({ mode, workspaceRoot: root }) }))
      await ctx.plugin(inner => inner.provide('sandbox', { confine: async argv => { mode = 'danger-full-access'; return { argv, enforcement: 'full' } } }))
      await ctx.plugin(inner => inner.provide('subprocess', { spawn() { spawned++; throw new Error('must not spawn') } }))
      const value = await ptcCall(ctx, 'unused', 'result', { action: 'page' }, execution(root), signal())
      assert.equal(value.error.code, 'AUTHORITY_CHANGED'); assert.equal(value.error.permission, undefined)
      assert.equal(spawned, 0)
    } finally { await shutdown(ctx) }
  })
})

await test('both worker bridges normalize only typed native authorization and retain applied effects', async () => {
  await withTempDir('authority-native-errors', async root => {
    const { ctx } = await bootHost()
    let result
    try {
      await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) }))
      await ctx.plugin(inner => inner.provide('subprocess', { spawn: () => ({ done: Promise.resolve({ exitCode: 0 }), collected: {
        stdout: { readFrom: () => ({ text: JSON.stringify(result), lossy: false }) }, stderr: { readFrom: () => ({ text: '', lossy: false }) },
      } }) }))
      for (const [call, tool, args] of [[fileCall, 'stat', { path: 'data.txt' }], [ptcCall, 'result', { action: 'page' }]]) {
        for (const reason of [undefined, 'future-reason', 'write-roots']) {
          result = { status: 'error', changed: 1, error: { code: 'POLICY_DENIED', reason, phase: 'publish', effectState: 'applied' } }
          const value = await call(ctx, 'unused', tool, args, execution(root), signal())
          assert.equal(value.error.effectState, 'applied'); assert.equal(value.changed, 1)
          assert.equal(value.error.permission?.required, reason === 'write-roots' ? 'danger-full-access' : undefined)
        }
      }
    } finally { await shutdown(ctx) }
  })
})

await test('Bash cancellation is failed even if process returns zero, and renders cancellation', async () => {
  const controller = new AbortController()
  const tool = bashToolDefinition({ file: process.execPath, source: 'config', subprocess: { spawn() {
    controller.abort()
    return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
  } } })
  const value = await tool.execute({ command: 'unused' }, { signal: controller.signal })
  assert.equal(value.exitCode, 0); assert.equal(value.cancelled, true); assert.equal(value.status, 'failed')
  assert.match(renderBashResult(value), /\[cancelled\]/)
})

await test('Bash stops on a middle-preparation authority change using the real scoped registry', async () => {
  await withTempDir('authority-bash', async root => {
    const { ctx } = await bootHost()
    const agent = execution(root).agent
    const scope = createScope(ctx, agent); agent.ctx = scope.ctx
    let race = false, resolves = 0, spawned = 0
    try {
      await ctx.plugin(inner => inner.provide('subprocess', { spawn() { spawned++; throw new Error('must not spawn') } }))
      await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: () => ({ mode: race && ++resolves > 1 ? 'workspace-write' : 'danger-full-access', workspaceRoot: root }) }))
      await ctx.plugin({ inject: ['tools'], apply(inner) { mountSessionBash(inner, { publishBashTool: true }, { bash: { available: true, file: process.execPath, source: 'config' } }) } })
      await ctx.serial('agent/created', { agent })
      await waitFor(() => ctx.get('tools').get('ops_bash', agent), { what: 'deferred Bash publication' })
      const tool = ctx.get('tools').get('ops_bash', agent)
      assert.ok(tool)
      race = true
      const value = await tool.execute({ description: 'Check current session authority', command: 'unused', workdir: root }, { agent, signal: signal() })
      assert.equal(value.status, 'failed'); assert.match(value.error, /AUTHORITY_CHANGED/)
      assert.equal(value.permission, undefined); assert.equal(spawned, 0)
      const missing = await tool.execute({ description: 'Check missing session authority', command: 'unused' }, { signal: signal() })
      assert.match(missing.error, /EXECUTOR_UNAVAILABLE/); assert.equal(missing.status, 'failed')
    } finally { await scope.dispose(); await shutdown(ctx) }
  })
})

await test('trusted anchors rewrite aliases without erasing descendant links, and temp never widens', async () => {
  await withTempDir('authority-anchor', async root => {
    const real = path.join(root, 'real'), alias = path.join(root, 'alias')
    fs.mkdirSync(real); fs.symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
    fs.mkdirSync(path.join(real, 'child'))
    const link = path.join(real, 'descendant'); fs.symlinkSync(path.join(real, 'child'), link, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(anchoredPath(path.join(alias, 'descendant', 'new.txt'), [alias]), path.join(real, 'descendant', 'new.txt'))
    assert.notEqual(ensureSessionTemp(path.join(alias, 'descendant')).ok, true)
    const longRoot = path.join(root, 'x'.repeat(220))
    assert.notEqual(sessionTempDir('long-id', longRoot), longRoot)
  })
})

const attempt = tryResolveWorker()
if (!attempt.ok) {
  if (process.env.DSH_OPS_REQUIRE_RUNTIME === '1') throw new Error(attempt.reason)
  skipSuite('authority', attempt.reason)
}
await test('real worker accepts trusted workspace aliases for reads/create/copy/move and retains descendant no-follow', async () => {
  await withTempDir('authority-native', async root => {
    const real = path.join(root, 'real'), alias = path.join(root, 'alias')
    fs.mkdirSync(real); fs.symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
    fs.writeFileSync(path.join(real, 'source.txt'), 'source')
    const { ctx } = await bootHost()
    let mode = 'workspace-write'
    try {
      await ctx.plugin(Subprocess)
      await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: () => ({ mode, workspaceRoot: alias }) }))
      const call = (tool, args) => fileCall(ctx, attempt.file, tool, args, execution(alias), signal())
      for (const current of ['read-only', 'workspace-write', 'danger-full-access']) {
        mode = current
        const read = await call('inspect_local_file', { path: 'source.txt' })
        assert.equal(read.status, 'completed', JSON.stringify(read))
      }
      mode = 'workspace-write'
      const created = await call('write_file', writeArgs('created.txt'))
      assert.equal(created.status, 'completed', JSON.stringify(created))
      const revision = createHash('sha256').update('source').digest('hex')
      const copied = await call('copy', { path: 'source.txt', to: path.join(alias, 'copy.txt'), expectedRevision: revision })
      assert.equal(copied.status, 'completed', JSON.stringify(copied))
      assert.equal(fs.readFileSync(path.join(real, 'copy.txt'), 'utf8'), 'source')
      const moved = await call('move', { path: 'source.txt', to: path.join(alias, 'moved.txt'), expectedRevision: revision })
      assert.equal(moved.status, 'completed', JSON.stringify(moved))
      fs.symlinkSync(real, path.join(real, 'child-link'), process.platform === 'win32' ? 'junction' : 'dir')
      const refused = await call('write_file', writeArgs(path.join(alias, 'child-link', 'blocked.txt')))
      assert.notEqual(refused.status, 'completed', JSON.stringify(refused))
      assert.equal(refused.error.permission, undefined)
      assert.ok(!fs.existsSync(path.join(real, 'blocked.txt')))
    } finally { await shutdown(ctx) }
  })
})
report('authority')
