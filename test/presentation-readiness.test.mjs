import fs from 'node:fs'
import path from 'node:path'
import { createScope } from '@deepseek-ai/dsh-scope'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import * as PtcModule from '../lib/ptc/index.js'
import { registerNativeProvider, nativeProviders } from '../lib/file/result-provider.js'
import * as DiscoveryModule from '../lib/components/discovery/index.js'
import * as HidingModule from '../lib/components/hide-official/index.js'
import { isNativePresentation, isPresentationProbe } from '../lib/presentation.js'
import { publicToolName } from '../lib/policy.js'
import { bootHost, shutdown, scopedToolNames, registryHasOwnRegister } from './lib/host.mjs'
import { assert, test, report, withTempDir, waitFor } from './lib/harness.mjs'
import { legacyComponent } from './lib/legacy-component.mjs'
const Ptc = legacyComponent(PtcModule)
const Discovery = legacyComponent(DiscoveryModule)
const Hiding = legacyComponent(HidingModule)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tool = name => ({ name, description: name, parameters: { type: 'object' }, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) })
let sequence = 0
async function agentFor(ctx, cwd, parent, mode) {
  const id = 'readiness-' + ++sequence
  const agent = { id, session: { id, mode: 'danger-full-access', header: { cwd } } }
  await (parent?.ctx ?? ctx).plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent, parent ? { parent } : undefined).ctx } })
  if (mode) await agent.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.presentAs(mode) } })
  await ctx.serial('agent/created', { agent })
  return agent
}
for (const official of ['read', 'glob']) for (const hidingFirst of [true, false]) await test(`selected ${official} replacement becomes ready on first attach (hiding first: ${hidingFirst})`, () => withTempDir('presentation-ready', async cwd => {
  const raw = official === 'read' ? 'inspect_local_file' : 'glob'
  const retained = official === 'read' ? 'glob' : 'read'
  const { ctx } = await bootHost()
  try {
    await ctx.plugin(Subprocess); await ctx.plugin(Sandbox, {})
    await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: cwd }) }))
    ctx.tools.register(tool('glob')); ctx.tools.register(tool('read'))
    const mountHiding = () => ctx.plugin(Hiding, { replaceTools: [official] })
    const mountDiscovery = () => ctx.plugin(Discovery, { required: true, enabled: false, allowedTools: [raw], alwaysLoaded: [raw] })
    let discovery
    if (hidingFirst) { await mountHiding(); discovery = await mountDiscovery() }
    else { discovery = await mountDiscovery(); await mountHiding() }
    const agent = await agentFor(ctx, cwd)
    const assemble = () => ctx.systemPrompt.assemble({ scope: agent })
    assert.deepEqual((await assemble()).tools.map(tool => tool.name).sort(), [publicToolName(raw), retained].sort())
    assert.equal(registryHasOwnRegister(ctx), false)
    fs.writeFileSync(path.join(cwd, 'ready.txt'), 'ready')
    const request = name => ctx.tools.execute({ name, arguments: raw === 'glob' ? { pattern: ['*.txt'] } : { path: 'ready.txt' }, agent, callId: 'readiness', signal: new AbortController().signal })
    const executed = await request(publicToolName(raw))
    assert.equal(executed.isError, false); assert.equal(executed.value.status, 'completed', JSON.stringify(executed))
    assert.equal((await request(official)).isError, true, 'selected official dispatch remains blocked')
    ctx.provide('ptcRuntime', { language: 'typescript' })
    const lift = agent.ctx.tools.presentAs('ptc')
    // A run_code scope cannot own a native counterpart, so it is never masked and
    // never gated: the model receives the program entry and nothing else.
    assert.deepEqual((await assemble()).tools.map(tool => tool.name), ['run_code'])
    assert.ok(scopedToolNames(ctx, agent).includes(official), 'a collapsed scope hides nothing')
    const direct = await request(official)
    assert.equal(direct.isError, true, 'a direct official call stays refused in a collapsed scope')
    await waitFor(() => !scopedToolNames(ctx, agent).includes(publicToolName(raw)))
    lift()
    await waitFor(() => scopedToolNames(ctx, agent).includes(publicToolName(raw)))
    assert.ok((await assemble()).tools.some(tool => tool.name === publicToolName(raw)))
    await discovery.dispose()
    await assert.rejects(assemble(), /READINESS_BLOCKED/)
    assert.equal((await request(retained)).isError, true, 'missing selected counterpart blocks all execution in that scope')
    assert.ok(scopedToolNames(ctx, agent).includes(official), 'missing counterpart restores official visibility')
  } finally { await shutdown(ctx) }
}))

await test('an internal presentation probe never exempts a concurrent provider assembly or dispatch', () => withTempDir('presentation-isolation', async cwd => {
  const { ctx } = await bootHost()
  try {
    ctx.tools.register(tool('glob'))
    await ctx.plugin(Hiding, { replaceTools: ['glob'] })
    const agent = await agentFor(ctx, cwd)
    const entered = deferred(), release = deferred()
    let probedContext
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      if (isPresentationProbe(context)) { probedContext = context; entered.resolve(); await release.promise }
      return next()
    })
    const probing = isNativePresentation(ctx.systemPrompt, agent)
    await entered.promise
    await assert.rejects(ctx.systemPrompt.assemble({ scope: agent }), /READINESS_BLOCKED/)
    const refused = await ctx.tools.execute({ name: 'glob', arguments: {}, agent, callId: 'ordinary', signal: new AbortController().signal })
    assert.equal(refused.isError, true)
    release.resolve()
    assert.equal(await probing, true)
    assert.equal(isPresentationProbe(probedContext), false, 'inspection identity is retired after completion')
    await assert.rejects(ctx.systemPrompt.assemble(probedContext), /READINESS_BLOCKED/, 'reusing a retired context is ordinary assembly')
  } finally { await shutdown(ctx) }
}))
await test('real PTC Native shadows retain exact OPS ownership while PTC definitions are not Native replacements', () => withTempDir('presentation-shadow', async cwd => {
  const { ctx } = await bootHost()
  try {
    await ctx.plugin(Subprocess); await ctx.plugin(Sandbox, {})
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: cwd }) })
    ctx.provide('ptcRuntime', { language: 'typescript' })
    const original = tool(publicToolName('inspect_local_file'))
    const removeOwned = await registerNativeProvider(ctx, [original], definition => ctx.tools.register(definition))
    ctx.tools.register(tool('read'))
    await ctx.plugin(Ptc, { required: true })
    const parent = await agentFor(ctx, cwd, undefined, 'ptc')
    const child = await agentFor(ctx, cwd, parent, 'native')
    await waitFor(() => {
      const visible = ctx.tools.get(original.name, child)
      return visible !== original && nativeProviders(ctx, child).some(provider => provider.definition === visible)
    }, { what: 'tracked Native child shadow' })
    ctx.provide('agents', { list: () => [parent, child] })
    await ctx.plugin(Hiding, { replaceTools: ['read'] })
    const assembled = await ctx.systemPrompt.assemble({ scope: child })
    assert.equal(assembled.tools.some(tool => tool.name === 'read'), false)
    const value = await ctx.tools.execute({ name: original.name, arguments: {}, agent: child, callId: 'owned-shadow', signal: new AbortController().signal })
    assert.equal(value.isError, false, JSON.stringify(value))
    assert.deepEqual((await ctx.systemPrompt.assemble({ scope: parent })).tools.map(tool => tool.name), ['run_code'],
      'a collapsed scope is not gated')
    removeOwned()
    await assert.rejects(ctx.systemPrompt.assemble({ scope: child }), /READINESS_BLOCKED/)
  } finally { await shutdown(ctx) }
}))
report('presentation-readiness')
