/** Real pinned-host declaration accounting, not a tokenizer or an LLM benchmark. */
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { createScope } from '@deepseek-ai/dsh-scope'
import { bootHost, shutdown } from './lib/host.mjs'
import { assert, test, report, skipSuite } from './lib/harness.mjs'
import { applyComponent } from '../lib/index.js'
import * as ptcModule from '../lib/ptc/index.js'
import { tryResolveWorker } from '../lib/ptc/runtime.js'
import { legacyComponent } from './lib/legacy-component.mjs'
const ptc = legacyComponent(ptcModule)

const worker = tryResolveWorker()
if (!worker.ok) skipSuite('ptc-cost', worker.reason)

await test('measure PTC enhancement separately from the existing file/shell declaration cost', async () => {
  const { ctx } = await bootHost()
  const scopes = []
  const samples = []
  try {
    await ctx.plugin(inner => {
      // Assembly needs the language contract, not an executing provider. No tool is executed.
      inner.provide('ptcRuntime', { language: 'typescript' })
      inner.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: 'read-only', workspaceRoot: session.header.cwd }) })
      inner.provide('subprocess', { spawn() { throw new Error('cost probe must never spawn') } })
    })
    const agents = []
    for (const mode of ['native', 'ptc', 'both']) {
      const agent = { id: `cost-${mode}`, session: { id: `cost-${mode}`, header: { cwd: process.cwd() } } }
      const scope = createScope(ctx, agent); scopes.push(scope); agent.ctx = scope.ctx
      await agent.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.presentAs(mode) } })
      agents.push([mode, agent])
    }
    const capture = async stage => {
      for (const [mode, agent] of agents) {
        const assembly = await ctx.get('systemPrompt').assemble({ scope: agent })
        const sections = assembly.sections.map(({ name, text }) => ({ name, chars: text.length, bytes: Buffer.byteLength(text) }))
        const text = assembly.sections.filter(section => section.text.length > 0 && (section.name === 'tools:sdk' || section.name === 'tools:ptc-only' || section.name.startsWith('dsh-ops:repository-tooling'))).map(section => section.text).join('\n\n')
        const wire = JSON.stringify(assembly.tools)
        samples.push({ stage, mode, promptChars: text.length, promptBytes: Buffer.byteLength(text), wireBytes: Buffer.byteLength(wire),
          promptSha256: createHash('sha256').update(text).digest('hex'), wireSha256: createHash('sha256').update(wire).digest('hex'), sections })
      }
    }
    await capture('host-only')
    await ctx.plugin({ apply(inner) { applyComponent(inner, { binaryPath: worker.file, required: true }, 'file') } })
    await ctx.plugin({ apply(inner) { applyComponent(inner, { bashPath: process.execPath }, 'shell') } })
    for (const [, agent] of agents) await ctx.serial('agent/created', { agent })
    // Let asynchronous component injections settle before freezing the baseline.
    await new Promise(resolve => setTimeout(resolve, 100))
    await capture('file-and-shell')
    const component = await ctx.plugin(ptc, { binaryPath: worker.file, required: true })
    for (const [, agent] of agents) await ctx.serial('agent/created', { agent })
    const pure = agents.find(([mode]) => mode === 'ptc')[1]
    const deadline = Date.now() + 5000
    while (!ctx.get('tools').get('ops_load_sdk', pure) || !ctx.get('tools').get('ops_result', pure)?.parameters.properties.action.enum.includes('put')) {
      if (Date.now() > deadline) throw new Error('PTC declarations did not become available')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await capture('file-shell-and-ptc')
    const deltas = agents.map(([mode]) => {
      const before = samples.find(row => row.stage === 'file-and-shell' && row.mode === mode)
      const after = samples.find(row => row.stage === 'file-shell-and-ptc' && row.mode === mode)
      if (mode !== 'ptc') {
        assert.equal(after.promptSha256, before.promptSha256, `${mode} prompt must not gain PTC declarations: ${JSON.stringify({ before: before.sections, after: after.sections })}`)
        assert.equal(after.wireSha256, before.wireSha256, `${mode} wire must not gain PTC tools`)
      } else {
        assert.ok(after.promptBytes > 0, 'record the actual PTC declaration cost against the current resident Native surface')
        assert.equal(after.wireSha256, before.wireSha256, 'run_code remains the only direct transport')
      }
      return { mode, enhancementPromptChars: after.promptChars - before.promptChars,
        enhancementPromptBytes: after.promptBytes - before.promptBytes, enhancementWireBytes: after.wireBytes - before.wireBytes }
    })
    const evidence = { platform: process.platform, node: process.version, samples, deltas,
      limitations: ['No model requests, tokenizer, cache accounting or actual task usage measured.',
        'File/shell are held constant to isolate PTC enhancement; #148 enabled snapshots also added file/shell and cannot establish a PTC-only delta.',
        'Native/both zero delta concerns this enhancement only, not the file/shell plugin cost.',
        'No net token saving or reproduction of the historical +9462-character snapshot is claimed.'] }
    console.log(JSON.stringify({ declarationCost: deltas }))
    if (process.env.DSH_OPS_PTC_COST_REPORT) fs.writeFileSync(process.env.DSH_OPS_PTC_COST_REPORT, JSON.stringify(evidence, null, 2) + '\n')
    await component.dispose()
  } finally {
    for (const scope of scopes) await scope.dispose()
    await shutdown(ctx)
  }
})
report('ptc-cost')
