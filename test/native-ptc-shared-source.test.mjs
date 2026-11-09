/** Real consumers, one stat registration and official Node PTC execution. */
import fs from 'node:fs'
import path from 'node:path'
import { ToolExecutorUnavailableError } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import { mountNative } from '../lib/publication/native.js'
import { mountPtc } from '../lib/publication/ptc.js'
import { PTC_LOADABLE_TOOLS } from '../lib/ptc/config.js'
import { acquireSharedFile, SHARED_FILE_APIS } from '../lib/publication/scope-owner.js'
import { definition as nativeDefinition } from '../lib/projections/native/contract.js'
import { definition as ptcDefinition } from '../lib/projections/ptc/contract.js'
import { resolveConfig } from '../lib/config.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { selectExecutor, prepareStep, executeCall } from './lib/executor.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { requireWorker, WORKER } from './lib/boundary.mjs'
requireWorker('native-ptc-shared-source')

for (const removed of ['native', 'ptc']) await test(`stat shares canonical source; removing ${removed} preserves remaining consumer`, () => withTempDir('shared-stat', async root => {
  fs.writeFileSync(path.join(root, 'note'), 'fixture')
  const { ctx, tools } = await bootHost()
  const steps = []
  try {
    for (const plugin of [Subprocess, Sandbox, FileSystem, NodePtc]) await ctx.plugin(plugin)
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) })
    // The row that mounts the native source is also its subscription context:
    // a real plugin row, because the agent's own ctx would be refused.
    let row
    const native = ctx.plugin({ apply(inner) { row = inner; mountNative(inner, resolveConfig({ binaryPath: WORKER, required: true }), {
      id: 'shared-stat', tools: [...SHARED_FILE_APIS], section: null, gate: { allows: () => true },
    }) } })
    await native
    for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve))
    const agent = { id: 'shared', session: { id: 'shared', header: { cwd: root }, append() {}, read() { return [] } } }
    agent.ctx = createScope(ctx, agent).ctx
    let executor
    await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { executor = selectExecutor(inner, 'native') } })
    await ctx.serial('agent/created', { agent })
    let step = await prepareStep(ctx, agent); steps.push(step)
    assert.ok(tools.executable('ops_stat', agent, step.toolSet))
    const ptc = ctx.plugin({ apply(inner) { mountPtc(inner, { binaryPath: WORKER, required: true, alwaysLoaded: SHARED_FILE_APIS.filter(api => PTC_LOADABLE_TOOLS.includes(api)) }) } })
    await ptc
    for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve))
    // Existing agents are normally supplied by the host agents service.
    await ctx.serial('agent/created', { agent })
    assert.equal(tools.definitions(agent).filter(def => def.name === 'ops_stat').length, 1)
    for (const api of SHARED_FILE_APIS.filter(api => api !== 'result')) {
      assert.deepEqual(nativeDefinition(api, async () => {}).parameters, ptcDefinition(api, async () => {}).parameters)
    }
    for (const config of [{ workerPath: process.execPath }, { workerPath: WORKER, denyCredentialReads: false }, { workerPath: WORKER, toolCallTimeoutMs: 1 }]) {
      await assert.rejects(acquireSharedFile(agent, 'stat', config, row), /Conflicting shared file runtime configuration/)
    }
    const canonical = tools.definitions(agent).find(def => def.name === 'ops_stat')
    executor()
    await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { executor = selectExecutor(inner, 'ptc') } })
    step = await prepareStep(ctx, agent); steps.push(step)
    assert.equal(tools.executable('ops_stat', agent, step.toolSet), canonical)
    const result = await executeCall(ctx, { agent, toolSet: step.toolSet, name: 'run_code', callId: 'shared-stat',
      arguments: { description: 'Shared stat', code: "return await tools.ops_stat({path:'note'});" } })
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.equal(result.value.result.data.exists, true, JSON.stringify(result))
    const queries = { grep: { pattern: 'fixture', path: '.' }, glob: { pattern: ['**/*'], path: '.' }, read_files: { files: [{ path: 'note' }] } }
    for (const [api, args] of Object.entries(queries)) {
      const called = await executeCall(ctx, { agent, toolSet: step.toolSet, name: 'run_code', callId: `ptc-${api}`,
        arguments: { description: api, code: `return await tools.ops_${api}(${JSON.stringify(args)});` } })
      assert.equal(called.isError, false, JSON.stringify(called))
      assert.equal(called.value.result.status, 'completed', JSON.stringify(called))
    }
    executor()
    await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { executor = selectExecutor(inner, 'native') } })
    step = await prepareStep(ctx, agent); steps.push(step)
    for (const [api, args] of Object.entries(queries)) {
      const called = await executeCall(ctx, { agent, toolSet: step.toolSet, name: `ops_${api}`, callId: `native-${api}`, arguments: args })
      assert.equal(called.isError, false, JSON.stringify(called))
      assert.equal(called.value.status, 'completed', JSON.stringify(called))
      assert.ok(called.content.some(item => item.type === 'text' && item.text.length))
    }
    executor()
    await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { executor = selectExecutor(inner, 'ptc') } })
    step = await prepareStep(ctx, agent); steps.push(step)
    await (removed === 'native' ? native : ptc).dispose()
    assert.equal(tools.executable('ops_stat', agent, step.toolSet), undefined, 'revocation invalidates old step')
    if (removed === 'ptc') {
      executor()
      await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { executor = selectExecutor(inner, 'native') } })
    }
    step = await prepareStep(ctx, agent); steps.push(step)
    const after = await executeCall(ctx, { agent, toolSet: step.toolSet, name: removed === 'native' ? 'run_code' : 'ops_stat', callId: 'remaining-stat',
      arguments: removed === 'native' ? { description: 'Still live', code: "return await tools.ops_stat({path:'note'});" } : { path: 'note' } })
    assert.equal(after.isError, false, JSON.stringify(after))
    assert.equal((removed === 'native' ? after.value.result : after.value).data.exists, true, JSON.stringify(after))
    await (removed === 'native' ? ptc : native).dispose()
    for (const api of SHARED_FILE_APIS) assert.equal(tools.get(`ops_${api}`, agent), undefined)
  } finally { steps.forEach(step => step.dispose()); await shutdown(ctx) }
}))
for (const mode of ['native', 'ptc']) await test(`${mode} honors intermediate ancestor deny and source disposal on captured steps`, () => withTempDir('shared-security', async root => {
  fs.writeFileSync(path.join(root, 'note'), 'fixture')
  const { ctx, tools } = await bootHost()
  const steps = []
  try {
    for (const plugin of [Subprocess, Sandbox, FileSystem, NodePtc]) await ctx.plugin(plugin)
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) })
    const publication = ctx.plugin({ apply(inner) {
      mountNative(inner, resolveConfig({ binaryPath: WORKER, required: true }), {
        id: 'shared-security', tools: [...SHARED_FILE_APIS], section: null, gate: { allows: () => true },
      })
      mountPtc(inner, { binaryPath: WORKER, required: true, alwaysLoaded: SHARED_FILE_APIS.filter(api => PTC_LOADABLE_TOOLS.includes(api)) })
    } })
    await publication
    for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve))
    const mint = async (id, parent) => {
      const agent = { id, session: { id, header: { cwd: root }, append() {}, read() { return [] } } }
      const scope = createScope(parent?.ctx ?? ctx, agent, parent ? { parent } : undefined)
      agent.ctx = scope.ctx
      agent.disposeScope = scope.dispose
      await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, mode) } })
      await ctx.serial('agent/created', { agent })
      return agent
    }
    const source = await mint('source'), middle = await mint('middle', source), child = await mint('child', middle)
    const before = await prepareStep(ctx, child); steps.push(before)
    for (const api of SHARED_FILE_APIS) {
      assert.equal(tools.executable(`ops_${api}`, child, before.toolSet),
        tools.definitions(source).find(def => def.name === `ops_${api}`), 'source must be above the restriction scope')
    }
    const call = (step, api, id) => executeCall(ctx, { agent: child, toolSet: step.toolSet,
      name: mode === 'native' ? `ops_${api}` : 'run_code', callId: id,
      arguments: mode === 'native' ? { path: 'note' } : { description: id, code: `return await tools.ops_${api}({path:'note'});` } })
    const live = await call(before, 'stat', 'live-stat')
    assert.equal(live.isError, false, JSON.stringify(live))
    assert.equal((mode === 'native' ? live.value : live.value.result).data.exists, true)
    const restriction = await middle.ctx.plugin({ inject: ['tools'], apply(inner) {
      inner.tools.restrict({ deny: SHARED_FILE_APIS.map(api => `ops_${api}`) })
    } })
    const denied = await prepareStep(ctx, child); steps.push(denied)
    for (const api of SHARED_FILE_APIS) {
      assert.equal(tools.executable(`ops_${api}`, child, denied.toolSet), undefined)
      const result = await call(denied, api, `denied-${api}`)
      assert.equal(result.isError, true, JSON.stringify(result))
    }
    await restriction.dispose()
    const restored = await prepareStep(ctx, child); steps.push(restored)
    assert.ok(tools.executable('ops_stat', child, restored.toolSet))
    // Withdraw publications without also disposing the descendant executor.
    await publication.dispose()
    await publication.dispose()
    for (const api of SHARED_FILE_APIS) {
      assert.equal(tools.executable(`ops_${api}`, child, restored.toolSet), undefined)
      const result = await call(restored, api, `disposed-${api}`)
      assert.equal(result.isError, true, JSON.stringify(result))
    }
    await source.disposeScope()
    await source.disposeScope()
    await assert.rejects(call(restored, 'stat', 'executor-disposed'), ToolExecutorUnavailableError)
    // Captured sets and context cleanup are independently idempotent.
    restored.dispose(); restored.dispose()
  } finally { steps.forEach(step => step.dispose()); await shutdown(ctx) }
}))
await test('background PTC conflict is observed, cleaned up and retryable after recovery', () => withTempDir('attach-failure', async root => {
  fs.writeFileSync(path.join(root, 'note'), 'fixture')
  const { ctx, tools } = await bootHost()
  const agents = [], unhandled = [], steps = []
  const observe = reason => unhandled.push(reason)
  process.on('unhandledRejection', observe)
  let notify, enabled = false
  const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)) }
  try {
    for (const plugin of [Subprocess, Sandbox, FileSystem, NodePtc]) await ctx.plugin(plugin)
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) })
    ctx.provide('agents', { list: () => agents })
    const native = ctx.plugin({ apply(inner) { mountNative(inner, resolveConfig({ binaryPath: WORKER, required: true, denyCredentialReads: false }), {
      id: 'conflicting-source', tools: [...SHARED_FILE_APIS], section: null, gate: { allows: () => true },
    }) } })
    await native; await settle()
    const agent = { id: 'retry', session: { id: 'retry', header: { cwd: root }, append() {}, read() { return [] } } }
    agent.ctx = createScope(ctx, agent).ctx
    agents.push(agent)
    await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, 'ptc') } })
    await ctx.serial('agent/created', { agent })
    const baseline = tools.definitions(agent).map(def => def.name).sort()
    const ptc = ctx.plugin({ apply(inner) { mountPtc(inner, { binaryPath: WORKER, required: true, alwaysLoaded: SHARED_FILE_APIS.filter(api => PTC_LOADABLE_TOOLS.includes(api)) }, {
      allows: () => enabled, watch(callback) { notify = callback; return () => { notify = undefined } },
    }) } })
    await ptc; await settle()
    assert.equal(typeof notify, 'function')
    enabled = true; notify(); await settle()
    assert.deepEqual(unhandled, [], 'background failure must have a rejection observer')
    assert.deepEqual(tools.definitions(agent).map(def => def.name).sort(), baseline, 'failed attachment must remove partial registrations')
    await native.dispose()
    assert.equal(tools.get('ops_stat', agent), undefined, 'failed leases must not retain the old source')
    notify(); await settle()
    const step = await prepareStep(ctx, agent); steps.push(step)
    assert.ok(tools.executable('ops_stat', agent, step.toolSet), 'recovered configuration must allow a fresh attachment')
    const result = await executeCall(ctx, { agent, toolSet: step.toolSet, name: 'run_code', callId: 'retry-stat',
      arguments: { description: 'Recovered stat', code: "return await tools.ops_stat({path:'note'});" } })
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.equal(result.value.result.data.exists, true, JSON.stringify(result))
    assert.deepEqual(unhandled, [])
  } finally {
    steps.forEach(step => step.dispose())
    await shutdown(ctx)
    process.off('unhandledRejection', observe)
  }
}))
report('native-ptc-shared-source')
