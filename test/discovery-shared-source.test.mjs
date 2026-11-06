/** Real discovery and PTC consumers share the file kernel, not execution closures. */
import fs from 'node:fs'
import path from 'node:path'
import { createScope } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import { mountDiscovery } from '../lib/discovery/controller.js'
import { mountPtc } from '../lib/publication/ptc.js'
import { PTC_LOADABLE_TOOLS } from '../lib/ptc/config.js'
import { SHARED_FILE_APIS } from '../lib/publication/scope-owner.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { selectExecutor, prepareStep, executeCall } from './lib/executor.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { requireWorker, WORKER } from './lib/boundary.mjs'
requireWorker('discovery-shared-source')
await test('discovery commits stat/grep next step and withdraws without stopping PTC', () => withTempDir('discovery-shared', async root => {
  fs.writeFileSync(path.join(root, 'note'), 'fixture\n')
  const { ctx, tools } = await bootHost(), steps = [], agents = []
  let mode = 'workspace-write'
  try {
    for (const plugin of [Subprocess, Sandbox, FileSystem, NodePtc]) await ctx.plugin(plugin)
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode, workspaceRoot: root }) })
    ctx.provide('agents', { list: () => agents })
    const discovery = ctx.plugin({ apply(inner) { mountDiscovery(inner, {
      binaryPath: WORKER, required: true, allowedTools: ['stat', 'grep', 'glob', 'write_file'],
    }, { allows: () => true }) } })
    await discovery
    for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve))
    const mint = async id => {
      const agent = { id, session: { id, header: { cwd: root }, append() {}, read() { return [] } } }
      agent.ctx = createScope(ctx, agent).ctx; agents.push(agent)
      await ctx.serial('agent/created', { agent })
      return agent
    }
    const agent = await mint('owner'), sibling = await mint('sibling')
    let executor
    const select = async name => {
      executor?.()
      await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { executor = selectExecutor(inner, name) } })
    }
    const prepare = async () => { const step = await prepareStep(ctx, agent); steps.push(step); return step }
    let id = 0
    const call = (step, name, args) => executeCall(ctx, { agent, toolSet: step.toolSet, name, arguments: args, callId: `shared-${++id}` })
    await select('native')
    const first = await prepare()
    for (const api of ['stat', 'grep']) {
      const selected = await call(first, 'ops_discover_tools', { query: `select:ops_${api}` })
      assert.deepEqual(selected.value.activated, [`ops_${api}`])
      assert.equal(tools.executable(`ops_${api}`, agent, first.toolSet), undefined)
    }
    await ctx.serial('session/event', agent.session, { type: 'step/end', turn: 1, step: 1 })
    const native = await prepare(), stat = tools.executable('ops_stat', agent, native.toolSet)
    assert.ok(stat)
    const queries = { stat: { path: 'note' }, grep: { pattern: 'fixture', path: '.' } }
    for (const [api, args] of Object.entries(queries)) {
      const result = await call(native, `ops_${api}`, args)
      assert.equal(result.isError, false, JSON.stringify(result))
      assert.equal(result.value.status, 'completed', JSON.stringify(result))
      assert.equal(tools.executable(`ops_${api}`, sibling), undefined)
    }
    await ctx.serial('session/event', agent.session, { type: 'step/end', turn: 1, step: 2 })
    assert.equal(tools.get('ops_stat', agent), stat, 'unchanged selection preserves identity')
    await call(native, 'ops_discover_tools', { query: 'select:ops_write_file' })
    await ctx.serial('session/event', agent.session, { type: 'step/end', turn: 1, step: 3 })
    mode = 'read-only'
    const readonly = await prepare()
    assert.equal(tools.executable('ops_write_file', agent, readonly.toolSet), undefined)
    assert.ok(tools.executable('ops_stat', agent, readonly.toolSet))
    const ptc = ctx.plugin({ apply(inner) { mountPtc(inner, { binaryPath: WORKER, required: true, alwaysLoaded: SHARED_FILE_APIS.filter(api => PTC_LOADABLE_TOOLS.includes(api)) }) } })
    await ptc
    for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve))
    await ctx.serial('agent/created', { agent })
    for (const api of SHARED_FILE_APIS) assert.equal(tools.definitions(agent).filter(def => def.name === `ops_${api}`).length, 1)
    await select('ptc')
    let step = await prepare()
    const canonical = tools.executable('ops_stat', agent, step.toolSet)
    assert.ok(canonical.output.schema)
    for (const [api, args] of Object.entries(queries)) {
      const result = await call(step, 'run_code', { description: api, code: `return await tools.ops_${api}(${JSON.stringify(args)});` })
      assert.equal(result.isError, false, JSON.stringify(result))
      assert.equal(result.value.result.status, 'completed', JSON.stringify(result))
    }
    await discovery.dispose()
    assert.equal(tools.executable('ops_stat', agent, step.toolSet), undefined, 'withdrawal invalidates captured identity')
    step = await prepare()
    const after = await call(step, 'run_code', { description: 'Still live', code: "return await tools.ops_stat({path:'note'});" })
    assert.equal(after.isError, false, JSON.stringify(after))
    assert.equal(after.value.result.data.exists, true)
    await ptc.dispose()
  } finally { steps.forEach(step => step.dispose()); await shutdown(ctx) }
}))
report('discovery-shared-source')
