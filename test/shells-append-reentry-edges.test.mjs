/**
 * #579 edges: the cooldown ladder, timer hygiene, classifier shapes and a clock rollback.
 *
 * The sibling suite (`shells-append-reentry.test.mjs`) proves the fix's shape with wall-clock
 * waits. This one drives the same component through a **controllable clock**: `Date.now`,
 * `setTimeout` and `setImmediate` are replaced for the duration of a check, so the ladder
 * 25/100/400/1000 is measured exactly and the suite never sleeps on a real cooldown. Every
 * check restores the globals before the next one starts; the real host is still the harness's
 * own (real registry, real scope lifecycle), and only the registry's `register`/disposer pair
 * is stubbed to produce the host's append-window refusal.
 *
 * Findings are recorded in `worklogs/dshops-issues-20261102/verify/579-edges.md`
 * (§2 findings, §3 the classifier table, §4 the clock rollback, §5 the fake-clock trade-offs).
 *
 * @module dsh-ops/test/shells-append-reentry-edges
 */
import { createScope } from '@deepseek-ai/dsh-scope'
import { assert, report, test, wait, waitFor } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { mountSessionBash } from '../lib/session-shells.js'

/** The host message this package classifies (it lives outside this repository). */
const HOST_REFUSAL = 'session append cannot reenter while another append is being published'
/** Captured before any check swaps the globals, so a fixture can always settle itself. */
const REAL_IMMEDIATE = globalThis.setImmediate
const realFlush = () => new Promise(resolve => REAL_IMMEDIATE(resolve))
/**
 * Set while the fake clock is installed.
 *
 * `harness.waitFor` derives its deadline from `Date.now()`. With the fake clock installed that
 * deadline never arrives, so a stray `waitFor` would **spin forever instead of failing**. Every
 * wait in this suite goes through {@link waitForReal}, which turns that mistake into an
 * immediate, named error.
 */
let clockInstalled = false

/**
 * `waitFor` with the fake-clock hazard removed.
 * @param {() => boolean} condition - the predicate.
 * @param {object} [options] - harness wait options.
 * @returns {Promise<void>} resolves once the condition holds.
 */
function waitForReal(condition, options) {
  if (clockInstalled) {
    throw new Error('waitFor() must not run while the fake clock is installed: its deadline reads Date.now() and the loop would spin forever instead of failing')
  }
  return waitFor(condition, options)
}

/**
 * Replace the clock the component reads.
 *
 * `advance` moves time and fires every timer that becomes due; `fireNext` runs the earliest
 * timer *without* moving the clock, which models "real time passed, `Date.now()` is wrong"
 * (an NTP rollback). Timers record the clock value at arm time so an assertion can prove the
 * delay was measured from that moment.
 * @param {number} [start] - the fake wall clock in Unix milliseconds.
 * @returns {object} the clock handle.
 */
function installClock(start = 1_700_000_000_000) {
  // Enables the waitForReal guard: nothing may call harness.waitFor until uninstall().
  clockInstalled = true
  const real = {
    now: Date.now,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setImmediate: globalThis.setImmediate,
    clearImmediate: globalThis.clearImmediate,
  }
  const state = { now: start, timers: [], immediates: [], nextId: 1 }
  Date.now = () => state.now
  globalThis.setTimeout = (fn, ms) => {
    const delay = Number(ms) || 0
    const id = state.nextId++
    state.timers.push({ id, delay, armNow: state.now, due: state.now + delay, fn, cleared: false, ran: false })
    return id
  }
  globalThis.clearTimeout = id => {
    const timer = state.timers.find(row => row.id === id)
    if (timer) timer.cleared = true
  }
  globalThis.setImmediate = fn => {
    const id = state.nextId++
    state.immediates.push({ id, fn, cleared: false, ran: false })
    return id
  }
  globalThis.clearImmediate = id => {
    const immediate = state.immediates.find(row => row.id === id)
    if (immediate) immediate.cleared = true
  }
  const clock = {
    now: () => state.now,
    timers: () => state.timers,
    /** Timers that are still waiting to fire. */
    armed: () => state.timers.filter(timer => !timer.cleared && !timer.ran),
    pending: () => clock.armed().length,
    /** Run queued immediates (and anything they queue) until the queue is empty. */
    async pump(rounds = 100) {
      for (let round = 0; round < rounds; round += 1) {
        const batch = state.immediates.filter(immediate => !immediate.cleared && !immediate.ran)
        if (batch.length === 0) {
          await Promise.resolve()
          if (!state.immediates.some(immediate => !immediate.cleared && !immediate.ran)) return
          continue
        }
        for (const immediate of batch) {
          if (immediate.cleared || immediate.ran) continue
          immediate.ran = true
          immediate.fn()
        }
        await Promise.resolve()
      }
      throw new Error('clock.pump did not settle')
    },
    /** Move time forward and fire every timer that becomes due, pumping between. */
    async advance(ms) {
      state.now += ms
      for (;;) {
        const due = state.timers
          .filter(timer => !timer.cleared && !timer.ran && timer.due <= state.now)
          .sort((left, right) => left.due - right.due || left.id - right.id)[0]
        if (!due) return
        due.ran = true
        due.fn()
        await clock.pump()
      }
    },
    /** Fire the earliest pending timer without moving the clock: the NTP-rollback shape. */
    async fireNext() {
      const next = state.timers
        .filter(timer => !timer.cleared && !timer.ran)
        .sort((left, right) => left.due - right.due || left.id - right.id)[0]
      if (!next) throw new Error('no pending cooldown timer to fire')
      next.ran = true
      next.fn()
      await clock.pump()
      return next
    },
    /** Fire timers that a scheduler armed with no delay, without moving wall time. */
    async flushZeroDelay(rounds = 100) {
      for (let round = 0; round < rounds; round += 1) {
        const zero = state.timers
          .filter(timer => !timer.cleared && !timer.ran && timer.delay === 0)
          .sort((left, right) => left.due - right.due || left.id - right.id)[0]
        if (!zero) return
        zero.ran = true
        zero.fn()
        await clock.pump()
      }
      throw new Error('clock.flushZeroDelay did not settle')
    },
    /** A one-line description of unfinished fake work, for a hang diagnosis. */
    describe() {
      const timers = state.timers.map(timer => `timer(${timer.delay}ms cleared=${timer.cleared} ran=${timer.ran})`).join(' ')
      const immediates = state.immediates.filter(immediate => !immediate.cleared && !immediate.ran).length
      return `pending immediates=${immediates} timers=[${timers}] now=${state.now}`
    },
    /** Move the wall clock backwards; real time keeps moving. */
    rollback(ms) { state.now -= ms },
    uninstall() {
      clockInstalled = false
      Date.now = real.now
      globalThis.setTimeout = real.setTimeout
      globalThis.clearTimeout = real.clearTimeout
      globalThis.setImmediate = real.setImmediate
      globalThis.clearImmediate = real.clearImmediate
    },
  }
  return clock
}

/**
 * Settle a promise whose resolution may depend on the fake queue.
 * @param {object} clock - the installed clock.
 * @param {Promise<unknown>} promise - the work to settle.
 * @returns {Promise<unknown>} the promise's value.
 */
async function drain(clock, promise) {
  let outcome
  promise.then(value => { outcome = { done: true, value } }, error => { outcome = { done: true, error } })
  for (let round = 0; round < 200 && outcome === undefined; round += 1) {
    await clock.pump()
    await clock.flushZeroDelay()
    // The queued pass lives on the fake clock, but cordis' own disposal still needs real
    // macrotasks *and* real time to advance (its scheduler keeps its own timers): yield both,
    // one millisecond per round, which never reaches the armed cooldown below.
    await wait(1)
  }
  if (outcome === undefined) throw new Error(`the component never settled while the fake clock was installed (${clock.describe()})`)
  if (outcome.error) throw outcome.error
  return outcome.value
}

/**
 * Boot a host whose only bash dependency is the real registry, then stub that registry with a
 * counter and two controllable failure modes (the host's append window, one unrelated error).
 * @param {object} [options] - fixture switches.
 * @param {boolean} [options.refuseDispose] - also refuse the withdrawal a pass starts with, the
 *   way the host refuses every append while it publishes.
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
  const state = {
    open: false, generic: 0, register: 0, dispose: 0,
    throwFactory: () => new Error(HOST_REFUSAL),
  }
  const hadOwn = Object.hasOwn(tools, 'register')
  const original = tools.register
  // A scoped registry calls this through its own binding, so the receiver must be forwarded:
  // registering through the root instance instead would publish every agent into one scope.
  tools.register = function counted(definition) {
    state.register += 1
    if (state.generic > 0) { state.generic -= 1; throw new Error('the registry refused for an unrelated reason') }
    if (state.open) throw state.throwFactory()
    const dispose = original.call(this, definition)
    return () => {
      state.dispose += 1
      if (refuseDispose && state.open) throw state.throwFactory()
      dispose()
    }
  }
  let notify
  const gate = { allows: () => true, watch(listener) { notify = listener; return () => { notify = undefined } } }
  const fiber = await ctx.plugin({ inject: ['tools'], apply(inner) {
    mountSessionBash(inner, { publishBashTool: true }, { bash: { available: true, file: process.execPath, source: 'explicit', detail: 'edges only' } }, gate)
  } })
  const agents = new Map()
  const mint = async id => {
    const agent = { id, session: { id, header: { cwd: process.env.DSH_HOME } } }
    agent.ctx = createScope(ctx, agent).ctx
    await ctx.serial('agent/created', { agent })
    await realFlush()
    agents.set(id, agent)
    return agent
  }
  const published = id => tools.get('ops_bash', agents.get(id)) !== undefined
  return {
    ctx, tools, fiber, warns, state, agents, mint, published,
    notify: () => { notify?.() },
    reset() { state.register = 0; state.dispose = 0; warns.length = 0 },
    resetCounters() { state.register = 0; state.dispose = 0 },
    attempts: () => state.register + state.dispose,
    deferralWarns: () => warns.filter(line => /publishing an append/.test(line)).length,
    failureWarns: () => warns.filter(line => /bash publication failed/.test(line)).length,
    restore() { if (hadOwn) tools.register = original; else delete tools.register },
  }
}

/** Refuse one pass with the host's window open, and return the cooldown timer it armed. */
async function armOnce(fixture, clock) {
  fixture.state.open = true
  fixture.notify()
  await clock.pump()
  const armed = clock.armed()
  assert.equal(armed.length, 1, 'one refused pass arms exactly one cooldown timer')
  return armed[0]
}

// -------------------------------------------------------------------------------------------------
// 1. ladder

await test('the cooldown ladder steps 25/100/400/1000 ms and caps at the last step', async () => {
  const fixture = await setup()
  try {
    await fixture.mint('ladder')
    await waitForReal(() => fixture.published('ladder'), { timeoutMs: 2000, what: 'the first publication' })
    fixture.reset()
    const clock = installClock()
    try {
      const steps = []
      let timer = await armOnce(fixture, clock)
      steps.push(timer.delay)
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await clock.advance(timer.delay)
        const armed = clock.armed()
        assert.equal(armed.length, 1, `refusal ${attempt + 2}: exactly one timer is armed`)
        timer = armed[0]
        steps.push(timer.delay)
      }
      assert.deepEqual(steps, [25, 100, 400, 1000, 1000],
        `the ladder must be 25 -> 100 -> 400 -> 1000 -> 1000 (cap), measured: ${steps.join(' -> ')}`)
      // The timer records `armNow`/`due` from the clock itself, so `due - armNow === delay` would
      // restate the fake clock's own bookkeeping and could never fail. The discriminating
      // measurement is the sequence above; nothing else is claimed about the deadline.
      assert.equal(fixture.deferralWarns(), 1, 'the window is reported once for the whole ladder')
      // A pass that starts while the cooldown runs must not touch the registry at all.
      fixture.resetCounters()
      const before = clock.timers().length
      fixture.notify()
      await clock.pump()
      assert.equal(fixture.attempts(), 0, 'a cooldown pass performs no register and no dispose')
      assert.equal(clock.timers().length, before, 'a cooldown pass arms no additional timer')
      assert.equal(fixture.deferralWarns(), 1, 'a deferred pass adds no second warning for the window')
    } finally { clock.uninstall() }
  } finally { fixture.state.open = false; fixture.restore(); await shutdown(fixture.ctx) }
})

// -------------------------------------------------------------------------------------------------
// 2. reset after a completed pass

await test('a completed pass resets the cooldown ladder to its first step', async () => {
  const fixture = await setup()
  try {
    await fixture.mint('reset')
    await waitForReal(() => fixture.published('reset'), { timeoutMs: 2000, what: 'the first publication' })
    fixture.reset()
    const clock = installClock()
    try {
      const first = await armOnce(fixture, clock)
      assert.equal(first.delay, 25)
      // The window closes before the cooldown expires: the cooled pass must complete and reset.
      fixture.state.open = false
      fixture.reset()
      await clock.advance(first.delay)
      assert.ok(fixture.state.register > 0, 'the cooled pass republishes once the window is open')
      assert.equal(clock.pending(), 0, 'a completed pass leaves no cooldown timer behind')
      // The next refusal has to start from the first step again.
      fixture.reset()
      const again = await armOnce(fixture, clock)
      assert.equal(again.delay, 25,
        `a completed pass resets the ladder (measured ${again.delay}, expected 25)`)
      assert.equal(fixture.deferralWarns(), 1, 'the second window is reported once, too')
    } finally { clock.uninstall() }
  } finally { fixture.state.open = false; fixture.restore(); await shutdown(fixture.ctx) }
})

// -------------------------------------------------------------------------------------------------
// 3. timer hygiene

await test('teardown clears the armed cooldown timer and nothing fires afterwards', async () => {
  const fixture = await setup()
  try {
    await fixture.mint('teardown')
    await waitForReal(() => fixture.published('teardown'), { timeoutMs: 2000, what: 'the first publication' })
    fixture.reset()
    const clock = installClock()
    try {
      await armOnce(fixture, clock)
      assert.equal(clock.pending(), 1, 'a cooldown timer is armed before teardown')
      const armed = clock.armed()[0]
      // `ctx.effect` teardown is asynchronous: drive it to completion, then prove the timer is gone.
      const disposing = fixture.fiber.dispose()
      await drain(clock, disposing)
      assert.equal(clock.pending(), 0, 'component teardown clears the armed cooldown timer')
      assert.equal(armed.cleared, true, 'the armed cooldown timer was cleared, not merely fired')
      assert.ok(clock.timers().every(timer => timer.cleared), 'no cooldown timer survives teardown')
      fixture.reset()
      await clock.advance(60_000)
      assert.equal(fixture.attempts(), 0, 'a cleared cooldown timer cannot fire a pass after teardown')
      assert.equal(clock.timers().length, 1, 'teardown schedules no replacement timer')
    } finally { clock.uninstall() }
  } finally { fixture.state.open = false; fixture.restore(); await shutdown(fixture.ctx) }
})

// -------------------------------------------------------------------------------------------------
// 4. detach inside a cooldown

await test('detaching a session inside a cooldown withdraws its layer at once', async () => {
  const fixture = await setup({ refuseDispose: true })
  try {
    const agent = await fixture.mint('detach')
    await waitForReal(() => fixture.published('detach'), { timeoutMs: 2000, what: 'the first publication' })
    fixture.reset()
    const clock = installClock()
    try {
      // The refusal lands on the withdrawal, so the layer is still live when the cooldown starts.
      const armed = await armOnce(fixture, clock)
      assert.ok(fixture.tools.get('ops_bash', agent), 'the refused withdrawal left the layer live')
      // The host window closes, the cooldown does not: detach must still revoke immediately.
      fixture.state.open = false
      fixture.reset()
      await drain(clock, fixture.ctx.serial('agent/disposed', { agent }))
      assert.equal(fixture.tools.get('ops_bash', agent), undefined,
        'a detach inside the cooldown withdraws the layer immediately')
      assert.ok(fixture.state.dispose >= 1, 'the retained disposer ran')
      // The armed cooldown must still be pending: had the withdrawal waited for it, the timer would
      // have fired or been cleared. `armed.due` is a fixed deadline, so compare against it through
      // the clock's own pending count rather than against `now()`, which `drain` deliberately leaves
      // untouched (that is what makes "never advanced" the point of this fixture).
      assert.equal(armed.cleared, false, 'the detach did not clear the cooldown timer that was already armed')
      assert.equal(clock.pending(), 1, 'the armed cooldown survives the detach and still owes its pass')
    } finally { clock.uninstall() }
  } finally { fixture.state.open = false; fixture.restore(); await shutdown(fixture.ctx) }
})

// -------------------------------------------------------------------------------------------------
// 5. classifier shapes (measured table)

await test('refusal shapes classify or degrade to the old behaviour: the measured table', async () => {
  const shapes = [
    ['string carrying the host text', () => HOST_REFUSAL, true],
    ['plain object with message', () => ({ message: HOST_REFUSAL }), true],
    ['Error with a cause', () => Object.assign(new Error(HOST_REFUSAL), { cause: new Error('inner append lock') }), true],
    ['Error with prefix and suffix', () => new Error(`ERR_HOST_APPEND: ${HOST_REFUSAL} (epoch 7)`), true],
    ['upper-cased host text', () => new Error(HOST_REFUSAL.toUpperCase()), false],
    ['Error wrapping the host text as its cause', () => new Error('host wrapper', { cause: new Error(HOST_REFUSAL) }), false],
    ['object with a null message', () => ({ message: null }), false],
    ['a number', () => 42, false],
    ['undefined', () => undefined, false],
  ]
  const rows = []
  for (const [label, factory, expectedCooled] of shapes) {
    const fixture = await setup()
    let clock
    try {
      await fixture.mint('shape')
      await waitForReal(() => fixture.published('shape'), { timeoutMs: 2000, what: `the first publication (${label})` })
      fixture.reset()
      clock = installClock()
      fixture.state.throwFactory = factory
      await armOnce(fixture, clock).catch(() => undefined) // the generic path arms nothing
      const cooled = clock.pending() === 1
      const generic = fixture.failureWarns() > 0
      rows.push({ label, cooled, generic })
      assert.equal(cooled, expectedCooled,
        `${label}: expected ${expectedCooled ? 'the cooled path' : 'the generic path'}, measured cooled=${cooled} generic=${generic}`)
      if (expectedCooled) {
        assert.equal(fixture.deferralWarns(), 1, `${label}: one deferral warning`)
        assert.equal(generic, false, `${label}: a classified refusal is not a publication failure`)
      } else {
        assert.equal(cooled, false, `${label}: no cooldown timer`)
        assert.equal(fixture.deferralWarns(), 0, `${label}: the cooled path must not be taken`)
      }
    } finally {
      fixture.state.open = false
      fixture.state.throwFactory = () => new Error(HOST_REFUSAL)
      clock?.uninstall()
      fixture.restore()
      await shutdown(fixture.ctx)
    }
  }
  console.log('refusal-shape table (measured):')
  console.log('  shape                                        | path')
  for (const row of rows) {
    console.log(`  ${row.label.padEnd(44)} | ${row.cooled ? 'cooled (classified)' : 'generic (old behaviour)'}`)
  }
  // The classifier is total (`safeMessage` in src/session-shells.ts): a shape whose `message` getter
  // throws is treated as unclassified instead of aborting the pass, so no cooldown is armed and the
  // old warn-and-restore path runs. `test/shells-append-reentry-classifier.test.mjs` asserts that
  // directly; this probe deliberately pins only what holds regardless of how the row was reached —
  // an unclassified shape never arms the cooled path and never loops inline — and prints which
  // branch it observed, so a future regression shows up as a changed label rather than a silent pass.
  const fixture = await setup()
  try {
    await fixture.mint('getter')
    await waitForReal(() => fixture.published('getter'), { timeoutMs: 2000, what: 'the first publication (getter)' })
    fixture.reset()
    const clock = installClock()
    try {
      fixture.state.throwFactory = () => ({ get message() { throw new TypeError('the message getter itself threw') } })
      fixture.state.open = true
      fixture.notify()
      let classifierThrew = false
      try { await clock.pump() } catch { classifierThrew = true }
      console.log(`non-Error throwing-getter shape: classifier ${classifierThrew ? 'THREW (not total yet — see TODO above)' : 'did not throw (total)'}`)
      assert.equal(clock.pending(), 0, 'an unclassified shape must never arm the cooled path')
      assert.ok(fixture.state.register <= 2,
        'the refused register is attempted at most twice (the attempt plus the old restore pass), never an inline retry loop')
    } finally { clock.uninstall() }
  } finally {
    fixture.state.open = false
    fixture.state.throwFactory = () => new Error(HOST_REFUSAL)
    fixture.restore()
    await shutdown(fixture.ctx)
  }
})

// -------------------------------------------------------------------------------------------------
// 6. clock rollback

await test('a backward Date.now jump costs one extra pass and never wedges the cooldown', async () => {
  const fixture = await setup()
  try {
    await fixture.mint('rollback')
    await waitForReal(() => fixture.published('rollback'), { timeoutMs: 2000, what: 'the first publication' })
    fixture.reset()
    const clock = installClock()
    try {
      const armed = await armOnce(fixture, clock)
      assert.equal(armed.delay, 25)
      fixture.state.open = false
      // NTP moves the wall clock back a minute while the armed timer keeps its real deadline.
      clock.rollback(60_000)
      await clock.fireNext()
      const extra = clock.armed()
      assert.equal(extra.length, 1, 'the pass that ran while the clock was behind re-armed instead of publishing')
      assert.equal(extra[0].delay, 100, 'the ladder continues from the next step')
      // Only two timers may exist: the one that fired and this replacement. A third would mean the
      // rolled-back pass armed twice — the burst #579 exists to prevent. (Comparing `armNow`
      // values instead would only restate the fake clock's own arithmetic.)
      assert.equal(clock.timers().length, 2, 'the deferred pass arms exactly one replacement timer')
      assert.equal(fixture.published('rollback'), false, 'still unpublished right after the rollback')
      await clock.advance(extra[0].delay)
      assert.ok(fixture.published('rollback'), 'one more step recovers: the rollback does not wedge the cooldown')
      assert.equal(clock.pending(), 0, 'no timer is left after the recovery')
      assert.equal(fixture.deferralWarns(), 1, 'the window is still reported once')
      // A rollback with the window still open must not starve the retries either: the next
      // deadline is recomputed from the current clock, so the pass makes an attempt again.
      fixture.state.open = true
      fixture.reset()
      const again = await armOnce(fixture, clock)
      assert.equal(again.delay, 25, 'the completed pass reset the ladder before this window')
      clock.rollback(60_000)
      await clock.fireNext()
      const third = clock.armed()
      assert.equal(third.length, 1, 'the deferred pass armed the next step')
      fixture.reset()
      await clock.advance(third[0].delay)
      assert.ok(fixture.attempts() > 0, 'an attempt is still made after the second rollback: no starvation')
      assert.equal(clock.pending(), 1, 'the open window keeps one bounded timer armed')
    } finally { clock.uninstall() }
  } finally { fixture.state.open = false; fixture.restore(); await shutdown(fixture.ctx) }
})

report('shells-append-reentry-edges')
