/** Real host mount checks, also run before the legacy mount suite's runtime gate. */
import { registerNativeProvider } from '../../lib/file/result-provider.js'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as hiding from '../../lib/official-tool-hiding.js'
import { legacyComponent } from './legacy-component.mjs'
const { apply } = legacyComponent(hiding)
import { platformSurface } from '../../lib/official-tool-catalog.js'
import { FILE_TOOLS, publicToolName } from '../../lib/policy.js'
import { assert, test, waitFor } from './harness.mjs'
import { bootHost, registryHasOwnRegister, registryNames, scopedToolNames, shutdown } from './host.mjs'

/**
 * The exact 48 tools a stock desktop session reported in #207 as "no registered
 * equivalent OPS capability". It is the deterministic input for the regression:
 * `write` and `edit` are inside the file face, the other 46 are host
 * capabilities the component never takes over. Frozen so a future edit cannot
 * quietly change the fixture the issue was filed against.
 */
export const STOCK_UNSUPPORTED_48 = Object.freeze([
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
  'session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read',
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  'ralph', 'load_workspace_dependencies', 'write', 'edit',
  'job_output', 'job_list', 'job_kill', 'skill', 'web_search', 'web_fetch', 'present', 'read_image',
  'send_message', 'interrupt_agent', 'list_agents', 'workflow', 'todo_write',
  'get_goal', 'create_goal', 'update_goal', 'ask_user_question', 'exit_plan_mode',
  'subagent_fork', 'schedule_create', 'schedule_list', 'schedule_delete', 'schedule_update',
  'subagent', 'spawn_teammate', 'wait_agent',
  'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update',
])

const tool = name => ({ name, description: `fixture ${name}`, parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => `ran:${name}` })
async function mint(ctx, id, parent) {
  const agent = { id, session: { id, header: { cwd: process.cwd() } } }
  await (parent?.ctx ?? ctx).plugin({ inject: ['tools', 'systemPrompt'], apply(inner) {
    agent.ctx = createScope(inner, agent, parent ? { parent } : undefined).ctx
  } })
  await ctx.serial('agent/created', { agent })
  return agent
}
async function mount(ctx, config = { replaceTools: ['read', 'glob', 'grep'] }) {
  const fiber = await ctx.plugin({ name: 'fixture-selected-replacements', apply }, config)
  // Injected fibers activate after the owning component's mount resolves.
  await new Promise(resolve => setImmediate(resolve))
  return fiber
}
/** Capture host warnings without touching the registry or the real logger sink. */
function warningsFrom(ctx) {
  const warnings = []
  ctx.logger.exporter({
    levels: { default: 4 },
    export(message) { if (message.type === 'warn') warnings.push(message.args.join(' ')) },
  })
  return warnings
}
const replacement = (ctx, name) => registerNativeProvider(ctx, [tool(publicToolName(name))], definition => ctx.tools.register(definition))
const replacements = ctx => Promise.all(FILE_TOOLS.map(name => replacement(ctx, name)))
const assemble = (ctx, agent) => ctx.get('systemPrompt').assemble({ scope: agent })
const execute = (ctx, agent, name) => ctx.get('tools').execute({ agent, name, arguments: {}, callId: 'hide-test', signal: new AbortController().signal })

export async function officialToolHidingMountChecks() {
  await test('selected replacements remove official schemas and dispatch, preserves unrelated scopes, and lifts on unload', async () => {
    const { ctx } = await bootHost()
    try {
      await replacements(ctx)
      const retained = platformSurface().retainedCommand
      for (const name of ['read', 'glob', 'grep', retained, 'foreign']) ctx.tools.register(tool(name))
      const existing = await mint(ctx, 'existing-hide-agent')
      await ctx.plugin(inner => inner.provide('agents', { list: () => [existing] }))
      const hiding = await mount(ctx)
      const current = await mint(ctx, 'new-hide-agent')
      for (const agent of [existing, current]) {
        const names = scopedToolNames(ctx, agent)
        for (const name of ['read', 'glob', 'grep']) {
          assert.equal(names.includes(name), false)
          assert.equal(ctx.tools.get(name, agent), undefined)
          assert.ok(registryNames(ctx).includes(name))
        }
        assert.ok(names.includes(retained)); assert.ok(names.includes('foreign'))
        const assembly = await assemble(ctx, agent)
        assert.deepEqual(assembly.tools.map(s => s.name).sort(), names)
      }
      assert.equal(registryHasOwnRegister(ctx), false)
      for (const api of ['restrict', 'guard', 'schemas', 'get']) assert.equal(Object.hasOwn(ctx.get('tools'), api), false)
      const first = await mint(ctx, 'foreign-scope-one'), second = await mint(ctx, 'foreign-scope-two')
      for (const agent of [first, second]) agent.ctx.tools.register(tool('foreign-local'))
      assert.equal(registryNames(ctx).includes('foreign-local'), false)
      assert.ok((await execute(ctx, current, 'read')).isError)
      assert.equal((await execute(ctx, current, 'foreign')).isError, false)
      await hiding.dispose()
      assert.ok(scopedToolNames(ctx, current).includes('read'))
      assert.equal((await execute(ctx, current, 'read')).isError, false)
      assert.ok((await assemble(ctx, current)).tools.some(t => t.name === 'read'))
    } finally { await shutdown(ctx) }
  })
  await test('unselected stock tools stay visible and dispatchable without warning lists', async () => {
    const { ctx } = await bootHost()
    try {
      await replacements(ctx)
      for (const name of ['read', 'glob', 'grep', ...STOCK_UNSUPPORTED_48]) ctx.tools.register(tool(name))
      const warnings = warningsFrom(ctx)
      await mount(ctx, { replaceTools: ['read'] })
      const agent = await mint(ctx, 'stock-desktop-48')
      const names = (await assemble(ctx, agent)).tools.map(schema => schema.name)
      for (const name of ['glob', 'grep', ...STOCK_UNSUPPORTED_48]) {
        assert.ok(names.includes(name), name)
        assert.equal((await execute(ctx, agent, name)).isError, false, name)
      }
      assert.equal(names.includes('read'), false)
      assert.equal((await execute(ctx, agent, 'read')).isError, true)
      assert.deepEqual(warnings.filter(message => message.includes('dsh-ops hide-official')), [])
    } finally { await shutdown(ctx) }
  })
  await test('each selected tool needs only its own reviewed counterpart', async () => {
    for (const [official, replacement] of [['read', 'inspect_local_file'], ['glob', 'glob'], ['grep', 'grep']]) {
      const { ctx } = await bootHost()
      try {
        await registerNativeProvider(ctx, [tool(publicToolName(replacement))], definition => ctx.tools.register(definition))
        for (const name of ['read', 'glob', 'grep', 'write', 'edit', 'foreign']) ctx.tools.register(tool(name))
        await mount(ctx, { replaceTools: [official] })
        const agent = await mint(ctx, 'one-selection-' + official)
        const names = (await assemble(ctx, agent)).tools.map(schema => schema.name)
        for (const name of ['read', 'glob', 'grep', 'write', 'edit', 'foreign']) {
          assert.equal(names.includes(name), name !== official, name)
          assert.equal((await execute(ctx, agent, name)).isError, name === official, name)
        }
      } finally { await shutdown(ctx) }
    }
  })
  await test('a missing selected counterpart restores every mask and fails closed', async () => {
    const { ctx } = await bootHost()
    try {
      await replacement(ctx, 'glob')
      for (const name of ['read', 'glob', 'foreign', 'ops_read']) ctx.tools.register(tool(name))
      await mount(ctx, { replaceTools: ['read', 'glob'] })
      const agent = await mint(ctx, 'missing-selection')
      await assert.rejects(() => assemble(ctx, agent), /read -> ops_inspect_local_file.*remove the selection from replaceTools/)
      for (const name of ['read', 'glob', 'foreign']) assert.ok(scopedToolNames(ctx, agent).includes(name))
      assert.equal((await execute(ctx, agent, 'foreign')).isError, true)
    } finally { await shutdown(ctx) }
  })
  await test('replacement withdrawal restores official tools but blocks the turn until readiness returns', async () => {
    const { ctx } = await bootHost()
    try {
      const disposers = await replacements(ctx)
      ctx.tools.register(tool('read'))
      await mount(ctx)
      const agent = await mint(ctx, 'live-readiness')
      assert.equal(scopedToolNames(ctx, agent).includes('read'), false)
      disposers[0]()
      assert.ok(scopedToolNames(ctx, agent).includes('read'))
      await assert.rejects(() => assemble(ctx, agent), /missing OPS surface:.*ops_inspect_local_file/)
      await replacement(ctx, FILE_TOOLS[0])
      await waitFor(() => !scopedToolNames(ctx, agent).includes('read'))
      await assemble(ctx, agent)
      // Unselected write stays visible without affecting selected read readiness.
      const disposeWrite = ctx.tools.register(tool('write'))
      const assembly = await assemble(ctx, agent)
      assert.ok(assembly.tools.some(schema => schema.name === 'write'))
      assert.equal(scopedToolNames(ctx, agent).includes('read'), false)
      disposeWrite()
      await assemble(ctx, agent)
    } finally { await shutdown(ctx) }
  })
  await test('own-scope official registration cannot be silently hidden by an inherited restriction', async () => {
    const { ctx } = await bootHost()
    try {
      await replacements(ctx)
      await mount(ctx)
      const agent = await mint(ctx, 'own-official')
      agent.ctx.tools.register(tool('read'))
      await assert.rejects(() => assemble(ctx, agent), /unknown global tool|cannot hide own-scope/)
      assert.equal((await execute(ctx, agent, 'read')).isError, true)
      assert.ok(scopedToolNames(ctx, agent).includes('read'))
    } finally { await shutdown(ctx) }
  })
  await test('the unselected PTC transport stays visible without warnings', async () => {
    const { ctx } = await bootHost()
    try {
      await replacements(ctx)
      ctx.provide('ptcRuntime', { language: 'typescript' })
      const warnings = warningsFrom(ctx)
      await mount(ctx)
      const agent = await mint(ctx, 'transport-not-exempt')
      const lift = agent.ctx.tools.presentAs('ptc')
      const assembly = await assemble(ctx, agent)
      assert.ok(assembly.tools.some(schema => schema.name === 'run_code'))
      assert.deepEqual(warnings.filter(message => message.includes('dsh-ops hide-official')), [])
      lift()
      await assemble(ctx, agent)
    } finally { await shutdown(ctx) }
  })
  await test('a run_code-presented scope is not gated by native readiness', async () => {
    const { ctx } = await bootHost({ toolsMode: 'ptc' })
    try {
      ctx.provide('ptcRuntime', { language: 'typescript' })
      for (const name of ['read', 'glob', 'grep', 'foreign']) ctx.tools.register(tool(name))
      // No OPS counterparts: in a run_code deployment they are SDK functions, never
      // owned native providers, so native readiness is unprovable there by design.
      await mount(ctx)
      const agent = await mint(ctx, 'ptc-scope-not-gated')
      const assembly = await assemble(ctx, agent)
      assert.ok(assembly.tools.some(schema => schema.name === 'run_code'))
      assert.ok(scopedToolNames(ctx, agent).includes('read'), 'nothing is hidden without a native replacement')
      const decision = await ctx.waterfall('tools/pre-execute', { agent, name: 'run_code' }, () => ({ kind: 'allow' }))
      assert.equal(decision.kind, 'allow', 'the transport is not blocked in a collapsed scope')
      for (const name of ['read', 'glob', 'grep']) {
        const refused = await ctx.waterfall('tools/pre-execute', { agent, name }, () => ({ kind: 'allow' }))
        assert.equal(refused.kind, 'deny', `${name} stays refused`)
        const nestedRefused = await ctx.waterfall('tools/pre-execute', { agent, name, parent: {} }, () => ({ kind: 'allow' }))
        assert.equal(nestedRefused.kind, 'deny', `${name} stays refused when dispatched from a program`)
      }
      // A later surface change must not put the transport back behind the readiness gate.
      ctx.tools.register(tool('post-collapse-probe'))
      const again = await ctx.waterfall('tools/pre-execute', { agent, name: 'run_code' }, () => ({ kind: 'allow' }))
      assert.equal(again.kind, 'allow', 'a later tools/change must not re-block the transport')
    } finally { await shutdown(ctx) }
  })
  await test('legacy blanket selections deactivate without guessing replacements or warning', async () => {
    for (const scope of ['takeover', 'extended', 'off']) {
      const { ctx } = await bootHost()
      try {
        for (const name of ['read', 'glob', 'grep', 'custom_delegate', 'stagehand_tabs', 'cua_driver_native__click']) ctx.tools.register(tool(name))
        const warnings = warningsFrom(ctx)
        await mount(ctx, { strict: true, scope, additionalOfficialTools: ['custom_delegate', 'read'] })
        const agent = await mint(ctx, 'legacy-' + scope)
        const names = (await assemble(ctx, agent)).tools.map(schema => schema.name)
        for (const name of ['read', 'glob', 'grep', 'custom_delegate', 'stagehand_tabs', 'cua_driver_native__click']) {
          assert.ok(names.includes(name), name)
          assert.equal((await execute(ctx, agent, name)).isError, false, name)
        }
        assert.deepEqual(warnings.filter(message => message.includes('dsh-ops hide-official')), [])
      } finally { await shutdown(ctx) }
    }
  })
  await test('a root that loses its OPS surface does not stop a healthy root', async () => {
    const { ctx } = await bootHost()
    try {
      await replacements(ctx); ctx.tools.register(tool('read')); ctx.tools.register(tool('foreign'))
      await mount(ctx)
      const a = await mint(ctx, 'independent-a'), b = await mint(ctx, 'independent-b')
      await assemble(ctx, a); await assemble(ctx, b)
      const lift = b.ctx.tools.restrict({ deny: [publicToolName('inspect_local_file')] })
      await assert.rejects(() => assemble(ctx, b), /missing OPS surface:.*ops_inspect_local_file/)
      assert.equal((await execute(ctx, b, 'foreign')).isError, true)
      assert.ok(scopedToolNames(ctx, b).includes('read'), 'failed root has no partial mask')
      assert.equal(scopedToolNames(ctx, a).includes('read'), false)
      await assemble(ctx, a)
      assert.equal((await execute(ctx, a, 'foreign')).isError, false)
      lift()
      await assemble(ctx, b)
      assert.equal(scopedToolNames(ctx, b).includes('read'), false)
    } finally { await shutdown(ctx) }
  })
  await test('a failed child is blocked without stopping its healthy parent or unrelated root', async () => {
    const { ctx } = await bootHost()
    try {
      await replacements(ctx); ctx.tools.register(tool('read')); ctx.tools.register(tool('foreign'))
      const hiding = await mount(ctx)
      const parent = await mint(ctx, 'independent-parent')
      const other = await mint(ctx, 'independent-root')
      const child = await mint(ctx, 'independent-child', parent)
      child.ctx.tools.register(tool('read'))
      await assert.rejects(() => assemble(ctx, child), /cannot hide own-scope/)
      assert.equal((await execute(ctx, child, 'foreign')).isError, true)
      assert.ok(scopedToolNames(ctx, child).includes('read'))
      for (const agent of [parent, other]) {
        await assemble(ctx, agent)
        assert.equal((await execute(ctx, agent, 'foreign')).isError, false)
        assert.equal(scopedToolNames(ctx, agent).includes('read'), false)
      }
      await ctx.serial('agent/disposed', { agent: child })
      await assemble(ctx, parent)
      await hiding.dispose()
      for (const agent of [parent, child, other]) assert.ok(scopedToolNames(ctx, agent).includes('read'))
    } finally { await shutdown(ctx) }
  })
  await test('inherited masks cannot conceal a child missing an OPS replacement', async () => {
    const { ctx } = await bootHost()
    try {
      await replacements(ctx); ctx.tools.register(tool('read')); ctx.tools.register(tool('foreign'))
      await mount(ctx)
      const parent = await mint(ctx, 'ready-parent')
      const child = await mint(ctx, 'filtered-child', parent)
      const lift = child.ctx.tools.restrict({ deny: [publicToolName('inspect_local_file')] })
      await assert.rejects(() => assemble(ctx, child), /missing OPS surface:.*ops_inspect_local_file/)
      assert.equal((await execute(ctx, child, 'foreign')).isError, true)
      await assemble(ctx, parent)
      assert.equal(scopedToolNames(ctx, parent).includes('read'), false)
      lift()
      await assemble(ctx, child)
      assert.equal(scopedToolNames(ctx, child).includes('read'), false)
    } finally { await shutdown(ctx) }
  })
  await test('missing host restriction/guard APIs block assembly with infrastructure diagnostics', async () => {
    const { ctx } = await bootHost({ withTools: false })
    try {
      // API-drift fixture, not an override of any shared registry method.
      ctx.provide('tools', { schemas: () => FILE_TOOLS.map(n => ({ name: publicToolName(n) })), get() {} })
      await mount(ctx)
      const agent = await mint(ctx, 'missing-host-api')
      await assert.rejects(() => assemble(ctx, agent), /missing host API: restrict, guard/)
      const decision = await ctx.waterfall('tools/pre-execute', { agent, name: 'foreign' }, () => ({ kind: 'allow' }))
      assert.equal(decision.kind, 'deny')
      assert.equal(decision.info.code, 'READINESS_BLOCKED')
    } finally { await shutdown(ctx) }
  })
  await test('foreign same-name tools and owned read_many cannot satisfy selected single-file read', async () => {
    const { ctx } = await bootHost()
    try {
      const removeForeign = ctx.tools.register(tool(publicToolName('inspect_local_file')))
      await replacement(ctx, 'read_files')
      for (const name of ['read', 'foreign']) ctx.tools.register(tool(name))
      await mount(ctx, { replaceTools: ['read'] })
      const agent = await mint(ctx, 'foreign-read-counterpart')
      await assert.rejects(() => assemble(ctx, agent), /missing OPS surface: read -> ops_inspect_local_file/)
      assert.ok(scopedToolNames(ctx, agent).includes('read'))
      assert.equal((await execute(ctx, agent, 'foreign')).isError, true)
      removeForeign()
      const removeOwned = await replacement(ctx, 'inspect_local_file')
      await assemble(ctx, agent)
      assert.equal(scopedToolNames(ctx, agent).includes('read'), false)
      removeOwned()
      ctx.tools.register(tool(publicToolName('inspect_local_file')))
      await assert.rejects(() => assemble(ctx, agent), /READINESS_BLOCKED/)
      assert.ok(scopedToolNames(ctx, agent).includes('read'))
    } finally { await shutdown(ctx) }
  })
  await test('a byte-identical foreign child shadow invalidates owned readiness without harming siblings', async () => {
    const { ctx } = await bootHost()
    try {
      await replacement(ctx, 'inspect_local_file')
      for (const name of ['read', 'foreign']) ctx.tools.register(tool(name))
      await mount(ctx, { replaceTools: ['read'] })
      const parent = await mint(ctx, 'identity-parent')
      const child = await mint(ctx, 'identity-child', parent)
      const sibling = await mint(ctx, 'identity-sibling', parent)
      const original = ctx.get('tools').get(publicToolName('inspect_local_file'), child)
      const before = JSON.stringify(ctx.get('tools').schemas(child))
      const removeShadow = child.ctx.tools.register({ ...original })
      assert.equal(JSON.stringify(ctx.get('tools').schemas(child)), before, 'schema bytes stay identical despite foreign ownership')
      assert.notEqual(ctx.get('tools').get(original.name, child), original)
      await assert.rejects(() => assemble(ctx, child), /READINESS_BLOCKED.*ops_inspect_local_file/)
      assert.equal((await execute(ctx, child, 'foreign')).isError, true)
      for (const healthy of [parent, sibling]) {
        await assemble(ctx, healthy)
        assert.equal((await execute(ctx, healthy, 'foreign')).isError, false)
        assert.equal(scopedToolNames(ctx, healthy).includes('read'), false)
      }
      removeShadow()
      await assemble(ctx, child)
      assert.equal(ctx.get('tools').get(original.name, child), original)
      assert.equal((await execute(ctx, child, 'foreign')).isError, false)
    } finally { await shutdown(ctx) }
  })
  await test('schema-only counterpart claims do not satisfy selected readiness', async () => {
    const { ctx } = await bootHost({ withTools: false })
    try {
      // Infrastructure fixture exposes a schema without a registered definition.
      ctx.provide('tools', {
        schemas: () => [{ name: publicToolName('inspect_local_file') }],
        get: () => undefined,
        restrict: () => () => {},
        guard: () => () => {},
      })
      await mount(ctx, { replaceTools: ['read'] })
      const agent = await mint(ctx, 'schema-without-registration')
      await assert.rejects(() => assemble(ctx, agent), /missing OPS surface: read -> ops_inspect_local_file/)
    } finally { await shutdown(ctx) }
  })
  await test('assembled injection of a hidden tool is rejected even when registry masking succeeded', async () => {
    const { ctx } = await bootHost()
    try {
      await replacements(ctx); ctx.tools.register(tool('read'))
      await mount(ctx)
      const agent = await mint(ctx, 'assembly-verification')
      ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
        const result = await next()
        result.tools.push({ name: 'read', description: 'injected', parameters: {} })
        return result
      })
      await assert.rejects(() => assemble(ctx, agent), /assembled surface still contains hidden official tools: read/)
      assert.equal(scopedToolNames(ctx, agent).includes('read'), false, 'assembly failure preserves the verified registry mask')
      await assert.rejects(() => assemble(ctx, agent), /assembled surface still contains hidden official tools: read/)
    } finally { await shutdown(ctx) }
  })
  await test('a host that appends tools after assembly still verifies the visible surface', async () => {
    const { ctx } = await bootHost()
    try {
      await replacements(ctx); ctx.tools.register(tool('read')); ctx.tools.register(tool('foreign'))
      // 0.2.1 hands the waterfall a presentation and attaches the tool array
      // afterwards; the guard must still prove the official tools are hidden.
      ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
        const tools = assembly.tools
        delete assembly.tools
        return { ...await next(), tools }
      })
      await mount(ctx)
      const agent = await mint(ctx, 'presentation-payload')
      const assembly = await assemble(ctx, agent)
      assert.equal(assembly.tools.some(entry => entry.name === 'read'), false, 'replacement surface is published')
      assert.equal((await execute(ctx, agent, 'foreign')).isError, false)
    } finally { await shutdown(ctx) }
  })
  await test('a PTC scope stays usable when the host attaches tools after assembly', async () => {
    const { ctx } = await bootHost({ toolsMode: 'ptc' })
    try {
      ctx.provide('ptcRuntime', { language: 'typescript' })
      // No native counterparts on purpose: in a run_code deployment the replacements are
      // SDK functions, so native readiness can never be proven there.
      for (const name of ['read', 'glob', 'grep', 'foreign']) ctx.tools.register(tool(name))
      // DSH 0.2.1 transforms the presentation here and attaches the tool array only after
      // the waterfall, so the guard receives no array at all.
      ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
        const tools = assembly.tools
        delete assembly.tools
        return { ...await next(), tools }
      })
      await mount(ctx)
      const agent = await mint(ctx, 'ptc-after-assembly')
      const assembly = await assemble(ctx, agent)
      assert.ok(assembly.tools.some(entry => entry.name === 'run_code'), 'the transport is published')
      assert.ok(scopedToolNames(ctx, agent).includes('read'), 'a collapsed scope hides nothing')
      const decision = await ctx.waterfall('tools/pre-execute', { agent, name: 'run_code' }, () => ({ kind: 'allow' }))
      assert.equal(decision.kind, 'allow', 'the transport stays dispatchable')
      for (const name of ['read', 'glob', 'grep']) {
        const refused = await ctx.waterfall('tools/pre-execute', { agent, name }, () => ({ kind: 'allow' }))
        assert.equal(refused.kind, 'deny', `${name} stays refused in a PTC scope`)
      }
    } finally { await shutdown(ctx) }
  })
  await test('a deferred tool array is judged by the ptc-only section', async () => {
    const { ctx } = await bootHost()
    try {
      ctx.provide('ptcRuntime', { language: 'typescript' })
      await replacements(ctx)
      for (const name of ['read', 'glob', 'grep', 'foreign']) ctx.tools.register(tool(name))
      ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
        const tools = assembly.tools
        delete assembly.tools
        return { ...await next(), tools }
      })
      await mount(ctx)
      const agent = await mint(ctx, 'ptc-deferred-after-assembly')
      const lift = agent.ctx.tools.presentAs('ptc')
      const assembly = await assemble(ctx, agent)
      assert.ok(assembly.tools.some(entry => entry.name === 'run_code'), 'the transport survives the deferred array')
      assert.equal(scopedToolNames(ctx, agent).includes('read'), false, 'the replacement mask still applies')
      lift()
    } finally { await shutdown(ctx) }
  })
  await test('a deferred tool array still fails closed when a counterpart is missing', async () => {
    const { ctx } = await bootHost()
    try {
      for (const name of ['read', 'foreign']) ctx.tools.register(tool(name))
      ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
        const tools = assembly.tools
        delete assembly.tools
        return { ...await next(), tools }
      })
      await mount(ctx)
      const agent = await mint(ctx, 'native-after-assembly')
      await assert.rejects(() => assemble(ctx, agent), /READINESS_BLOCKED/)
    } finally { await shutdown(ctx) }
  })
  await test('a fail-once prompt provider blocks only that assembly and recovers on the next request', async () => {
    const { ctx } = await bootHost()
    try {
      await replacements(ctx); ctx.tools.register(tool('read')); ctx.tools.register(tool('foreign'))
      await mount(ctx)
      const a = await mint(ctx, 'transient-a'), b = await mint(ctx, 'transient-b')
      await assemble(ctx, a); await assemble(ctx, b)
      let failOnce = true
      ctx.on('system-prompt/assemble', (assembly, context, next) => {
        if (context.scope === a && failOnce) { failOnce = false; throw new Error('transient fixture failure') }
        return next()
      })
      await assert.rejects(() => assemble(ctx, a), /could not be verified: transient fixture failure/)
      assert.equal(scopedToolNames(ctx, a).includes('read'), false)
      assert.equal(scopedToolNames(ctx, b).includes('read'), false, 'other root keeps its restriction')
      const recovered = await assemble(ctx, a)
      assert.equal(recovered.tools.some(t => t.name === 'read'), false)
      assert.equal((await execute(ctx, a, 'foreign')).isError, false)
      await assemble(ctx, b)
      assert.equal((await execute(ctx, b, 'foreign')).isError, false)
    } finally { await shutdown(ctx) }
  })
  await test('agent disposal lifts restrictions and remount does not retain old masks', async () => {
    const { ctx } = await bootHost()
    try {
      await replacements(ctx); ctx.tools.register(tool('read'))
      const first = await mount(ctx)
      const agent = await mint(ctx, 'disposal')
      assert.equal(scopedToolNames(ctx, agent).includes('read'), false)
      await ctx.serial('agent/disposed', { agent })
      assert.ok(scopedToolNames(ctx, agent).includes('read'))
      await first.dispose()
      const second = await mount(ctx)
      await ctx.serial('agent/created', { agent })
      assert.equal(scopedToolNames(ctx, agent).includes('read'), false)
      await second.dispose()
      assert.ok(scopedToolNames(ctx, agent).includes('read'))
    } finally { await shutdown(ctx) }
  })
  await test('empty selections are inert without warnings or a host API readiness gate', async () => {
    {
      const { ctx } = await bootHost()
      try {
        for (const name of ['read', 'glob', 'grep', ...STOCK_UNSUPPORTED_48]) ctx.tools.register(tool(name))
        const warnings = warningsFrom(ctx)
        await mount(ctx, { replaceTools: [] })
        const agent = await mint(ctx, 'scope-off')
        const assembly = await assemble(ctx, agent)
        const names = assembly.tools.map(schema => schema.name)
        for (const name of ['read', 'glob', 'grep', 'write', 'edit', 'subagent', 'terminal_send']) {
          assert.ok(names.includes(name), `${name} stays visible with scope off`)
        }
        assert.deepEqual([...scopedToolNames(ctx, agent)].sort(), [...names].sort())
        assert.equal(warnings.filter(message => message.includes('dsh-ops hide-official')).length, 0)
        assert.equal((await execute(ctx, agent, 'read')).isError, false)
        assert.equal((await execute(ctx, agent, 'subagent')).isError, false)
      } finally { await shutdown(ctx) }
    }
    {
      // No restrict/guard host API either: an inert row must not gate the session.
      const { ctx } = await bootHost({ withTools: false })
      try {
        ctx.provide('tools', { schemas: () => FILE_TOOLS.map(name => ({ name: publicToolName(name) })), get() {} })
        const warnings = warningsFrom(ctx)
        await mount(ctx, { replaceTools: [] })
        const agent = await mint(ctx, 'scope-off-no-host-api')
        await assemble(ctx, agent)
        assert.equal(warnings.filter(message => message.includes('dsh-ops hide-official')).length, 0)
      } finally { await shutdown(ctx) }
    }
  })
  await test('an unconfigured enabled row preserves official tools with no OPS registrations', async () => {
    const { ctx } = await bootHost()
    try {
      for (const name of ['read', 'glob', 'grep', 'foreign']) ctx.tools.register(tool(name))
      await mount(ctx, {})
      const agent = await mint(ctx, 'default-off')
      const names = (await assemble(ctx, agent)).tools.map(schema => schema.name)
      for (const name of ['read', 'glob', 'grep', 'foreign']) {
        assert.ok(names.includes(name), name)
        assert.equal((await execute(ctx, agent, name)).isError, false)
      }
    } finally { await shutdown(ctx) }
  })
  await test('changing selection through remount restores deselected tools', async () => {
    const { ctx } = await bootHost()
    try {
      await replacements(ctx)
      for (const name of ['read', 'glob', 'grep']) ctx.tools.register(tool(name))
      const first = await mount(ctx, { replaceTools: ['read'] })
      const agent = await mint(ctx, 'changed-selection')
      assert.equal(scopedToolNames(ctx, agent).includes('read'), false)
      await first.dispose()
      await mount(ctx, { replaceTools: ['glob'] })
      await ctx.serial('agent/created', { agent })
      const names = (await assemble(ctx, agent)).tools.map(schema => schema.name)
      assert.ok(names.includes('read'))
      assert.ok(names.includes('grep'))
      assert.equal(names.includes('glob'), false)
      assert.equal((await execute(ctx, agent, 'read')).isError, false)
    } finally { await shutdown(ctx) }
  })

}
