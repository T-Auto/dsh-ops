/** Per-request UTF-8 bytes from the real pinned host, including wire schemas and SDK text. */
import { createScope, scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import * as FsTools from '@deepseek-ai/dsh-tool-fs'
import * as SearchTools from '@deepseek-ai/dsh-tool-fs-search'
import * as ops from '../lib/index.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { selectExecutor, prepareStep } from './lib/executor.mjs'
import { assert, test, report, withTempDir, waitFor } from './lib/harness.mjs'

// Includes all host text/wire, not just the plugin delta. No tokenizer/cache claims.
// Pre-slice win32 baseline: minimal=10516, standard=19996, cordis=19996, ptc=29639.
// Windows is the largest default surface (OPS Bash); POSIX must fit the same bounds.
const budgets = { minimal: 8100, standard: 13700, cordis: 13700, ptc: 19200 }
await test('each default preset stays within its resident per-request byte budget', async () => {
  await withTempDir('prompt-budget', async root => {
    const { ctx } = await bootHost()
    const scopes = []
    try {
      await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem)
      await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: 'workspace-write', workspaceRoot: root, sessionId: session.id }) }))
      await ctx.plugin(NodePtc)
      const presets = new Map()
      ctx.provide('agentPresets', { composedPreset: scoped => presets.get(scopeParentOf(scopeOf(scoped))) })
      const agents = []
      // This schema-only fixture does not execute commands, but complete-capability
      // publication still requires the same explicit authority services as a host.
      ctx.provide('agents', { list: () => agents.map(row => row.agent), get: id => agents.find(row => row.agent.id === id)?.agent })
      ctx.provide('sessions', { get: id => agents.find(row => row.agent.session.id === id)?.agent.session })
      ctx.provide('shellEnv', { collect: () => ({}) })
      const capture = async agent => {
        const prepared = await prepareStep(ctx, agent)
        try {
          const text = prepared.assembly.sections.filter(row => row.text).map(row => row.text).join('\n\n')
          const promptBytes = Buffer.byteLength(text), wireBytes = Buffer.byteLength(JSON.stringify(prepared.assembly.tools))
          return { promptBytes, wireBytes, totalBytes: promptBytes + wireBytes }
        } finally { prepared.dispose() }
      }
      for (const preset of Object.keys(budgets)) {
        const parent = createScope(ctx, { preset }); scopes.push(parent)
        presets.set(scopeOf(parent.ctx), preset)
        await parent.ctx.plugin(FsTools, {})
        await parent.ctx.plugin(SearchTools, { sampleOverCapGlobResults: false })
        const agent = { id: `budget-${preset}`, session: { id: `budget-${preset}`, mode: 'workspace-write', header: { cwd: root } } }
        await parent.ctx.plugin({ inject: ['tools'], apply(inner) {
          const scope = createScope(inner, agent, { parent: scopeOf(parent.ctx) }); scopes.push(scope); agent.ctx = scope.ctx
        } })
        await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, preset === 'ptc' ? 'ptc' : 'native') } })
        agents.push({ preset, agent, before: await capture(agent) })
      }
      // Pin a resolved shell without running it: same public schema/guidance as Windows defaults,
      // independent of whether this machine has installed the optional Bash payload.
      const shell = { bashPath: process.execPath }
      await ctx.plugin(ops, { minimal: shell, standard: shell, cordis: shell, ptc: shell })
      for (const { agent } of agents) await ctx.serial('agent/created', { agent, source: 'startup' })
      if (process.platform === 'win32') await waitFor(() => agents.every(({ agent }) => ctx.tools.get('ops_bash', agent)), { what: 'Bash publication after root authority readiness' })
      for (const { preset, agent, before } of agents) {
        const after = await capture(agent)
        const admitted = await prepareStep(ctx, agent)
        try {
          const names = ctx.get('tools').definitions(agent, admitted.toolSet).map(tool => tool.name)
          assert.equal(names.includes('ops_result'), false, `${preset}: result must not be resident`)
          assert.equal(names.includes('ops_read_files'), false, `${preset}: read_files must not be resident`)
          if (preset === 'ptc') {
            assert.deepEqual(admitted.assembly.tools.map(tool => tool.name), ['run_code'])
            assert.ok(names.includes('ops_load_sdk'))
            assert.ok(names.includes('ops_inspect_local_file'))
          } else {
            assert.ok(names.includes('ops_discover_tools'))
            for (const tool of ['ops_inspect_local_file', 'ops_glob', 'ops_grep']) assert.equal(names.includes(tool), preset !== 'minimal')
          }
          assert.equal(names.includes('ops_bash'), process.platform === 'win32')
        } finally { admitted.dispose() }
        console.log(JSON.stringify({ requestBytes: { preset, platform: process.platform, before, after, netBytes: after.totalBytes - before.totalBytes } }))
        assert.ok(after.totalBytes <= budgets[preset], `${preset}: ${after.totalBytes} > ${budgets[preset]} resident bytes`)
      }
    } finally {
      for (const scope of scopes.reverse()) await scope.dispose()
      await shutdown(ctx)
    }
  })
})
report('prompt-budget')
