/** Measure each real provider surface separately; SDK membership is not a direct tool declaration. */
import fs from 'node:fs'
import path from 'node:path'
import { createScope } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import * as Ptc from '../lib/components/mode-ptc/index.js'
import * as OpsPtc from '../lib/components/mode-ops-ptc/index.js'
import * as Standard from '../lib/components/mode-standard/index.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { selectExecutor, executeCall, prepareStep } from './lib/executor.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'
import { assert, test, report, withTempDir, waitFor } from './lib/harness.mjs'
process.env.DSH_OPS_LEGACY_ROWS = '1'
requireWorker('mode-contract-audit')
const official = ['read', 'glob', 'grep', 'edit', 'read_image']
const definition = name => ({ name, description: `fixture ${name}`, parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => name })
const samples = []
for (const [mode, component] of [['ptc-control', undefined], ['ptc', Ptc], ['ops-ptc', OpsPtc], ['standard', Standard]]) {
  await test(`${mode} provider request and nested SDK agree with its declared replacement policy`, () => withTempDir('mode-contract', async cwd => {
    fs.writeFileSync(path.join(cwd, 'note.txt'), 'fixture\n')
    const { ctx } = await bootHost()
    try {
      await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem); await ctx.plugin(NodePtc)
      ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: cwd }) })
      ctx.provide('agentPresets', { composedPreset: () => undefined })
      for (const name of official) ctx.tools.register(definition(name))
      const agents = []; ctx.provide('agents', { list: () => agents })
      const row = component && await ctx.plugin(component, { required: true, binaryPath: WORKER, bash: false, batchingGuidance: false })
      const agent = { id: `audit-${mode}`, session: { id: `audit-${mode}`, mode: 'danger-full-access',
        header: { cwd, agentPreset: mode }, append() {}, read() { return [] } } }
      agent.ctx = createScope(ctx, agent).ctx
      await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) {
        selectExecutor(inner, mode === 'standard' ? 'native' : 'ptc')
      } })
      agents.push(agent); await ctx.serial('agent/created', { agent })
      if (component) await waitFor(() => ctx.tools.get(mode === 'standard' ? 'ops_glob' : 'ops_load_sdk', agent))
      const capture = async stage => {
        const step = await prepareStep(ctx, agent)
        try {
          const text = step.assembly.sections.map(section => section.text).join('\n\n')
          const sdk = step.assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
          const direct = step.assembly.tools.map(tool => tool.name)
          const admitted = ctx.tools.definitions(agent, step.toolSet).map(tool => tool.name)
          samples.push({ mode, stage, promptBytes: Buffer.byteLength(text), sdkBytes: Buffer.byteLength(sdk),
            schemaBytes: Buffer.byteLength(JSON.stringify(step.assembly.tools)), direct, admitted })
          assert.doesNotMatch(text, /runtimeVersion|OPS batch-call guidance/u, 'unqueried version and disabled teaching add no text')
          if (mode === 'standard') {
            for (const name of ['read', 'glob', 'grep']) assert.equal(direct.includes(name), false)
            for (const name of ['ops_inspect_local_file', 'ops_glob', 'ops_grep', 'edit', 'read_image']) assert.ok(direct.includes(name), name)
          } else {
            assert.deepEqual(direct, ['run_code'])
            // Built-in PTC modes intentionally select no official file replacements.
            for (const name of official) { assert.ok(admitted.includes(name), name); assert.ok(sdk.includes(`${name}:`), name) }
            if (!component) assert.doesNotMatch(text, /ops_/u)
            else assert.ok(sdk.includes('ops_inspect_local_file:'))
          }
          return { direct, admitted, sdk }
        } finally { step.dispose() }
      }
      await capture('initial')
      if (component && mode !== 'standard') {
        const run = async code => {
          const result = await executeCall(ctx, { agent, name: 'run_code', arguments: { description: 'Verify SDK admission', code } })
          assert.equal(result.isError, false, JSON.stringify(result)); return result.value.result
        }
        const loaded = await run("return await tools.ops_load_sdk({tools:['glob','grep','read_files']});")
        assert.equal(loaded.status, 'completed')
        await ctx.serial('session/event', agent.session, { type: 'step/end' })
        const next = await capture('loaded')
        assert.ok(next.admitted.includes('ops_glob')); assert.ok(next.sdk.includes('ops_glob:'))
        assert.match(next.sdk, /paths \(default\): string\[\]/u)
        assert.match(next.sdk, /files_with_matches: \{path\}\[\]/u)
        const value = await run("return {official:await tools.glob({}),ops:await tools.ops_glob({pattern:['*.txt'],outputMode:'paths'})};")
        assert.equal(value.official, 'glob'); assert.equal(value.ops.status, 'completed')
        assert.ok(value.ops.data.items.some(file => file.endsWith('note.txt')))
      }
      if (row) {
        await row.dispose()
        const step = await prepareStep(ctx, agent)
        try {
          const admitted = ctx.tools.definitions(agent, step.toolSet).map(tool => tool.name)
          assert.equal(admitted.some(name => name.startsWith('ops_')), false)
          for (const name of official) assert.ok(admitted.includes(name))
        } finally { step.dispose() }
      }
    } finally { await shutdown(ctx) }
  }))
}
console.log(JSON.stringify({ modeContractBytes: samples }))
if (process.env.DSH_OPS_MODE_CONTRACT_REPORT) fs.writeFileSync(process.env.DSH_OPS_MODE_CONTRACT_REPORT, JSON.stringify(samples, null, 2) + '\n')
report('mode-contract-audit')
