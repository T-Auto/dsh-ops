/** Both projections exercise the same mutation authority/CAS bridge, not alternate pools. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import { createScope } from '@deepseek-ai/dsh-scope'
import { mountNative } from '../lib/publication/native.js'
import { mountPtc } from '../lib/publication/ptc.js'
import { resolveConfig } from '../lib/config.js'
import { publicToolName } from '../lib/policy.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { mountResident } from './lib/resident.mjs'
import { selectExecutor, prepareStep, executeCall } from './lib/executor.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { requireWorker, WORKER } from './lib/boundary.mjs'
requireWorker('shared-file-mutations')
const mutations = ['write_file', 'edit_file', 'replace', 'copy', 'move', 'remove']
await test('Native and real run_code preserve mutation effects, CAS and read-only refusal', () => withTempDir('shared-mutations', async root => {
  const { ctx, tools } = await bootHost()
  const steps = []
  let mode = 'danger-full-access'
  try {
    for (const plugin of [Subprocess, Sandbox, FileSystem, NodePtc]) await ctx.plugin(plugin)
    await mountResident(ctx, { file: WORKER, cwd: root })
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode, workspaceRoot: root }) })
    await ctx.plugin({ apply(inner) {
      mountNative(inner, resolveConfig({ binaryPath: WORKER, required: true }), {
        id: 'shared-mutations', tools: mutations, section: null, gate: { allows: () => true },
      })
      mountPtc(inner, { binaryPath: WORKER, required: true, alwaysLoaded: mutations })
    } })
    for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve))
    const agent = { id: 'mutations', session: { id: 'mutations', header: { cwd: root }, append() {}, read() { return [] } } }
    agent.ctx = createScope(ctx, agent).ctx
    let executor
    for (const presentation of ['native', 'ptc']) {
      executor?.()
      await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { executor = selectExecutor(inner, presentation) } })
      if (presentation === 'native') await ctx.serial('agent/created', { agent })
      const step = await prepareStep(ctx, agent); steps.push(step)
      for (const api of mutations) assert.equal(tools.definitions(agent).filter(def => def.name === publicToolName(api)).length, 1)
      const call = async (api, args) => {
        const result = await executeCall(ctx, { agent, toolSet: step.toolSet, name: presentation === 'native' ? publicToolName(api) : 'run_code', callId: `${presentation}-${api}`,
          arguments: presentation === 'native' ? args : { description: api, code: `return await tools.${publicToolName(api)}(${JSON.stringify(args)});` } })
        assert.equal(result.isError, false, JSON.stringify(result))
        return presentation === 'native' ? result.value : result.value.result
      }
      const file = path.join(root, `${presentation}.txt`), copy = file + '.copy', moved = file + '.moved'
      const hash = () => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
      assert.equal((await call('write_file', { path: file, content: 'alpha', expectedRevision: 'absent' })).status, 'completed')
      const stale = hash()
      assert.equal((await call('edit_file', { path: file, expectedRevision: stale, edits: [{ oldText: 'alpha', newText: 'beta' }] })).status, 'completed')
      assert.equal((await call('write_file', { path: file, content: 'unsafe', expectedRevision: stale })).error.code, 'REVISION_CONFLICT')
      assert.equal(fs.readFileSync(file, 'utf8'), 'beta')
      assert.equal((await call('replace', { path: root, glob: [path.basename(file)], pattern: 'beta', replacement: 'gamma' })).status, 'completed')
      assert.equal((await call('copy', { path: file, to: copy, expectedRevision: hash() })).status, 'completed')
      assert.equal((await call('move', { path: file, to: moved, expectedRevision: hash() })).status, 'completed')
      assert.equal(fs.existsSync(file), false)
      assert.equal(fs.readFileSync(moved, 'utf8'), 'gamma')
      const revision = createHash('sha256').update('gamma').digest('hex')
      assert.equal((await call('remove', { path: moved, expectedRevision: revision })).status, 'completed')
      mode = 'read-only'
      if (presentation === 'native') {
        assert.equal((await call('write_file', { path: copy, content: 'unsafe', expectedRevision: revision })).error.code, 'POLICY_DENIED')
      } else {
        const denied = await executeCall(ctx, { agent, toolSet: step.toolSet, name: 'run_code', callId: 'readonly',
          arguments: { description: 'Read-only refusal', code: `return await tools.ops_write_file({path:${JSON.stringify(copy)},content:'unsafe',expectedRevision:${JSON.stringify(revision)}});` } })
        assert.equal(denied.isError, false, JSON.stringify(denied))
        assert.equal(denied.value.result.error.code, 'POLICY_DENIED')
      }
      assert.equal(fs.readFileSync(copy, 'utf8'), 'gamma')
      mode = 'danger-full-access'
    }
  } finally { steps.forEach(step => step.dispose()); await shutdown(ctx) }
}))
report('shared-file-mutations')
