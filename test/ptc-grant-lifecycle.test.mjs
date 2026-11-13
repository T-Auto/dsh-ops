import { mountResident } from './lib/resident.mjs'
/** Shared PTC file sources must retain identity across unrelated no-change steps. */
import fs from 'node:fs'
import path from 'node:path'
import { createScope } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import { mountPtc } from '../lib/publication/ptc.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { selectExecutor, prepareStep, executeCall } from './lib/executor.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { requireWorker, WORKER } from './lib/boundary.mjs'
requireWorker('ptc-grant-lifecycle')

await test('unchanged ancestor step/end preserves descendant file identity and real run_code execution', () => withTempDir('ptc-grants', async root => {
  fs.writeFileSync(path.join(root, 'note'), 'fixture')
  const { ctx } = await bootHost()
  let prepared
  try {
    for (const plugin of [Subprocess, Sandbox, FileSystem, NodePtc]) await ctx.plugin(plugin)
    await mountResident(ctx, { file: WORKER, cwd: root })
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) })
    await ctx.plugin({ apply(inner) {
      mountPtc(inner, { binaryPath: WORKER, required: true, alwaysLoaded: ['stat'] })
    } })
    for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve))
    const mint = async (id, parent) => {
      const agent = { id, session: { id, header: { cwd: root }, append() {}, read() { return [] } } }
      agent.ctx = createScope(parent?.ctx ?? ctx, agent, parent ? { parent } : undefined).ctx
      await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, 'ptc') } })
      await ctx.serial('agent/created', { agent })
      return agent
    }
    const ancestor = await mint('ancestor'), descendant = await mint('descendant', ancestor)
    prepared = await prepareStep(ctx, descendant)
    const tools = ctx.get('tools'), before = tools.executable('ops_stat', descendant, prepared.toolSet)
    assert.ok(before, 'descendant must have an admitted file API')
    assert.equal(tools.definitions(ancestor).find(def => def.name === 'ops_stat'), before, 'agents share the ancestor source')
    for (let step = 1; step <= 2; step++) {
      ctx.emit('session/event', ancestor.session, { type: 'step/end', turn: 1, step })
      assert.equal(tools.executable('ops_stat', descendant, prepared.toolSet), before, 'no-change step must not retire the descendant snapshot')
    }
    const result = await executeCall(ctx, { agent: descendant, toolSet: prepared.toolSet, name: 'run_code',
      arguments: { description: 'Read stat through preserved SDK handle', code: "return await tools.ops_stat({path:'note'});" }, callId: 'stable-stat' })
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.equal(result.value.result.status, 'completed', JSON.stringify(result))
    assert.equal(result.value.result.data.exists, true, JSON.stringify(result))
  } finally { prepared?.dispose(); await shutdown(ctx) }
}))
report('ptc-grant-lifecycle')
