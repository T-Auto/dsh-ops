/** The Native request's OPS-owned call guidance names its admitted tools. */
import { createScope } from '@deepseek-ai/dsh-scope'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { mountNative } from '../lib/publication/native.js'
import { mountReplacements } from '../lib/publication/replacements.js'
import { mountDiscovery } from '../lib/discovery/controller.js'
import { resolveConfig } from '../lib/config.js'
import { publicToolName } from '../lib/policy.js'
import { DISCOVERY_TOOL_NAME } from '../lib/capabilities/registry.js'
import { DESCRIPTIONS } from '../lib/capabilities/file.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { prepareStep, executeCall, selectExecutor } from './lib/executor.mjs'
import { requireWorker, WORKER } from './lib/boundary.mjs'
import { assert, test, report, withTempDir, waitFor } from './lib/harness.mjs'

requireWorker('native-guidance')
await test('directory refusal does not route to an absent file tool', () => {
  assert.match(DESCRIPTIONS.inspect_local_file, /Directories are rejected; choose a file\./)
  assert.doesNotMatch(DESCRIPTIONS.inspect_local_file, /use ops_glob or ops_grep/)
})
await test('Native guidance follows readiness, dynamic publication, hiding and mode changes', () => withTempDir('native-guidance', async cwd => {
  const { ctx } = await bootHost()
  let mounted, discovery, active = false, keep = false, refresh = () => {}
  const live = [], target = publicToolName('inspect_local_file')
  const gate = { allows: () => active, watch: notify => { refresh = notify; return () => {} } }
  try {
    for (const plugin of [Subprocess, Sandbox, FileSystem]) await ctx.plugin(plugin, {})
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: cwd }) })
    ctx.provide('agents', { list: () => [...live] })
    await ctx.plugin(ToolFs, { read: true, readImage: false, write: false, edit: false, applyPatch: false,
      readLimit: 2000, readMaxLineLength: 2000, readMaxBytes: 51200, readStreamMinSize: 1048576 })
    mounted = await ctx.plugin({ apply(inner) {
      mountNative(inner, resolveConfig({ required: true, binaryPath: WORKER }), { id: 'native-guidance', tools: ['inspect_local_file'], section: 'mode-standard', gate })
      mountReplacements(inner, { id: 'native-guidance', targets: new Map([['read', target]]), gate, keepOfficial: () => keep })
    } })
    await new Promise(resolve => setImmediate(resolve))
    const agent = { id: 'native-guidance', session: { id: 'native-guidance', mode: 'danger-full-access', header: { cwd } } }
    await ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
    live.push(agent)
    await ctx.serial('agent/created', { agent })
    const capture = async () => {
      const step = await prepareStep(ctx, agent)
      const names = step.assembly.tools.map(tool => tool.name)
      const own = step.assembly.sections.filter(section => section.name.startsWith('dsh-ops:')).map(section => section.text).join('\n').trim()
      // Only explicit table call targets are names; ordinary prose about reading is not a call.
      for (const [, name] of own.matchAll(/^\| [^|]+ \| ([a-z][a-z_]+) \|$/gm)) assert.ok(names.includes(name), `${name} is absent from ${names}`)
      assert.doesNotMatch(own, /Use (?:the )?read tool/)
      return { ...step, names, own }
    }
    const unavailable = await capture()
    assert.ok(unavailable.names.includes('read')); assert.ok(!unavailable.names.includes(target)); assert.equal(unavailable.own, '')
    unavailable.dispose()
    active = true; refresh()
    await waitFor(() => Boolean(ctx.tools.get(target, agent)), { what: 'Native reader publication' })
    const hidden = await capture()
    assert.ok(hidden.names.includes(target)); assert.ok(!hidden.names.includes('read'))
    assert.match(hidden.own, new RegExp(`Bounded UTF-8 lines / hex \\| ${target}`))
    // Pin the current host dependency rather than silently rewriting its prompt or registry.
    const hostRead = hidden.assembly.sections.find(section => section.name === 'tool:read')
    assert.match(hostRead.text, /Use the read tool/)
    console.log(`  Native host dependency: tool:read names read; admitted=${hidden.names.join(',')}`)
    hidden.dispose()
    keep = true
    const visible = await capture()
    assert.ok(visible.names.includes('read') && visible.names.includes(target)); visible.dispose()
    keep = false
    active = false; refresh()
    await waitFor(() => !ctx.tools.get(target, agent), { what: 'Native reader withdrawal' })
    const withdrawn = await capture()
    assert.ok(withdrawn.names.includes('read')); assert.ok(!withdrawn.names.includes(target)); assert.equal(withdrawn.own, '')
    withdrawn.dispose()
    active = true; refresh()
    await waitFor(() => Boolean(ctx.tools.get(target, agent)), { what: 'Native reader return' })
    discovery = await ctx.plugin({ apply(inner) { mountDiscovery(inner, { required: true, binaryPath: WORKER, enabled: true,
      allowedTools: ['glob'], alwaysLoaded: [] }, { allows: () => true, guidance: true }) } })
    await waitFor(() => Boolean(ctx.tools.get(publicToolName(DISCOVERY_TOOL_NAME), agent)), { what: 'Native discovery publication' })
    const before = await capture()
    assert.ok(!before.names.includes(publicToolName('glob')))
    const selected = await executeCall(ctx, { agent, name: publicToolName(DISCOVERY_TOOL_NAME), arguments: { query: 'select:' + publicToolName('glob') }, toolSet: before.toolSet })
    assert.equal(selected.isError, false, JSON.stringify(selected))
    assert.ok(!before.names.includes(publicToolName('glob')), 'the captured step remains immutable')
    before.dispose()
    await ctx.serial('session/event', agent.session, { type: 'sandbox/mode', data: { mode: 'danger-full-access' } })
    await ctx.serial('session/event', agent.session, { type: 'step/end', turn: 1, step: 1 })
    const cancelled = await capture()
    assert.ok(!cancelled.names.includes(publicToolName('glob')), 'authority change cancels a pending selection')
    assert.doesNotMatch(cancelled.own, /Find paths \| ops_glob/)
    assert.equal((await executeCall(ctx, { agent, name: publicToolName(DISCOVERY_TOOL_NAME),
      arguments: { query: 'select:' + publicToolName('glob') }, toolSet: cancelled.toolSet })).isError, false)
    cancelled.dispose()
    await ctx.serial('session/event', agent.session, { type: 'step/end', turn: 1, step: 2 })
    const after = await capture()
    assert.ok(after.names.includes(publicToolName('glob'))); assert.match(after.own, /Find paths \| ops_glob/)
    after.dispose()
    ctx.provide('ptcRuntime', { language: 'typescript' })
    const restore = selectExecutor(agent.ctx, 'ptc')
    const ptc = await capture()
    assert.deepEqual(ptc.names, ['run_code']); assert.equal(ptc.own, '')
    ptc.dispose(); restore(); selectExecutor(agent.ctx, 'native')
    const nativeAgain = await capture()
    assert.ok(nativeAgain.names.includes(target)); nativeAgain.dispose()
    await discovery.dispose(); discovery = undefined
    await mounted.dispose(); mounted = undefined
    const unloaded = await capture()
    assert.ok(unloaded.names.includes('read')); assert.ok(!unloaded.names.includes(target)); assert.equal(unloaded.own, '')
    unloaded.dispose()
  } finally { await discovery?.dispose(); await mounted?.dispose(); await shutdown(ctx) }
}))
report('native-guidance')
