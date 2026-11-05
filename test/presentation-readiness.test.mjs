import { selectExecutor, executeCall, prepareStep } from './lib/executor.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { createScope } from '@deepseek-ai/dsh-scope'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import * as PtcModule from '../lib/ptc/index.js'
import { mountNativeCatalogue } from './lib/native-catalogue.mjs'
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
async function assembled(ctx, agent) { const captured = await prepareStep(ctx, agent); try { return captured.assembly } finally { captured.dispose() } }
async function admitted(ctx, agent) { const captured = await prepareStep(ctx, agent); try { return ctx.tools.schemas(agent, captured.toolSet).map(tool => tool.name) } finally { captured.dispose() } }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tool = name => ({ name, description: name, parameters: { type: 'object' }, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) })
let sequence = 0
const rosters = new WeakMap()
async function agentFor(ctx, cwd, parent, mode) {
  let roster = rosters.get(ctx)
  if (!roster) { roster = []; rosters.set(ctx, roster); ctx.provide('agents', { list: () => [...roster] }) }
  const id = 'readiness-' + ++sequence
  const agent = { id, session: { id, mode: 'danger-full-access', header: { cwd } } }
  await (parent?.ctx ?? ctx).plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { agent.ctx = createScope(inner, agent, parent ? { parent } : undefined).ctx } })
  if (mode) await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, mode) } })
  roster.push(agent)
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
    await waitFor(() => Boolean(ctx.tools.get(publicToolName(raw), agent)), { what: 'selected shared Native source' })
    const assemble = () => assembled(ctx, agent)
    assert.deepEqual((await assemble()).tools.map(tool => tool.name).sort(), [publicToolName(raw), official, retained].sort(),
      'a conditional shared counterpart leaves official schemas visible; captured admission guards dispatch')
    assert.equal(registryHasOwnRegister(ctx), false)
    fs.writeFileSync(path.join(cwd, 'ready.txt'), 'ready')
    const request = name => executeCall(ctx, { name, arguments: raw === 'glob' ? { pattern: ['*.txt'] } : { path: 'ready.txt' }, agent, callId: 'readiness', signal: new AbortController().signal })
    const executed = await request(publicToolName(raw))
    assert.equal(executed.isError, false); assert.equal(executed.value.status, 'completed', JSON.stringify(executed))
    assert.equal((await request(official)).isError, true, 'selected official dispatch remains blocked')
    ctx.provide('ptcRuntime', { language: 'typescript' })
    const lift = selectExecutor(agent.ctx, 'ptc')
    // A run_code scope cannot own a native counterpart, so it is never masked and
    // never gated: the model receives the program entry and nothing else.
    assert.deepEqual((await assemble()).tools.map(tool => tool.name), ['run_code'])
    assert.ok(scopedToolNames(ctx, agent).includes(official), 'a collapsed scope hides nothing')
    const direct = await request(official)
    assert.equal(direct.isError, true, 'a direct official call stays refused in a collapsed scope')
    await waitFor(async () => !(await admitted(ctx, agent)).includes(publicToolName(raw)))
    lift(); selectExecutor(agent.ctx, 'native')
    await waitFor(async () => (await admitted(ctx, agent)).includes(publicToolName(raw)))
    assert.ok((await assemble()).tools.some(tool => tool.name === publicToolName(raw)))
    await discovery.dispose()
    await assert.rejects(assemble(), /READINESS_BLOCKED/)
    await assert.rejects(request(retained), /READINESS_BLOCKED/, 'missing selected counterpart blocks all execution in that scope')
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
    await assert.rejects(executeCall(ctx, { name: 'glob', arguments: {}, agent, callId: 'ordinary', signal: new AbortController().signal }), /READINESS_BLOCKED/)
    release.resolve()
    assert.equal(await probing, true)
    assert.equal(isPresentationProbe(probedContext), false, 'inspection identity is retired after completion')
    await assert.rejects(ctx.systemPrompt.assemble(probedContext), /READINESS_BLOCKED/, 'reusing a retired context is ordinary assembly')
  } finally { await shutdown(ctx) }
}))
await test('real shared Native sources keep exact ownership across PTC children and reject ancestor denial and foreign shadows', () => withTempDir('presentation-source', async cwd => {
  const { ctx } = await bootHost()
  try {
    await ctx.plugin(Subprocess); await ctx.plugin(Sandbox, {})
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: cwd }) })
    ctx.provide('ptcRuntime', { language: 'typescript' })
    const native = await mountNativeCatalogue(ctx, { required: true })
    ctx.tools.register(tool('read'))
    await ctx.plugin(Ptc, { required: true })
    const parent = await agentFor(ctx, cwd, undefined, 'ptc')
    const child = await agentFor(ctx, cwd, parent, 'native')
    await waitFor(() => Boolean(ctx.tools.get(publicToolName('inspect_local_file'), child)), { what: 'shared child source' })
    await ctx.plugin(Hiding, { replaceTools: ['read'] })
    fs.writeFileSync(path.join(cwd, 'ready.txt'), 'shared source')
    const assembly = await assembled(ctx, child)
    assert.equal(assembly.tools.some(tool => tool.name === 'read'), true, 'conditional shared replacement keeps the official schema visible')
    const value = await executeCall(ctx, { name: publicToolName('inspect_local_file'), arguments: { path: 'ready.txt' }, agent: child })
    assert.equal(value.isError, false, JSON.stringify(value)); assert.match(value.content[0].text, /shared source/)
    assert.deepEqual((await assembled(ctx, parent)).tools.map(tool => tool.name), ['run_code'])
    const deny = parent.ctx.tools.restrict({ deny: [publicToolName('inspect_local_file')] })
    await assert.rejects(assembled(ctx, child), /READINESS_BLOCKED/, 'a tracked source cannot bypass an external ancestor denial')
    deny()
    assert.ok((await assembled(ctx, child)).tools.some(tool => tool.name === publicToolName('inspect_local_file')))
    const foreign = await child.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.register(tool(publicToolName('inspect_local_file'))) } })
    await assert.rejects(assembled(ctx, child), /READINESS_BLOCKED/, 'a same-name foreign definition never supplies reviewed OPS ownership')
    assert.deepEqual((await assembled(ctx, parent)).tools.map(tool => tool.name), ['run_code'], 'foreign child shadow leaves its parent independent')
    await foreign.dispose()
    assert.ok((await assembled(ctx, child)).tools.some(tool => tool.name === publicToolName('inspect_local_file')))
    await native.dispose()
    await assert.rejects(assembled(ctx, child), /READINESS_BLOCKED/)
  } finally { await shutdown(ctx) }
}))
report('presentation-readiness')
