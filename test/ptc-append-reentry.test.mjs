/**
 * #579: a host append window must not turn PTC publication into a per-session storm.
 *
 * PTC republishes from many events — `agent/created`, `session/event`, `tools/change`, `pre-step`,
 * `system-prompt/assemble` and the mode observer. Every one of them used to pay a full
 * `clear` + `register` against a registry the host was still publishing, and the failed pass reset
 * `entry.surface`, so the next event necessarily judged "changed" and paid again: one register and
 * one warning per event, per session.
 *
 * The fix is the shared reentry cooldown (`src/publication/reentry.ts`): a classified refusal stops
 * the pass, no pass touches the registry until the timer expires, and the window is reported once.
 * These checks pin the three properties that make the storm impossible — a bounded touch count that
 * does not grow with the event or session count, zero registry traffic inside the cooldown, and one
 * warning per window plus one recovery summary.
 *
 * The acceptance bound is **`3 × sessions`** (60 for the 20-session jitter lock), not a round
 * number: each session owes exactly one refused first attempt — trying is the only way to learn
 * that the window is open — plus one successful registration per resident API, and PTC publishes
 * two (`inspect_local_file`, `result`). Measured on this host the split for 20 sessions is
 * `{register: 60, restrict: 0, dispose: 0}`: three per session, zero redundant passes. Anything
 * above that is a republish the cooldown should have suppressed.
 *
 * @module dsh-ops/test/ptc-append-reentry
 */
import path from 'node:path'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import { createScope } from '@deepseek-ai/dsh-scope'
import { assert, report, test, waitFor } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'
import { mountPtc } from '../lib/publication/ptc.js'

requireWorker('ptc-append-reentry')

/** The host message this package classifies (it lives outside this repository). */
const HOST_REFUSAL = 'session append cannot reenter while another append is being published'
const flush = () => new Promise(resolve => setImmediate(resolve))
const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Boot the real host, mount the shipped PTC row and refuse registry writes while the window is held.
 *
 * Only the host's side is simulated: `register`, `restrict` and the disposer raise the host's own
 * reentry message while `state.open` is true. Scope lifecycle, ownership, presentation probes and
 * the publication pipeline are the shipped ones.
 * @returns {Promise<object>} the fixture surface.
 */
async function setup() {
  const { ctx, tools } = await bootHost()
  const warns = []
  ctx.logger.warn = (...parts) => { warns.push(parts.join(' ')) }
  const listed = []
  ctx.provide('agents', { list: () => listed })
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox)
  await ctx.plugin(inner => {
    inner.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: 'workspace-write', workspaceRoot: process.env.DSH_HOME, sessionId: session?.id }) })
    inner.provide('ptcRuntime', { language: 'typescript' })
  })
  const state = { open: false, register: 0, dispose: 0, restrict: 0 }
  const originalRegister = tools.register
  tools.register = function counted(definition) {
    state.register += 1
    if (state.open) throw new Error(HOST_REFUSAL)
    const dispose = originalRegister.call(this, definition)
    return () => { state.dispose += 1; if (state.open) throw new Error(HOST_REFUSAL); dispose() }
  }
  if (typeof tools.restrict === 'function') {
    const originalRestrict = tools.restrict
    tools.restrict = function countedRestrict(patch) {
      state.restrict += 1
      if (state.open) throw new Error(HOST_REFUSAL)
      return originalRestrict.call(this, patch)
    }
  }
  await ctx.plugin(inner => {
    mountPtc(inner, { binaryPath: WORKER, required: true, allowedTools: [], alwaysLoaded: [] },
      { allows: () => true, dynamic: false })
  })
  let serial = 0
  const mint = async () => {
    const id = `ptc-${++serial}`
    const agent = { id, session: { id, mode: 'workspace-write', header: { cwd: path.dirname(WORKER) } } }
    agent.ctx = createScope(ctx, agent).ctx
    await agent.ctx.plugin({ inject: ['tools'], apply(inner) { agent.lift = inner.tools.presentAs('ptc') } })
    listed.push(agent)
    return agent
  }
  const agents = []
  const create = async count => {
    for (let index = 0; index < count; index += 1) agents.push(await mint())
    for (const agent of agents.slice(-count)) await ctx.serial('agent/created', { agent })
  }
  /** One `session/event` per agent — the shape that used to cost one register each. */
  const drive = async (rounds, gap = 10) => {
    let events = 0
    for (let round = 0; round < rounds; round += 1) {
      for (const agent of agents) { await ctx.serial('session/event', agent.session, { type: 'agent-preset/selected' }); events += 1 }
      if (gap > 0) await tick(gap)
    }
    return events
  }
  const published = agent => tools.get('ops_bash', agent) !== undefined
  const names = agent => tools.schemas(agent).map(tool => tool.name).filter(name => name.startsWith('ops_'))
  const touches = () => state.register + state.dispose + state.restrict
  const allPublished = () => agents.every(agent => names(agent).length > 0)
  const deferral = () => warns.filter(line => /host is publishing an append/.test(line))
  const recovery = () => warns.filter(line => /publication recovered after/.test(line))
  return { ctx, tools, warns, state, agents, create, drive, published, names, touches, allPublished, deferral, recovery,
    reset() { state.register = 0; state.dispose = 0; state.restrict = 0; warns.length = 0 },
    release() { state.open = false } }
}

// -------------------------------------------------------------------------------------------------
// 1. cold start: the window covers agent/created

await test('a held window during cold start costs a bounded touch count, not one register per event', async () => {
  const fixture = await setup()
  try {
    fixture.state.open = true
    await fixture.create(3)
    await flush()
    const events = await fixture.drive(40)
    const touches = fixture.touches()
    // Pre-fix this was 1 touch and 1 warning per event (≈ events); the cooldown keeps it at the
    // number of retry steps, independent of both the event count and the session count.
    assert.ok(touches <= 20,
      `touches stay bounded inside a held window: ${touches} for ${events} events across 3 sessions`)
    assert.ok(touches <= events / 4,
      `the touch count must not follow the event count: ${touches} touches for ${events} events`)
    assert.equal(fixture.names(fixture.agents[0]).length, 0, 'nothing publishes while the host holds the append')
    assert.equal(fixture.deferral().length, 1,
      `the window is reported once, not once per attempt: ${JSON.stringify(fixture.warns)}`)
    assert.equal(fixture.recovery().length, 0, 'no recovery line while the window is still held')
    // Release: one deferred pass republishes every session, and the window is summarised once.
    fixture.release()
    await waitFor(fixture.allPublished, { timeoutMs: 3000, what: 'every session to publish after the window' })
    assert.equal(fixture.names(fixture.agents[2]).length, 2, 'the last session holds its two resident APIs')
    assert.equal(fixture.recovery().length, 1,
      `the suppressed refusals are summarised once on recovery: ${JSON.stringify(fixture.warns)}`)
    assert.equal(fixture.warns.length, 2, `exactly two lines for the whole window: ${JSON.stringify(fixture.warns)}`)
  } finally { fixture.state.open = false; await shutdown(fixture.ctx) }
})

// -------------------------------------------------------------------------------------------------
// 2. hot path: the window opens after every layer is live

await test('a held window over live layers keeps them published and stays bounded', async () => {
  const fixture = await setup()
  try {
    await fixture.create(3)
    await waitFor(fixture.allPublished, { timeoutMs: 3000, what: 'the first publication of three sessions' })
    fixture.reset()
    fixture.state.open = true
    const events = await fixture.drive(40)
    const touches = fixture.touches()
    // The property is "bounded and independent of the event count", not a magic constant: the exact
    // cost is (cooldown expiries in the window) × (owed sessions), and the expiry count belongs to
    // the shared ladder. Measured 12–27 here against 102–188 pre-fix for the same event count.
    assert.ok(touches <= 40, `live layers cost a bounded trickle inside the window: ${touches} for ${events} events`)
    assert.ok(touches <= events / 4, `the hot window must not follow the event count: ${touches} for ${events} events`)
    assert.equal(fixture.deferral().length, 1, `one line for the window: ${JSON.stringify(fixture.warns)}`)
    for (const agent of fixture.agents) assert.equal(fixture.names(agent).length, 2, 'a refused refresh never withdraws a live layer')
    fixture.release()
    await waitFor(fixture.allPublished, { timeoutMs: 3000, what: 'the cooled pass to converge' })
    for (const agent of fixture.agents) assert.equal(fixture.names(agent).length, 2, 'every session keeps exactly one layer set')
  } finally { fixture.state.open = false; await shutdown(fixture.ctx) }
})

// -------------------------------------------------------------------------------------------------
// 3. the cooldown itself: no registry traffic at all

await test('no pass touches the registry while the cooldown runs', async () => {
  const fixture = await setup()
  try {
    fixture.state.open = true
    await fixture.create(2)
    await flush()
    const armed = fixture.touches()
    assert.ok(armed >= 1, 'the first pass did reach the registry and was refused')
    // Drive hard with no delay: every event lands inside the first 25 ms cooldown step.
    const events = await fixture.drive(30, 0)
    assert.equal(fixture.touches(), armed,
      `a cooled pass performs no register and no dispose: ${fixture.touches()} touches after ${events} more events, expected ${armed}`)
    assert.equal(fixture.deferral().length, 1, 'a deferred pass adds no second warning')
    fixture.release()
    await waitFor(fixture.allPublished, { timeoutMs: 3000, what: 'the deferred pass to publish' })
    assert.equal(fixture.names(fixture.agents[0]).length, 2, 'the deferred pass publishes both resident APIs')
  } finally { fixture.state.open = false; await shutdown(fixture.ctx) }
})

report('ptc-append-reentry')
