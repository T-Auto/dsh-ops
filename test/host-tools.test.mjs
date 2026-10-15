/** Real host masks, prompt assembly, dispatch and volatile references; no native worker needed. */
import fs from 'node:fs'
import vm from 'node:vm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { Config, applyComponent } from '../lib/index.js'
import { BUILTIN_TOOLS, mountBuiltinTools, mountHostToolPolicy } from '../lib/host-tools.js'
import { resolveConfig } from '../lib/config.js'
import { assert, report, test, tick, waitFor } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'

const retained = ['read_image', 'foreign', 'ops_bash', 'ops_glob', 'ops_batch', 'ops_result', 'ops_job_start']
const definition = name => ({ name, description: `${name} fixture`, parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } } }, render: () => [] }, execute: () => ({ ok: true }) })
const visible = (ctx, agent) => ctx.tools.schemas(agent).map(tool => tool.name)
const assemble = (ctx, scope) => ctx.systemPrompt.assemble({ scope })
const request = (name, agent) => ({ name, agent, callId: 'test', arguments: {}, signal: new AbortController().signal })
async function agent(ctx, id, parent) {
  const result = { id, session: { id, mode: 'read-only', header: { cwd: process.cwd() } } }
  result.ctx = createScope(parent?.ctx ?? ctx, result, parent ? { parent } : undefined).ctx
  await ctx.serial('agent/created', { agent: result })
  return result
}
function fixtures(ctx, names = [...BUILTIN_TOOLS, ...retained]) {
  for (const name of names) ctx.tools.register(definition(name))
  for (const name of BUILTIN_TOOLS) ctx.systemPrompt.section({ name: `tool:${name}`, order: 100, text: `${name} instructions` })
}
async function policy(ctx, enabled = false) {
  const ref = createVolatile(enabled)
  let owner
  const fiber = await ctx.plugin({ inject: ['tools'], apply(inner) {
    owner = inner
    mountBuiltinTools(inner, ref, inner)
  } })
  return { fiber, ref, async set(value) {
    updateVolatile(ref, createVolatile(value))
    // The loader emits paths, scoped to the owning fiber, NOT the fiber as an argument.
    const target = Object.create(owner)
    const { Context } = await import('@deepseek-ai/cordis')
    target[Context.filter] = listener => listener.fiber === owner.fiber
    owner.emit(target, 'loader/volatile-update', [['hideBuiltinTools']])
    await tick()
  } }
}

await test('default-off schema preserves legacy config and rejects wrong switch types', () => {
  const config = Config({ bashPath: 'custom', promptPolicy: false })
  assert.equal(config.hideBuiltinTools.get(), false)
  assert.equal(config.bashPath, 'custom')
  assert.equal(config.promptPolicy, false)
  assert.equal(resolveConfig({}).hideBuiltinTools, false)
  assert.equal(resolveConfig({ hideBuiltinTools: true }).hideBuiltinTools, true)
  assert.throws(() => resolveConfig({ hideBuiltinTools: 'yes' }), /hideBuiltinTools/)
  assert.throws(() => Config({ hideBuiltinTools: 'yes' }))
})

await test('default off, live on/off, existing and nested agents, unload and remount', async () => {
  const { ctx } = await bootHost()
  try {
    fixtures(ctx)
    const first = await agent(ctx, 'existing')
    await ctx.plugin(inner => inner.provide('agents', { list: () => [first] }))
    const p = await policy(ctx)
    assert.ok(BUILTIN_TOOLS.every(name => visible(ctx, first).includes(name)))
    assert.notEqual((await ctx.tools.execute(request('read', first))).isError, true)
    const before = JSON.stringify(await assemble(ctx, first))
    await p.set(true)
    const child = await agent(ctx, 'child', first)
    for (const a of [first, child]) {
      await waitFor(() => BUILTIN_TOOLS.every(name => !visible(ctx, a).includes(name)), { timeoutMs: 1000, what: `${a.id}: ${visible(ctx, a).join(',')}` })
      assert.ok(retained.every(name => visible(ctx, a).includes(name)))
      const assembly = await assemble(ctx, a)
      assert.ok(assembly.tools.every(tool => !BUILTIN_TOOLS.includes(tool.name)))
      assert.ok(assembly.sections.every(section => !BUILTIN_TOOLS.some(name => section.name === `tool:${name}`)))
    }
    assert.ok(BUILTIN_TOOLS.every(name => visible(ctx).includes(name)), 'global registry must remain untouched')
    assert.equal(Object.hasOwn(ctx.tools, 'register'), false)
    await p.set(false)
    assert.equal(JSON.stringify(await assemble(ctx, first)), before)
    await p.set(true)
    await p.fiber.dispose()
    assert.ok(BUILTIN_TOOLS.every(name => visible(ctx, first).includes(name)))
    assert.notEqual((await ctx.tools.execute(request('read', first))).isError, true)
    const second = await policy(ctx, true)
    assert.ok(BUILTIN_TOOLS.every(name => !visible(ctx, first).includes(name)))
    await second.fiber.dispose()
    await ctx.serial('agent/disposed', { agent: child })
  } finally { await shutdown(ctx) }
})

await test('dynamic tools refresh without event loops; own-scope definitions stay guarded and unadvertised', async () => {
  const { ctx } = await bootHost()
  try {
    fixtures(ctx, retained)
    const p = await policy(ctx, true)
    const a = await agent(ctx, 'dynamic')
    let changes = 0
    ctx.on('tools/change', () => { assert.ok(++changes < 100, 'restriction update loop') })
    const remove = ctx.tools.register(definition('read'))
    assert.equal(visible(ctx, a).includes('read'), false)
    remove()
    ctx.tools.register(definition('read'))
    assert.equal(visible(ctx, a).includes('read'), false)
    await a.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.register(definition('edit')) } })
    assert.ok(visible(ctx, a).includes('edit'), 'host exempts own definitions from restrict()')
    assert.equal((await assemble(ctx, a)).tools.some(t => t.name === 'edit'), false)
    // A later pre-execute listener trying to force-allow cannot bypass the monotonic guard.
    await ctx.plugin(inner => inner.on('tools/pre-execute', () => ({ kind: 'allow' })))
    const result = await ctx.tools.execute(request('edit', a))
    assert.equal(result.isError, true)
    assert.match(result.error.message, /Use the available ops_\* tools/)
    assert.notEqual((await ctx.tools.execute(request('read_image', a))).isError, true)
    await ctx.serial('agent/disposed', { agent: a })
    assert.ok(visible(ctx, a).includes('read'), 'agent masks must be lifted')
    await p.fiber.dispose()
    assert.notEqual((await ctx.tools.execute(request('edit', a))).isError, true)
  } finally { await shutdown(ctx) }
})

await test('native/both/PTC and TypeScript/Python SDKs agree; keep run_code and ops PTC/background capabilities', async () => {
  for (const language of ['typescript', 'python']) {
    const { ctx } = await bootHost()
    try {
      fixtures(ctx)
      await ctx.plugin(inner => inner.provide('ptcRuntime', { language }))
      const p = await policy(ctx, true)
      for (const mode of ['native', 'both', 'ptc']) {
        const a = await agent(ctx, `${language}-${mode}`)
        await a.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { inner.tools.presentAs(mode) } })
        // Own-scope tools force SDK regeneration rather than relying only on restrict().
        await a.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.register(definition('write')) } })
        const assembly = await assemble(ctx, a)
        assert.ok(assembly.tools.every(t => !BUILTIN_TOOLS.includes(t.name)))
        if (mode === 'ptc') assert.deepEqual(assembly.tools.map(t => t.name), ['run_code'])
        if (mode !== 'native') {
          assert.ok(assembly.tools.some(t => t.name === 'run_code'))
          const sdk = assembly.sections.find(s => s.name === 'tools:sdk').text
          for (const name of retained) assert.ok(sdk.includes(name), `${language} SDK missing ${name}`)
          assert.doesNotMatch(sdk, language === 'python' ? /async def (write|read|bash)\(/ : /^\s+(write|read|bash):/m)
          assert.ok(sdk.includes('ok'), 'preserve output schemas')
        }
      }
      await p.set(false)
      await p.fiber.dispose()
    } finally { await shutdown(ctx) }
  }
})

await test('legacy deny-host-shell composes with the switch and survives turning it off', async () => {
  const { ctx } = await bootHost()
  try {
    fixtures(ctx)
    const legacy = await ctx.plugin({ inject: ['tools'], apply(inner) { mountHostToolPolicy(inner, { denied: ['bash'], reason: () => 'legacy policy' }) } })
    const p = await policy(ctx, true)
    const a = await agent(ctx, 'composed')
    await p.set(false)
    await waitFor(() => !visible(ctx, a).includes('bash'))
    assert.equal(visible(ctx, a).includes('bash'), false)
    assert.ok(visible(ctx, a).includes('read'))
    await p.fiber.dispose()
    assert.equal(visible(ctx, a).includes('bash'), false)
    await legacy.dispose()
    assert.ok(visible(ctx, a).includes('bash'))
  } finally { await shutdown(ctx) }
})

await test('real file entry unwraps the volatile flag and unload restores host tools without a worker', async () => {
  const { ctx } = await bootHost()
  try {
    fixtures(ctx)
    const fiber = await ctx.plugin({ Config, apply(inner, raw) { return applyComponent(inner, raw, 'file') } }, { hideBuiltinTools: true, configUpdateVersion: 1 })
    const a = await agent(ctx, 'component')
    await waitFor(() => !visible(ctx, a).includes('read'))
    assert.equal(visible(ctx, a).includes('read'), false)
    await fiber.dispose()
    assert.ok(visible(ctx, a).includes('read'))
  } finally { await shutdown(ctx) }
})

await test('browser companion registers the existing file-row switch and persists immediately, surfacing failures', async () => {
  let plugin, panel, registration, written, fail = false
  const elements = [], state = []
  let index = 0
  const fakeRequire = name => name === 'react' ? {
    createElement(type, props, ...children) { const result = { type, props, children }; elements.push(result); return result },
    useState(value) { const i = index++; if (state[i] === undefined) state[i] = value; return [state[i], v => { state[i] = v }] },
  } : { Switch: 'switch' }
  vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: module => { assert.equal(module.id, 'dsh-ops'); plugin = module.factory(fakeRequire) } } },
  })
  const form = { async set(key, value) { written = [key, value]; return !fail } }
  plugin.apply({ effect: fn => fn(), locale: { register: () => () => {} },
    configForms: { get: id => { assert.equal(id, 'dsh-ops-file'); return form }, whileServed: (_ids, fn) => fn() },
    slots: { inject: (_slot, fn) => fn(), register(reg, component) { registration = reg; panel = component; return () => {} } } })
  assert.equal(registration.key, 'dsh-ops#dsh-ops-file')
  const props = { view: 'page', useBuiltinTools: select => select({ status: 'ready', writable: true, value: {} }),
    setHidden: registration.inject().setHidden, t: key => key }
  const render = () => { index = 0; elements.length = 0; return panel(props) }
  render()
  const control = elements.find(e => e.type === 'switch')
  assert.equal(control.props.checked, false)
  await control.props.onChange(true)
  assert.deepEqual(written, ['hideBuiltinTools', true])
  fail = true
  await control.props.onChange(false)
  render()
  assert.ok(elements.some(e => e.props?.role === 'alert'))
})

report('host-tools')
