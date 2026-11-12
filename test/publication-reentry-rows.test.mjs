/** Actual publication controllers, real scoped registry, one held host refusal. */
import { createScope } from '@deepseek-ai/dsh-scope'
import { mountSessionBash } from '../lib/session-shells.js'
import { mountNative } from '../lib/publication/native.js'
import { mountPtc } from '../lib/publication/ptc.js'
import { mountDiscovery } from '../lib/discovery/controller.js'
import { mountDiagnostics } from '../lib/integration/diagnostics.js'
import { mountReplacements } from '../lib/publication/replacements.js'
import { NativeFileTools } from '../lib/projections/native/runtime.js'
import { registerNativeProvider, claimPtcSurface } from '../lib/publication/providers.js'
import { resolveConfig } from '../lib/config.js'
import { BASH_TOOL, publicToolName } from '../lib/policy.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { prepareStep } from './lib/executor.mjs'
import { assert, test, report } from './lib/harness.mjs'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const bounded = async promise => {
  let timer
  try { return await Promise.race([promise, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('publication did not recover within 3s')), 3000)
  })]) } finally { clearTimeout(timer) }
}
const tool = name => ({ name, description: name, parameters: { type: 'object' },
  output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) })
const gate = { allows: () => true }
const config = { binaryPath: process.execPath, required: true }
const rows = {
  bash: {
    mount(ctx) { mountSessionBash(ctx, { publishBashTool: true }, {
      bash: { available: true, file: process.execPath, source: 'publication-only fixture', detail: 'never executed' },
    }) },
    name: BASH_TOOL,
  },
  native: { mount(ctx) { mountNative(ctx, resolveConfig(config), { id: 'reentry-fixture', tools: ['read_files'], section: null, gate }) }, name: publicToolName('read_files') },
  legacyNative: {
    mount(ctx) { ctx.on('agent/created', async () => {
      const runtime = new NativeFileTools({ ctx, config: { workerPath: process.execPath, required: true } })
      ctx.effect(() => () => runtime.stop())
      await runtime.start(['read_files'])
    }) },
    name: publicToolName('read_files'),
  },
  ptc: { mount(ctx) { mountPtc(ctx, { ...config, allowedTools: [] }, gate) }, name: publicToolName('load_sdk') },
  discovery: { mount(ctx) { mountDiscovery(ctx, { ...config, allowedTools: ['stat'], alwaysLoaded: ['stat'] }, gate) }, name: publicToolName('discover_tools') },
  diagnostics: { mount(ctx) { mountDiagnostics(ctx, gate) }, name: publicToolName('status') },
  replacements: {
    mount(ctx) { mountReplacements(ctx, { id: 'reentry-fixture', targets: new Map([['fixture-official', 'fixture-counterpart']]), gate, keepOfficial: () => false }) },
    restricted: true,
  },
}

for (const [name, row] of Object.entries(rows)) await test(`${name} controller recovers owed publication and teardown without another host event`, async () => {
  const { ctx, tools } = await bootHost({ toolsMode: name === 'ptc' ? 'ptc' : 'native' })
  const agents = [], messages = []
  ctx.provide('agents', { list: () => agents })
  // No call is executed: these explicit paths only let each real controller
  // construct its publication. This suite certifies registry lifecycle only.
  ctx.provide('subprocess', { spawn() { throw new Error('publication fixture must never execute') } })
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: process.cwd() }) })
  ctx.provide('ptcRuntime', { language: 'typescript' })
  ctx.logger.warn = message => messages.push(message)
  let locked = true, touches = 0
  try {
    if (row.restricted) { ctx.tools.register(tool('fixture-official')); ctx.tools.register(tool('fixture-counterpart')) }
    const fiber = await ctx.plugin({ inject: ['tools', 'systemPrompt'], apply: row.mount })
    for (let i = 0; i < 10; ++i) await new Promise(resolve => setImmediate(resolve))
    const agent = { id: `reentry-${name}`, session: { id: `reentry-${name}`, header: { cwd: process.cwd() } } }
    await ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
    agents.push(agent)
    const unwatch = ctx.on('tools/change', () => {
      if (!locked) return
      ++touches
      throw new Error('session append cannot reenter while another append is being published')
    })
    const creation = ctx.serial('agent/created', { agent })
    // Observe rejection immediately: a controller that loses its publication
    // must fail this check, without manufacturing an unhandled rejection.
    void creation.catch(() => {})
    await wait(160)
    assert.ok(touches > 0 && touches <= 8, `${name}: ${touches} held-window registry touches`)
    assert.ok(messages.filter(message => message.includes('registry publication deferred')).length <= 1)
    locked = false
    await bounded(creation)
    // Bash/Native/replacement lifecycle completion can precede deferred admission.
    await wait(500)
    if (row.restricted) {
      const step = await prepareStep(ctx, agent)
      try {
        assert.equal(step.assembly.tools.some(tool => tool.name === 'fixture-official'), false)
        assert.ok(step.assembly.tools.some(tool => tool.name === 'fixture-counterpart'))
      } finally { step.dispose() }
    } else assert.ok(tools.get(row.name, agent), `${name} must recover its exact owed registration`)
    assert.ok(messages.some(message => message.includes('registry publication recovered')))
    await fiber.dispose()
    await new Promise(resolve => setImmediate(resolve))
    if (row.restricted) assert.ok(tools.get('fixture-official', agent))
    else assert.equal(tools.get(row.name, agent), undefined, `${name} teardown must remove the recovered registration`)
    unwatch()
  } finally { locked = false; await shutdown(ctx) }
})

await test('hidden provider metadata notification recovers even without an owed registry mutation', async () => {
  const { ctx } = await bootHost()
  let locked = true, touches = 0, accepted = 0, registrations = 0
  const release = claimPtcSurface(ctx, undefined)
  try {
    ctx.on('tools/change', () => {
      if (locked) { ++touches; throw new Error('session append cannot reenter while another append is being published') }
      ++accepted
    })
    const starting = registerNativeProvider(ctx, [tool('hidden-metadata-fixture')], definition => {
      ++registrations; return ctx.tools.register(definition)
    })
    void starting.catch(() => {})
    await wait(160)
    assert.equal(registrations, 0, 'a PTC claim keeps this provider hidden')
    assert.ok(touches > 0 && touches <= 3, `metadata notification made ${touches} held-window attempts`)
    locked = false
    const stop = await bounded(starting)
    assert.equal(accepted, 1, 'metadata-only publication must recover without an unrelated registry event')
    stop()
    assert.equal(accepted, 2, 'metadata-only teardown remains observable')
  } finally { locked = false; release(); await shutdown(ctx) }
})

await test('legacy Native startup rejects an ordinary deferred registration failure and rolls back its exact scope', async () => {
  const { ctx, tools } = await bootHost()
  const agent = { id: 'legacy-deferred-error' }
  let scoped, runtime, locked = true, fail = true
  const original = new Error('ordinary deferred provider registration failure')
  try {
    await ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { scoped = createScope(inner, agent).ctx } })
    ctx.on('tools/change', () => {
      if (locked) throw new Error('session append cannot reenter while another append is being published')
      if (fail) { fail = false; throw original }
    })
    runtime = new NativeFileTools({ ctx: scoped, config: { workerPath: process.execPath, required: true } })
    const starting = runtime.start(['read_files'])
    void starting.catch(() => {})
    await wait(160)
    locked = false
    await assert.rejects(bounded(starting), error => error === original)
    assert.deepEqual(tools.definitions(agent), [], 'failed deferred registration must leave no Native definition in this scope')
  } finally { locked = false; fail = false; await runtime?.stop(); await shutdown(ctx) }
})

await test('ordinary provider metadata notification errors preserve the original failure and roll back', async () => {
  const { ctx, tools } = await bootHost()
  const original = new Error('ordinary metadata observer failure')
  let notifications = 0
  try {
    ctx.on('tools/change', () => { if (++notifications === 2) throw original })
    await assert.rejects(registerNativeProvider(ctx, [tool('metadata-error-fixture')], definition => ctx.tools.register(definition)), error => error === original)
    assert.equal(tools.get('metadata-error-fixture'), undefined, 'ordinary synthetic notification failure must roll back its source')
  } finally { await shutdown(ctx) }
})

report('publication-reentry-rows')
