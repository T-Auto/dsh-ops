/** Real registry/source lifetimes after discovery initialization and settings failures. */
import fs from 'node:fs'
import path from 'node:path'
import { createScope } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import { mountDiscovery } from '../lib/discovery/controller.js'
import { pendingSelection } from '../lib/discovery/observations.js'
import { acquireSharedFile } from '../lib/publication/scope-owner.js'
import { Config } from '../lib/components/discovery/index.js'
import { WORKER_TIMEOUT_MS } from '../lib/execution/protocol.js'
import { publicToolName } from '../lib/policy.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { executeCall, prepareStep } from './lib/executor.mjs'
import { profileFixture } from './lib/settings-profile.mjs'
import { assert, test, report, waitFor, withTempDir } from './lib/harness.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'
requireWorker('discovery-attachment')

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)) }
const STAT_TOOL = publicToolName('stat'), DISCOVER_TOOL = publicToolName('discover_tools'), GLOB_TOOL = publicToolName('glob')
async function services(ctx, dir) {
  for (const plugin of [Subprocess, Sandbox, FileSystem]) await ctx.plugin(plugin)
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: dir }) })
}
function mint(ctx, dir) {
  const agent = { id: 'discovery-attachment', session: { id: 'discovery-attachment', header: { cwd: dir }, append() {}, read() { return [] } } }
  agent.ctx = createScope(ctx, agent).ctx
  return agent
}
const config = { binaryPath: WORKER, required: true, allowedTools: ['stat'], alwaysLoaded: ['stat'] }
const stat = (ctx, agent) => executeCall(ctx, { agent, name: STAT_TOOL, arguments: { path: 'note' } })

for (const conflict of ['worker', 'credentials', 'timeout']) await test(`awaited ${conflict} conflict rolls back partial discovery and permits recovery`, () => withTempDir('discovery-conflict', async dir => {
  const { ctx, tools } = await bootHost()
  try {
    await services(ctx, dir)
    fs.writeFileSync(path.join(dir, 'note'), 'original source')
    const agent = mint(ctx, dir)
    const sourceConfig = { workerPath: WORKER }
    if (conflict === 'credentials') sourceConfig.denyCredentialReads = false
    if (conflict === 'timeout') sourceConfig.toolCallTimeoutMs = WORKER_TIMEOUT_MS + 1000
    if (conflict === 'worker') {
      sourceConfig.workerPath = path.join(dir, path.basename(WORKER))
      fs.copyFileSync(WORKER, sourceConfig.workerPath)
    }
    const source = await acquireSharedFile(agent, 'stat', sourceConfig)
    source.grant({ consumer: {}, agent, token: {}, entitled: true, present: () => true, dispatch: async () => undefined })
    const original = tools.get(STAT_TOOL, agent)
    await ctx.plugin({ apply(inner) { mountDiscovery(inner, config, { allows: () => true }) } })
    await settle()
    await assert.rejects(ctx.serial('agent/created', { agent }), error =>
      error instanceof Error && !(error instanceof AggregateError) && error.message === 'Conflicting shared file runtime configuration')
    assert.equal(tools.get(DISCOVER_TOOL, agent), undefined, 'failed readiness must remove the discovery registration')
    assert.equal(pendingSelection(ctx, agent), undefined, 'failed readiness must remove the selection observation')
    assert.equal(tools.get(STAT_TOOL, agent), original, 'failure must preserve the preexisting source identity')
    const before = await stat(ctx, agent)
    assert.equal(before.isError, false, JSON.stringify(before))
    assert.equal(before.value.data.exists, true, JSON.stringify(before))
    source.dispose()
    assert.equal(tools.get(STAT_TOOL, agent), undefined, 'failed leases must not retain the source')
    await ctx.serial('agent/created', { agent })
    assert.ok(tools.get(DISCOVER_TOOL, agent), 'the failed entry must not cache a rejected ready promise')
    const recovered = await stat(ctx, agent)
    assert.equal(recovered.isError, false, JSON.stringify(recovered))
    assert.equal(recovered.value.data.exists, true, JSON.stringify(recovered))
    await ctx.serial('agent/disposed', { agent })
    assert.equal(pendingSelection(ctx, agent), undefined)
    assert.equal(tools.get(STAT_TOOL, agent), undefined)
  } finally { await shutdown(ctx) }
}))

await test('background discovery conflict is observed, leaves no partial state and recovers', () => withTempDir('discovery-background-conflict', async dir => {
  const { ctx, tools } = await bootHost()
  const unhandled = [], observe = error => unhandled.push(error)
  process.on('unhandledRejection', observe)
  let enabled = false, notify
  try {
    await services(ctx, dir)
    fs.writeFileSync(path.join(dir, 'note'), 'background source')
    const agent = mint(ctx, dir)
    ctx.provide('agents', { list: () => [agent] })
    const source = await acquireSharedFile(agent, 'stat', { workerPath: WORKER, denyCredentialReads: false })
    source.grant({ consumer: {}, agent, token: {}, entitled: true, present: () => true, dispatch: async () => undefined })
    const baseline = tools.definitions(agent)
    await ctx.plugin({ apply(inner) { mountDiscovery(inner, config, {
      allows: () => enabled, watch(callback) { notify = callback; return () => { notify = undefined } },
    }) } })
    await settle()
    enabled = true; notify(); await settle()
    assert.deepEqual(unhandled, [], 'background attachment must observe rejection')
    assert.deepEqual(tools.definitions(agent), baseline, 'all partial registrations must be rolled back')
    assert.equal(pendingSelection(ctx, agent), undefined)
    const original = await stat(ctx, agent)
    assert.equal(original.isError, false, JSON.stringify(original))
    assert.equal(original.value.data.exists, true)
    source.dispose()
    notify(); await settle()
    assert.ok(tools.get(DISCOVER_TOOL, agent))
    const recovered = await stat(ctx, agent)
    assert.equal(recovered.isError, false, JSON.stringify(recovered))
    assert.equal(recovered.value.data.exists, true)
    enabled = false; notify(); await settle()
    assert.equal(pendingSelection(ctx, agent), undefined)
    assert.equal(tools.get(DISCOVER_TOOL, agent), undefined)
    assert.deepEqual(unhandled, [])
  } finally { await shutdown(ctx); process.off('unhandledRejection', observe) }
}))

await test('a deferred shared registration failure rejects discovery attachment and rolls back once', () => withTempDir('discovery-deferred-failure', async dir => {
  const { ctx, tools } = await bootHost()
  const sharedName = publicToolName('stat'), discoverName = publicToolName('discover_tools')
  const permanent = new Error('unexpected shared publication failure')
  let locked = true, attempts = 0, unwatch
  let signalRefusal
  const refused = new Promise(resolve => { signalRefusal = resolve })
  try {
    await services(ctx, dir)
    fs.writeFileSync(path.join(dir, 'note'), 'recovered shared source')
    const agent = mint(ctx, dir)
    await ctx.plugin({ apply(inner) { mountDiscovery(inner, config, { allows: () => true }) } })
    await settle()
    unwatch = ctx.on('tools/change', () => {
      if (!tools.get(sharedName, agent)) return
      ++attempts
      if (locked) { signalRefusal(); throw new Error('session append cannot reenter while another append is being published') }
      throw permanent
    })
    const attachment = ctx.serial('agent/created', { agent })
    void attachment.catch(() => {})
    let timer
    try { await Promise.race([refused, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('shared registration refusal was not reached')), 5000) })]) }
    finally { clearTimeout(timer) }
    locked = false
    try {
      await assert.rejects(Promise.race([attachment, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('shared readiness did not settle')), 5000)
      })]), error => error === permanent)
    } finally { clearTimeout(timer) }
    assert.equal(tools.get(discoverName, agent), undefined)
    assert.equal(tools.get(sharedName, agent), undefined)
    assert.equal(pendingSelection(ctx, agent), undefined, 'failed shared readiness releases the observation')
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(attempts, 2, 'a permanent failure after the refusal is never retried')
    unwatch(); unwatch = undefined
    await ctx.serial('agent/created', { agent })
    const recovered = await stat(ctx, agent)
    assert.equal(recovered.isError, false, JSON.stringify(recovered))
    assert.equal(recovered.value.data.exists, true)
  } finally { unwatch?.(); await shutdown(ctx) }
}))

await test('withdrawal revokes captured shared-file authority before yielding to teardown', () => withTempDir('discovery-withdrawal', async dir => {
  const { ctx, tools } = await bootHost()
  let enabled = true, notify, step
  try {
    await services(ctx, dir)
    fs.writeFileSync(path.join(dir, 'note'), 'withdrawn source')
    const agent = mint(ctx, dir)
    await ctx.plugin({ apply(inner) { mountDiscovery(inner, config, {
      allows: () => enabled, watch(callback) { notify = callback; return () => {} },
    }) } })
    await settle()
    await ctx.serial('agent/created', { agent })
    step = await prepareStep(ctx, agent)
    const retained = tools.executable(STAT_TOOL, agent, step.toolSet)
    assert.ok(retained)
    enabled = false; notify()
    assert.equal(tools.executable(STAT_TOOL, agent, step.toolSet), undefined, 'a held step must lose authority synchronously')
    const result = await retained.execute({ path: 'note' }, { agent, toolSet: step.toolSet,
      name: STAT_TOOL, callId: 'withdrawn', arguments: { path: 'note' }, signal: new AbortController().signal })
    assert.equal(result.error.code, 'PUBLICATION_IDENTITY_MISMATCH')
    assert.equal(result.error.effectState, 'none')
    await settle()
    assert.equal(pendingSelection(ctx, agent), undefined)
  } finally { step?.dispose(); await shutdown(ctx) }
}))

await test('mounted discovery permits real settings writes and reloads its pool on Cordis 4.1', () => withTempDir('discovery-settings-update', async dir => {
  const fixture = await profileFixture('discovery-settings-update', {
    Config, apply(inner, value) { mountDiscovery(inner, value, { allows: () => true }) },
  }, config)
  const { ctx, snapshot, mutate, patchPath } = fixture
  const agents = []
  try {
    ctx.provide('agents', { list: () => agents })
    await services(ctx, dir)
    const agent = mint(ctx, dir); agents.push(agent)
    await ctx.serial('agent/created', { agent })
    await waitFor(() => Boolean(ctx.tools.get(STAT_TOOL, agent)))
    const ordinary = []
    const unrelated = ctx.plugin({ apply(_inner, value) { ordinary.push(value.enabled) } }, { enabled: false })
    await unrelated
    await unrelated.update({ enabled: true })
    await unrelated
    assert.deepEqual(ordinary, [false, true], 'discovery must not reject unrelated internal/update waterfalls')
    await mutate([{ op: 'set', path: ['allowedTools'], value: ['glob'] }, { op: 'set', path: ['alwaysLoaded'], value: ['glob'] }], snapshot().revision)
    await ctx.loader.await()
    await waitFor(() => Boolean(ctx.tools.get(GLOB_TOOL, agent)) && !ctx.tools.get(STAT_TOOL, agent))
    assert.deepEqual(snapshot().value.alwaysLoaded, ['glob'])
    assert.match(fs.readFileSync(patchPath, 'utf8'), /glob/)
    await mutate([{ op: 'set', path: ['enabled'], value: false }], snapshot().revision)
    await ctx.loader.await()
    await waitFor(async () => {
      const step = await prepareStep(ctx, agent)
      try { return !step.assembly.tools.some(tool => tool.name === DISCOVER_TOOL) } finally { step.dispose() }
    })
    assert.equal(snapshot().value.enabled, false)
    assert.match(fs.readFileSync(patchPath, 'utf8'), /enabled: false/)
  } finally { await shutdown(ctx) }
}))
report('discovery-attachment')
