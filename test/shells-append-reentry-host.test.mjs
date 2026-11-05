/**
 * #579 against the repository's real host.
 *
 * `shells-append-reentry` drives a thin host surface. This suite boots the real
 * one — `bootHost()` (real Cordis `Context`, real `@deepseek-ai/dsh-tools`
 * registry, real registration scopes), the shipped
 * `@deepseek-ai/dsh-subprocess-local` service, and the shipped
 * `mountSessionBash` — so the assertions describe the composition that ships.
 *
 * Exactly one host-side behaviour is simulated: while the append window is
 * open, `register`, `restrict` and the returned disposer raise the host's own
 * reentry message. That is the single failure #579 classifies; everything else
 * (event delivery, scope isolation, tool publication, teardown) is real.
 *
 * `sandboxPolicy` is a two-line resolver rather than the policy package: a real
 * provider needs the session-projection service, and `resolve()` is consulted
 * only when a command runs, which this suite never does (it asserts publication
 * facts, never executes bash).
 *
 * @module dsh-ops/test/shells-append-reentry-host
 */
import { createScope } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { assert, report, test, waitFor } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { mountSessionBash } from '../lib/session-shells.js'

/** The host message this package classifies (it lives outside this repository). */
const HOST_REFUSAL = 'session append cannot reenter while another append is being published'
const flush = () => new Promise(resolve => setImmediate(resolve))
const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Boot the real host and mount the shipped session-bash layer on it.
 * @returns {Promise<object>} the fixture surface.
 */
async function setup() {
  const { ctx, tools } = await bootHost()
  const warns = []
  ctx.logger.warn = (...parts) => { warns.push(parts.join(' ')) }
  await ctx.plugin(Subprocess)
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: process.env.DSH_HOME }) })
  const state = { open: false, register: 0, restrict: 0, dispose: 0 }
  const original = { register: tools.register, restrict: tools.restrict }
  // The one simulated host behaviour: an append window refuses every registry write it would reenter.
  const refuse = () => { if (state.open) throw new Error(HOST_REFUSAL) }
  tools.register = function windowedRegister(definition) {
    state.register += 1
    refuse()
    const dispose = original.register.call(this, definition)
    return () => { state.dispose += 1; refuse(); dispose() }
  }
  if (typeof original.restrict === 'function') {
    tools.restrict = function windowedRestrict(patch) {
      state.restrict += 1
      refuse()
      return original.restrict.call(this, patch)
    }
  }
  let notify
  const gate = { allows: () => true, watch(listener) { notify = listener; return () => { notify = undefined } } }
  await ctx.plugin({ inject: ['tools'], apply(inner) {
    mountSessionBash(inner, { publishBashTool: true }, { bash: { available: true, file: process.execPath, source: 'explicit', detail: 'host integration' } }, gate)
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
  const publishedCount = () => [...agents.keys()].filter(id => published(id)).length
  const allPublished = () => [...agents.keys()].every(id => published(id))
  const touches = () => state.register + state.restrict + state.dispose
  const reset = () => { state.register = 0; state.restrict = 0; state.dispose = 0; warns.length = 0 }
  const deferralWarns = () => warns.filter(line => /publishing an append/.test(line)).length
  const restore = () => {
    if (Object.hasOwn(tools, 'register')) tools.register = original.register
    if (typeof original.restrict === 'function' && Object.hasOwn(tools, 'restrict')) tools.restrict = original.restrict
  }
  return { ctx, tools, warns, state, agents, mint, published, publishedCount, allPublished, touches, reset, deferralWarns, restore, notify: () => notify?.() }
}

await test('a real host colliding at cold start touches the registry at most twice and still publishes every session', async () => {
  const fixture = await setup()
  const { ctx, state, mint, publishedCount, touches, deferralWarns } = fixture
  try {
    state.open = true
    await mint('h1')
    // The refusal arrives in the first pass; nothing may retry inside that microtask.
    await flush()
    await tick(5)
    assert.ok(touches() <= 2, `one withdrawal plus one refused register at most: ${touches()}`)
    assert.equal(state.register, 1, 'exactly one register attempt, however many sessions are waiting')
    assert.ok(deferralWarns() <= 1, `the window is reported at most once: ${deferralWarns()}`)
    await mint('h2')
    await mint('h3')
    assert.equal(publishedCount(), 0, 'nothing publishes while the host still holds the append')
    state.open = false
    await waitFor(fixture.allPublished, { timeoutMs: 3000, what: 'all three sessions to publish after the window' })
    assert.equal(publishedCount(), 3, 'every session is published once the window closes')
    assert.equal(deferralWarns(), 1, 'still one warning for the window, not one per session')
  } finally { state.open = false; fixture.restore(); await shutdown(ctx) }
})

await test('a refresh in a real append window does not register twice inside one tick', async () => {
  const fixture = await setup()
  const { ctx, state, tools, agents, mint, reset, notify, touches, deferralWarns } = fixture
  try {
    for (const id of ['r1', 'r2', 'r3']) await mint(id)
    await waitFor(fixture.allPublished, { timeoutMs: 1500, what: 'the first publication of three sessions' })
    const firstDefinitions = ['r1', 'r2', 'r3'].map(id => tools.get('ops_bash', agents.get(id)))
    reset()
    state.open = true
    notify()
    await flush()
    assert.ok(touches() <= 2, `the pass stops at the first refusal: ${touches()} registry write(s)`)
    assert.ok(state.register <= 1, `no second register in the same tick: ${state.register}`)
    assert.ok(deferralWarns() <= 1, `one warning for the window: ${deferralWarns()}`)
    await tick(10)
    assert.ok(touches() <= 2, 'nothing else touches the registry during the cooldown')
    // While the window is held the refusal must leave the live layer exactly as it was: the same
    // definition object, never a replacement and never a withdrawal. (After the window closes the
    // cooled pass legitimately rebuilds the definition, so this identity check belongs here.)
    assert.equal(state.register, 0, 'a refused refresh offers no replacement definition')
    for (const [index, id] of ['r1', 'r2', 'r3'].entries()) {
      assert.equal(tools.get('ops_bash', agents.get(id)), firstDefinitions[index],
        `${id} is still served by the definition that was live before the window`)
    }
    state.open = false
    await waitFor(fixture.allPublished, { timeoutMs: 3000, what: 'the cooled pass to republish three sessions' })
    assert.equal(fixture.publishedCount(), 3, 'all three sessions stay published')
    assert.equal(deferralWarns(), 1, 'the same window never reports twice')
    for (const id of ['r1', 'r2', 'r3']) assert.ok(tools.get('ops_bash', agents.get(id)), `${id} keeps a bash layer`)
  } finally { state.open = false; fixture.restore(); await shutdown(ctx) }
})

report('shells-append-reentry-host')
