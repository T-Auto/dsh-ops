/** Shipped eight-row bundle + representative standard-preset fs/search plugins, real DSH registry/prompt/services. */
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsTools from '@deepseek-ai/dsh-tool-fs'
import * as SearchTools from '@deepseek-ai/dsh-tool-fs-search'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import { createScope, scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'
import { evaluate, isJsExpr } from '@deepseek-ai/cordis-plugin-loader'
import { bootHost, shutdown } from './lib/host.mjs'
import { assert, test, report, waitFor, withTempDir, PACKAGE_ROOT } from './lib/harness.mjs'
import { resolveWorker } from '../lib/ptc/runtime.js'
import { modeSectionName, publicToolName } from '../lib/policy.js'

const { parse } = YAML
resolveWorker({})
// The shipped data-only bundle uses the public serialized Loader expression for platform defaults.
const rows = parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8'))[0].insert
const enabled = row => !(isJsExpr(row.disabled) ? evaluate({ process }, row.disabled.__jsExpr) : row.disabled)
assert.deepEqual(rows.map(row => [row.id, row.name]), [['dsh-ops', 'dsh-ops']])

/** Mount the shipped enabled rows, each under its own component name. */
async function mountBundle(ctx) {
  // One row, named like the package: the package root is the whole plugin.
  for (const row of rows.filter(enabled)) await ctx.plugin(await import('../lib/index.js'), row.config)
}

/**
 * One real agent scope: fs/search official rows in the preset composition scope,
 * a presentation, and a preset-identity stub. Official tools live in the preset
 * parent scope exactly as the host composes a built-in preset; the agent scope
 * inherits them, and an agent-scope restriction can only hide inherited names.
 */
async function mintAgent(ctx, presets, { id, mode, root, preset, presentation }) {
  const presetScope = createScope(ctx, { preset: `${id}-preset` }).ctx
  presets.set(scopeOf(presetScope), preset)
  // These are the real standard-preset tool-fs and tool-fs-search rows, not fake
  // official schema fixtures. No unrelated full-preset services.
  await presetScope.plugin(FsTools, {})
  await presetScope.plugin(SearchTools, { sampleOverCapGlobResults: false })
  const agent = { id, session: { id, mode, header: { cwd: root } } }
  // Create the agent scope from a tools-injected context: the scoped context
  // inherits that dependency API, so per-agent restrictions are callable.
  await presetScope.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent, { parent: scopeOf(presetScope) }).ctx } })
  await agent.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.presentAs(presentation) } })
  await ctx.serial('agent/created', { agent, source: 'startup' })
  return agent
}

for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) {
  await test(`default bundle publishes the matching preset surface with standard fs/search under ${mode}`, async () => {
    await withTempDir('bundle-startup', async root => {
      const { ctx } = await bootHost()
      try {
        await ctx.plugin(Subprocess)
        await ctx.plugin(Sandbox, {})
        await ctx.plugin(FileSystem, {})
        await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: root, sessionId: session.id }) }))
        await ctx.plugin(NodePtc, {})
        const presets = new Map()
        // The real host exposes a preset registry; this stub answers for this
        // fixture's scopes only, exactly as `composedPreset(agent.ctx)` does.
        ctx.provide('agentPresets', { composedPreset: scoped => presets.get(scopeParentOf(scopeOf(scoped))) })
        await mountBundle(ctx)
        const names = agent => ctx.get('tools').schemas(agent).map(tool => tool.name)
        // `scope` drives the tool projection; route-section text additionally
        // reads the live `agent`.
        const assembled = agent => ctx.get('systemPrompt').assemble({ scope: agent, agent, signal: new AbortController().signal })

        // A Standard-preset agent receives the resident native file tools, their
        // discovery entry, and no replaced official file tools.
        const standard = await mintAgent(ctx, presets, { id: `${mode}-standard`, mode, root, preset: 'standard', presentation: 'native' })
        await waitFor(() => names(standard).includes('ops_read_files') && names(standard).includes('ops_discover_tools'), { what: `${mode} standard publication` })
        for (const resident of ['ops_inspect_local_file', 'ops_glob', 'ops_grep', 'ops_read_files', 'ops_result']) assert.ok(names(standard).includes(resident), `${resident}: ${names(standard).join(', ')}`)
        await waitFor(() => ['read', 'glob', 'grep'].every(name => !names(standard).includes(name)), { what: `${mode}: standard replacement hides official file tools` })
        assert.ok(names(standard).includes('write'), 'defaults must not mask standard-preset mutation tools')
        assert.equal(names(standard).includes('ops_bash'), process.platform === 'win32', 'POSIX keeps the host bash; Windows replaces pwsh')
        const standardPrompt = await assembled(standard)
        assert.ok(standardPrompt.sections.some(section => section.name === modeSectionName('mode-standard') && String(section.text).includes('ops_read_files')), 'standard routing section names the resident surface')
        const result = await ctx.get('tools').get('ops_read_files', standard).execute({ files: [{ path: path.join(root, 'absent') }] }, { agent: standard, signal: new AbortController().signal })
        assert.equal(result.items[0].error.code, 'NOT_FOUND', JSON.stringify(result))
        console.log(`    startup ${mode}/standard: ${standardPrompt.tools.length} wire tools; resident OPS replaces read/glob/grep`)

        // A Cordis-preset agent is served by its own row, with its own section.
        const cordis = await mintAgent(ctx, presets, { id: `${mode}-cordis`, mode, root, preset: 'cordis', presentation: 'native' })
        await waitFor(() => names(cordis).includes('ops_read_files'), { what: `${mode} cordis publication` })
        await waitFor(() => !names(cordis).includes('read'), { what: `${mode}: cordis replaces read` })
        const cordisPrompt = await assembled(cordis)
        assert.ok(cordisPrompt.sections.some(section => section.name === modeSectionName('mode-cordis') && String(section.text).length > 0), 'cordis routing section')

        // The Minimal preset keeps its official tools and receives only the
        // discovery entry. It publishes no routing section.
        const minimal = await mintAgent(ctx, presets, { id: `${mode}-minimal`, mode, root, preset: 'minimal', presentation: 'native' })
        await waitFor(() => names(minimal).includes('ops_discover_tools'), { what: `${mode} minimal discovery entry` })
        for (const resident of ['ops_inspect_local_file', 'ops_read_files', 'ops_glob', 'ops_grep']) assert.equal(names(minimal).includes(resident), false, `${mode}: minimal publishes no ${resident}`)
        for (const official of ['read', 'glob', 'grep']) assert.ok(names(minimal).includes(official), `${mode}: minimal keeps ${official}`)
        const minimalPrompt = await assembled(minimal)
        assert.equal(minimalPrompt.sections.some(section => section.name.startsWith('dsh-ops:repository-tooling:mode-') && String(section.text).trim() !== ''), false, 'minimal publishes no routing text')

        // A PTC-preset agent publishes the scoped SDK surface and no native
        // routing text; official file tools stay visible (the PTC row replaces none).
        const ptc = await mintAgent(ctx, presets, { id: `${mode}-ptc`, mode, root, preset: 'ptc', presentation: 'ptc' })
        await waitFor(() => names(ptc).includes('ops_load_sdk'), { what: `${mode} PTC publication` })
        assert.equal(names(ptc).includes('read'), true, 'the PTC row replaces no official file tool')
        const ptcPrompt = await assembled(ptc)
        assert.deepEqual(ptcPrompt.tools.map(tool => tool.name), ['run_code'])
        assert.ok(ptcPrompt.sections.some(section => section.name === modeSectionName('mode-ptc') && String(section.text).length > 0), 'PTC routing section')
        await waitFor(() => !names(ptc).includes('ops_discover_tools'), { what: `${mode} discovery withdrawal in PTC presentation` })
      } finally { await shutdown(ctx) }
    })
  })
}
await test('a missing optional Bash leaves the native file surface available', async () => {
  await withTempDir('bundle-no-bash', async root => {
    const { ctx } = await bootHost()
    try {
      await ctx.plugin(Subprocess)
      await ctx.plugin(Sandbox, {})
      await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: root, sessionId: session.id }) }))
      const presets = new Map()
      ctx.provide('agentPresets', { composedPreset: scoped => presets.get(scopeParentOf(scopeOf(scoped))) })
      for (const row of rows.filter(enabled)) {
        await ctx.plugin(await import('../lib/index.js'), {
          ...row.config, standard: { ...row.config.standard, bashPath: path.join(root, 'absent-bash.exe') },
        })
      }
      const presetScope = createScope(ctx, { preset: 'no-bash-preset' }).ctx
      presets.set(scopeOf(presetScope), 'standard')
      const agent = { id: 'no-bash', session: { id: 'no-bash', mode: 'workspace-write', header: { cwd: root } } }
      await presetScope.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent, { parent: scopeOf(presetScope) }).ctx } })
      await ctx.serial('agent/created', { agent, source: 'startup' })
      const names = () => ctx.get('tools').schemas(agent).map(tool => tool.name)
      await waitFor(() => names().includes('ops_read_files'), { what: 'native file publication without optional Bash' })
      assert.equal(names().includes('ops_bash'), false)
      const result = await ctx.get('tools').get('ops_read_files', agent).execute({ files: [{ path: path.join(root, 'absent') }] }, { agent, signal: new AbortController().signal })
      assert.equal(result.items[0].status, 'error', JSON.stringify(result))
      assert.equal(result.items[0].error.code, 'NOT_FOUND')
    } finally { await shutdown(ctx) }
  })
})
report('bundle-startup')
