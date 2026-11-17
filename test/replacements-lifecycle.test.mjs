/** Replacement refresh survives scope teardown before the host's disposed notification. */
import { createScope } from '@deepseek-ai/dsh-scope'
import { mountReplacements } from '../lib/publication/replacements.js'
import { publicationRegistration, publicationReady } from '../lib/publication/reentry.js'
import { withToolChange } from '../lib/publication/changes.js'
import { publicToolName } from '../lib/policy.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { prepareStep, executeCall } from './lib/executor.mjs'
import { assert, test, report } from './lib/harness.mjs'

const tool = (name, description = name) => ({ name, description, parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({ ran: description }) })
const counterpart = publicToolName('inspect_local_file')
const tick = () => new Promise(resolve => setImmediate(resolve))

async function fixture(body, { sharedParent = false } = {}) {
  const { ctx, tools } = await bootHost()
  const warnings = []
  ctx.logger.exporter({ levels: { default: 4 }, export(message) {
    if (message.type === 'warn') warnings.push(message.args.join(' '))
  } })
  const agents = ['retiring', 'healthy'].map(id => ({ id, session: { id } }))
  const parent = {}
  const scopes = agents.map(agent => createScope(ctx, agent, sharedParent ? { parent } : undefined))
  let gateFailure
  agents.forEach((agent, i) => { agent.ctx = scopes[i].ctx })
  ctx.provide('agents', { list: () => agents })
  let removeOfficial = tools.register(tool('read', 'original read'))
  tools.register(tool(counterpart))
  await ctx.plugin({ apply(inner) { mountReplacements(inner, { id: 'lifecycle',
    targets: new Map([['read', counterpart]]), gate: { allows: agent => {
      if (agent === gateFailure) throw new Error('fixture gate failure')
      return true
    } }, keepOfficial: () => false }) } })
  try {
    await tick()
    const replaceOfficial = (beforeRegister = () => {}) => {
      removeOfficial()
      beforeRegister()
      removeOfficial = tools.register(tool('read', 'updated read'))
    }
    await body({ ctx, tools, agents, scopes, warnings, replaceOfficial, parent, setGateFailure: agent => { gateFailure = agent } })
  } finally { await shutdown(ctx) }
}

async function assertReplacement(ctx, tools, agent) {
  const step = await prepareStep(ctx, agent)
  try {
    assert.equal(tools.get('read', agent).description, 'updated read')
    assert.deepEqual(step.assembly.tools.map(t => t.name).filter(name => ['read', counterpart].includes(name)), [counterpart])
    const result = await executeCall(ctx, { agent, name: counterpart, arguments: {},
      callId: 'healthy-replacement', signal: new AbortController().signal, toolSet: step.toolSet })
    assert.equal(result.isError, false)
    assert.equal(result.value.ran, counterpart)
  } finally { step.dispose() }
}

await test('disposed scopes are retired before a delayed agent/disposed notification', () => fixture(async ({ ctx, tools, agents, scopes, warnings, replaceOfficial }) => {
  const [retiring, healthy] = agents
  await scopes[0].dispose()
  assert.throws(() => retiring.ctx.fiber.assertActive(), { code: 'INACTIVE_EFFECT' })
  assert.doesNotThrow(replaceOfficial, 'a stale cached agent must not fail the unrelated registry mutation')
  await assertReplacement(ctx, tools, healthy)
  await tick()
  const before = warnings.length
  for (let i = 0; i < 3; ++i) tools.register(tool('unrelated-' + i))
  await tick()
  assert.equal(warnings.length, before, 'later reconciliation must not keep retrying the disposed scope')
  await ctx.serial('agent/disposed', { agent: retiring })
  await assertReplacement(ctx, tools, healthy)
}))

await test('scope disposal during registration cannot interrupt the next agent refresh', () => fixture(async ({ ctx, tools, agents, scopes, replaceOfficial }) => {
  const [retiring, healthy] = agents
  const effect = retiring.ctx.effect.bind(retiring.ctx)
  let disposal
  retiring.ctx.effect = (body, label) => {
    if (label === 'dsh-ops: registry publication lease') {
      retiring.ctx.effect = effect
      disposal = scopes[0].rawDispose()
    }
    return effect(body, label)
  }
  assert.doesNotThrow(replaceOfficial, 'the context can expire after refresh starts')
  await disposal
  assert.throws(() => retiring.ctx.fiber.assertActive(), { code: 'INACTIVE_EFFECT' })
  await assertReplacement(ctx, tools, healthy)
  await ctx.serial('agent/disposed', { agent: retiring })
}))

await test('a live agent publication failure is reported without stopping sibling refresh or recovery', () => fixture(async ({ ctx, tools, agents, warnings, replaceOfficial }) => {
  const [broken, healthy] = agents
  const effect = broken.ctx.effect.bind(broken.ctx)
  const failure = new Error('fixture publication failure')
  broken.ctx.effect = (body, label) => {
    if (label === 'dsh-ops: registry publication lease') throw failure
    return effect(body, label)
  }
  try {
    assert.doesNotThrow(replaceOfficial, 'one agent must not fail tools/change for its emitter')
    await assertReplacement(ctx, tools, healthy)
    assert.ok(warnings.some(message => message.includes('replacement publication failed') && message.includes(failure.message)))
  } finally { broken.ctx.effect = effect }
  tools.register(tool('recovery-trigger'))
  await tick()
  await assertReplacement(ctx, tools, broken)
}))

await test('a source lookup failure is isolated before apply and identifies the affected agent', () => fixture(async ({ ctx, tools, agents, warnings, replaceOfficial }) => {
  const get = tools.get.bind(tools)
  let fail = true
  tools.get = (name, scope, toolSet) => {
    if (fail && name === 'read' && scope === undefined) {
      fail = false
      throw new Error('fixture source lookup failure')
    }
    return get(name, scope, toolSet)
  }
  try {
    assert.doesNotThrow(replaceOfficial)
    await assertReplacement(ctx, tools, agents[1])
    assert.ok(warnings.some(message => message.includes('lifecycle') && message.includes('retiring') && message.includes('fixture source lookup failure')))
  } finally { tools.get = get }
  await tick()
  await assertReplacement(ctx, tools, agents[0])
}))

await test('a registration observer can dispose its owner before the shadow is cached', () => fixture(async ({ ctx, tools, agents, scopes, replaceOfficial }) => {
  const [retiring, healthy] = agents
  let disposal
  const unwatch = ctx.on('tools/change', () => {
    const scoped = tools.get('read', retiring)
    if (disposal || scoped?.description !== 'updated read' || scoped === tools.get('read')) return
    disposal = scopes[0].rawDispose()
  }, { global: true })
  try {
    assert.doesNotThrow(replaceOfficial)
    assert.ok(disposal, 'the observer must run inside the new shadow registration')
    await disposal
    await assertReplacement(ctx, tools, healthy)
    assert.equal(tools.get('read', retiring), tools.get('read'), 'the disposed agent retains no scoped shadow')
    tools.register(tool('after-observer-disposal'))
    await tick()
    await assertReplacement(ctx, tools, healthy)
  } finally { unwatch() }
}))

await test('queued registration skips a disposed owner while its lease teardown is still blocked', () => fixture(async ({ ctx, tools, agents, scopes, warnings, replaceOfficial }) => {
  const [retiring, healthy] = agents
  let locked = true, blocker, release, timer
  const teardown = new Promise(resolve => { release = resolve })
  const effect = retiring.ctx.effect.bind(retiring.ctx)
  let teardownStarted = false, queuedLeases = 0
  // Cordis unloads effects in parallel: delay this lease's cancellation itself.
  retiring.ctx.effect = (body, label) => label === 'dsh-ops: registry publication lease' ? effect(() => {
    ++queuedLeases
    const dispose = body()
    return async () => { teardownStarted = true; await teardown; return dispose() }
  }, label) : effect(body, label)
  try {
    replaceOfficial(() => {
      blocker = publicationRegistration(ctx, () => {
        if (locked) throw new Error('session append cannot reenter while another append is being published')
        return () => {}
      })
    })
    await tick() // Drain the live reconciliation before testing the queued callback itself.
    assert.equal(queuedLeases, 1, 'the replaced source must queue a scoped publication lease')
    const disposal = scopes[0].rawDispose()
    assert.throws(() => retiring.ctx.fiber.assertActive(), { code: 'INACTIVE_EFFECT' })
    await tick() // Let the real scope fiber enter its asynchronous unload.
    assert.equal(teardownStarted, true, 'the pending lease cancellation must really be blocked')
    locked = false
    await Promise.race([publicationReady(blocker), new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('queued replacement did not settle')), 4000)
    })])
    assert.equal(tools.get('read', retiring), tools.get('read'), 'no dead-scope shadow is published')
    assert.equal(warnings.some(message => message.includes('deferred registry publication failed')), false, warnings.join('\n'))
    await assertReplacement(ctx, tools, healthy)
    release()
    await disposal
  } finally {
    locked = false
    clearTimeout(timer)
    retiring.ctx.effect = effect
    release()
    blocker?.()
    await scopes[0].dispose()
  }
}))

await test('scoped reconciliation isolates a gate failure and leaves that live agent recoverable', () => fixture(async ({ ctx, tools, agents, parent, warnings, replaceOfficial, setGateFailure }) => {
  setGateFailure(agents[0])
  try {
    assert.doesNotThrow(() => withToolChange([parent], replaceOfficial))
    await assertReplacement(ctx, tools, agents[1])
    assert.ok(warnings.some(message => message.includes('retiring') && message.includes('fixture gate failure')))
  } finally { setGateFailure(undefined) }
  await tick()
  await assertReplacement(ctx, tools, agents[0])
}, { sharedParent: true }))

report('replacements-lifecycle')
