/**
 * modeFor precheck: native sessions must not pay a full prompt assembly
 * during PTC reconciliation. Only sessions whose mode is `ptc` need the
 * authoritative assembly to confirm the wire shape.
 */
import { createScope } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'
import * as ptcModule from '../lib/ptc/index.js'
import * as discoveryModule from '../lib/discovery/index.js'
import { isPresentationProbe } from '../lib/presentation.js'
import { legacyComponent } from './lib/legacy-component.mjs'
const ptc = legacyComponent(ptcModule)
const discovery = legacyComponent(discoveryModule)
requireWorker('ptc-modeFor-precheck')

let serial = 0

await test('native sessions skip full assembly during unattributed tools/change reconcile', async () => {
  await withTempDir('ptc-modeFor-precheck', async root => {
    const { ctx } = await bootHost({ toolsMode: 'native' })
    try {
      await ctx.plugin(Subprocess)
      await ctx.plugin(Sandbox, {})
      await ctx.plugin(FileSystem)
      await ctx.plugin(inner => {
        inner.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: session?.mode ?? 'workspace-write', workspaceRoot: root, sessionId: session?.id }) })
        inner.provide('ptcRuntime', { language: 'typescript' })
      })
      await ctx.plugin(discovery, { binaryPath: WORKER, required: true })
      await ctx.plugin(ptc, { binaryPath: WORKER, required: true })

      // Count assemblies, separating probe assemblies from others.
      const prompt = ctx.get('systemPrompt')
      const assemble = prompt.assemble.bind(prompt)
      let totalAssemblies = 0
      let probeAssemblies = 0
      prompt.assemble = context => {
        totalAssemblies += 1
        if (isPresentationProbe(context)) probeAssemblies += 1
        return assemble(context)
      }

      // Create a mix: mostly native, a few ptc.
      const agents = []
      for (let i = 0; i < 12; i++) {
        const id = `mixed-${i}`
        const agent = { id, session: { id, mode: 'workspace-write', header: { cwd: root }, append() {}, read() { return [] } } }
        await ctx.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
        if (i % 4 === 0) {
          await agent.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.presentAs('ptc') } })
        }
        await ctx.serial('agent/created', { agent, source: 'startup' })
        agents.push(agent)
      }
      await new Promise(resolve => setTimeout(resolve, 300))

      // Reset counters after startup settles.
      totalAssemblies = 0
      probeAssemblies = 0

      // Trigger an unattributed tools/change — the event that used to cost
      // one full assembly per live session.
      await ctx.serial('tools/change', {})
      await new Promise(resolve => setTimeout(resolve, 100))

      const nativeCount = agents.filter((_, i) => i % 4 !== 0).length
      const ptcCount = agents.filter((_, i) => i % 4 === 0).length

      // Native sessions must NOT appear in probe assemblies.
      // Only ptc sessions (and the deferred re-derivation) should probe.
      assert.ok(
        probeAssemblies <= ptcCount + 1,
        `expected at most ${ptcCount + 1} probe assemblies for ${ptcCount} ptc sessions, got ${probeAssemblies} (native=${nativeCount}, total=${totalAssemblies})`
      )
    } finally {
      await shutdown(ctx)
    }
  })
})

await test('modeFor precheck preserves correct verdict for both-to-ptc transitions', async () => {
  await withTempDir('ptc-modeFor-transition', async root => {
    const { ctx } = await bootHost({ toolsMode: 'native' })
    try {
      await ctx.plugin(Subprocess)
      await ctx.plugin(Sandbox, {})
      await ctx.plugin(FileSystem)
      await ctx.plugin(inner => {
        inner.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: session?.mode ?? 'workspace-write', workspaceRoot: root, sessionId: session?.id }) })
        inner.provide('ptcRuntime', { language: 'typescript' })
      })
      await ctx.plugin(ptc, { binaryPath: WORKER, required: true })

      const id = 'transition-0'
      const agent = { id, session: { id, mode: 'workspace-write', header: { cwd: root }, append() {}, read() { return [] } } }
      await ctx.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
      await agent.ctx.plugin({ inject: ['tools'], apply(inner) { agent.lift = inner.tools.presentAs('both') } })
      await ctx.serial('agent/created', { agent, source: 'startup' })
      await new Promise(resolve => setTimeout(resolve, 200))

      // Start in 'both' mode — should not have PTC tools.
      const visible = () => ctx.get('tools').schemas(agent).map(t => t.name).filter(n => n.startsWith('ops_')).sort()
      assert.equal(visible().includes('ops_load_sdk'), false, 'both mode should not have PTC tools initially')

      // Flip to ptc.
      agent.lift()
      await agent.ctx.plugin({ inject: ['tools'], apply(inner) { agent.lift = inner.tools.presentAs('ptc') } })
      await ctx.serial('agent/pre-step', { agent, messages: [], turn: 1, step: ++serial, signal: new AbortController().signal }, () => Promise.resolve({ kind: 'continue' }))
      await new Promise(resolve => setTimeout(resolve, 100))

      assert.ok(visible().includes('ops_load_sdk'), 'ptc mode must publish PTC tools after transition')
    } finally {
      await shutdown(ctx)
    }
  })
})

report('ptc-modeFor-precheck')
