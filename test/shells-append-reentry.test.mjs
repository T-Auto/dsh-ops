/**
 * #579: the host's append window refuses a registry write.
 *
 * The layer must not retry that refusal in the same microtask, must stop the pass instead of
 * multiplying it by the session count, and must converge through one cooldown pass. The refusal
 * text is the host's; this suite stubs the registry to produce it, because the real lock only
 * exists while a real host publishes an append.
 *
 * @module dsh-ops/test/shells-append-reentry
 */
import { createScope } from '@deepseek-ai/dsh-scope'
import { assert, report, test, waitFor } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { mountSessionBash } from '../lib/session-shells.js'

/** The host message this package classifies (it lives outside this repository). */
const HOST_REFUSAL = 'session append cannot reenter while another append is being published'
const flush = () => new Promise(resolve => setImmediate(resolve))
const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Boot a host whose only bash dependency is the real registry, then swap `register` for a counter
 * with two controllable failure modes: the host's append window, and one unrelated error.
 * @param {object} [options] - fixture switches.
 * @param {boolean} [options.refuseDispose] - also refuse the withdrawal a pass starts with, the way
 *   the host refuses every append while it publishes (the independent repro measured that shape).
 * @returns {Promise<object>} the fixture surface.
 */
async function setup({ refuseDispose = false } = {}) {
  const { ctx, tools } = await bootHost()
  const warns = []
  ctx.logger.warn = (...parts) => { warns.push(parts.join(' ')) }
  await ctx.plugin(inner => {
    inner.provide('subprocess', { spawn() { throw new Error('publication test must not execute') } })
    inner.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: process.env.DSH_HOME }) })
  })
  const state = { open: false, generic: 0, genericMessage: 'the registry refused for an unrelated reason', register: 0, dispose: 0, attempts: [] }
  const hadOwn = Object.hasOwn(tools, 'register')
  const original = tools.register
  // A scoped registry calls this through its own binding, so the receiver must be forwarded:
  // registering through the root instance instead would publish every agent into one scope.
  tools.register = function counted(definition) {
    state.register += 1
    state.attempts.push(definition)
    if (state.generic > 0) { state.generic -= 1; throw new Error(state.genericMessage) }
    if (state.open) throw new Error(HOST_REFUSAL)
    const dispose = original.call(this, definition)
    return () => {
      state.dispose += 1
      if (refuseDispose && state.open) throw new Error(HOST_REFUSAL)
      dispose()
    }
  }
  let notify
  const gate = { allows: () => true, watch(listener) { notify = listener; return () => { notify = undefined } } }
  await ctx.plugin({ inject: ['tools'], apply(inner) {
    mountSessionBash(inner, { publishBashTool: true }, { bash: { available: true, file: process.execPath, source: 'explicit', detail: 'publication only' } }, gate)
  } })
  const agents = new Map()
  const mint = async id => {
    const agent = { id, session: { id, header: { cwd: process.env.DSH_HOME } } }
    agent.ctx = createScope(ctx, agent).ctx
    await ctx.serial('agent/created', { agent })
    await flush()
    agents.set(id, agent)
    return agent
  }
  const published = id => tools.get('ops_bash', agents.get(id)) !== undefined
  const allPublished = () => [...agents.keys()].every(published)
  /** Drive one host event every 10 ms, the cadence the independent repro used. */
  const stress = async ms => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      for (const agent of agents.values()) await ctx.serial('session/event', agent.session, { type: 'agent-preset/selected' })
      await tick(10)
    }
  }
  return {
    ctx, tools, warns, state, agents, mint, published, allPublished, stress,
    notify: () => { notify?.() },
    reset() { state.register = 0; state.dispose = 0; state.attempts.length = 0; warns.length = 0 },
    attempts: () => state.register + state.dispose,
    deferralWarns: () => warns.filter(line => /publishing an append/.test(line)).length,
    failureWarns: () => warns.filter(line => /bash publication failed/.test(line)).length,
    restore() { if (hadOwn) tools.register = original; else delete tools.register },
  }
}

await test('a refusal inside the append window is not retried in the same microtask', async () => {
  const fixture = await setup()
  const { ctx, state, warns, mint, reset, notify, attempts } = fixture
  try {
    for (const id of ['a1', 'a2', 'a3']) await mint(id)
    await waitFor(fixture.allPublished, { timeoutMs: 1500, what: 'the first publication of three agents' })
    reset()
    state.open = true
    notify()
    await flush()
    await tick(5)
    assert.equal(state.register, 1, 'the pass stops at the first refusal and never reenters the window')
    assert.equal(attempts(), 2, 'one withdrawal plus one refused register: no second register in this microtask')
    assert.equal(fixture.failureWarns(), 0, 'a classified refusal is not reported as a publication failure')
    assert.equal(fixture.deferralWarns(), 1, 'the window is reported once')
    await tick(10)
    assert.equal(attempts(), 2, 'nothing else touches the registry until the cooldown expires')
    assert.equal(warns.length, 1, 'no warning storm')
  } finally { state.open = false; fixture.restore(); await shutdown(ctx) }
})

await test('the cooled pass converges once the window closes, with a constant attempt count', async () => {
  const fixture = await setup()
  const { ctx, state, tools, agents, mint, reset, notify } = fixture
  try {
    for (const id of ['b1', 'b2', 'b3']) await mint(id)
    await waitFor(fixture.allPublished, { timeoutMs: 1500, what: 'the first publication of three agents' })
    reset()
    state.open = true
    notify()
    await flush()
    assert.equal(state.register, 1, 'one refusal for one pass, whatever the session count')
    state.open = false
    await waitFor(fixture.allPublished, { timeoutMs: 3000, what: 'the cooled pass to republish three sessions' })
    assert.ok(state.register <= 5, `attempts stay constant: ${state.register}`)
    assert.equal(fixture.deferralWarns(), 1, 'the warning is said once per window')
    for (const id of ['b1', 'b2', 'b3']) assert.ok(tools.get('ops_bash', agents.get(id)), id)
  } finally { state.open = false; fixture.restore(); await shutdown(ctx) }
})

await test('an unclassified register failure keeps its existing warn-and-restore behaviour', async () => {
  const fixture = await setup()
  const { ctx, tools, state, agents, mint, reset, notify } = fixture
  try {
    const agent = await mint('c1')
    const firstDefinition = state.attempts.at(-1)
    reset()
    state.generic = 1
    notify()
    await flush()
    await tick(5)
    assert.equal(state.register, 2, 'one failed attempt and one restore attempt')
    assert.equal(state.attempts[1], firstDefinition, 'the restore re-registers the definition that last worked')
    assert.equal(fixture.failureWarns(), 1)
    assert.ok(tools.get('ops_bash', agent ?? agents.get('c1')), 'the session keeps a working bash layer after the restore')
    assert.equal(fixture.deferralWarns(), 0, 'this class must not take the cooled path')
  } finally { state.generic = 0; fixture.restore(); await shutdown(ctx) }
})

await test('a locked window during cold start costs a bounded number of attempts, not a burst per session', async () => {
  // The independent repro measured one host event every 10 ms against a 1 s window: the pre-fix
  // layer retried every unpublished session on every pass, so the count grew with the session
  // count and stayed at zero published sessions.
  const fixture = await setup({ refuseDispose: true })
  const { ctx, state, mint, reset } = fixture
  try {
    reset()
    state.open = true
    for (const id of ['d1', 'd2', 'd3']) await mint(id)
    await fixture.stress(1000)
    const during = fixture.attempts()
    assert.ok(during <= 8, `cold-start attempts inside a 1 s window stay bounded: ${during}`)
    assert.equal(fixture.deferralWarns(), 1, 'one warning for the window, not one per attempt')
    assert.equal(fixture.published('d1') || fixture.published('d2') || fixture.published('d3'), false,
      'nothing publishes while the host still holds the append')
    state.open = false
    await waitFor(fixture.allPublished, { timeoutMs: 3000, what: 'all three sessions to publish after the window' })
  } finally { state.open = false; fixture.restore(); await shutdown(ctx) }
})

await test('the hot path keeps a bounded attempt rate while the window stays open', async () => {
  const fixture = await setup({ refuseDispose: true })
  const { ctx, state, mint, reset } = fixture
  try {
    for (const id of ['e1', 'e2', 'e3']) await mint(id)
    await waitFor(fixture.allPublished, { timeoutMs: 1500, what: 'the first publication of three agents' })
    reset()
    state.open = true
    await fixture.stress(1000)
    const rate = fixture.attempts()
    assert.ok(rate <= 20, `a locked window costs at most a fixed trickle per second: ${rate}`)
    assert.equal(fixture.deferralWarns(), 1, 'the window is reported once, not per attempt')
    state.open = false
    await waitFor(fixture.allPublished, { timeoutMs: 3000, what: 'all three sessions to stay published after the window' })
  } finally { state.open = false; fixture.restore(); await shutdown(ctx) }
})

report('shells-append-reentry')
