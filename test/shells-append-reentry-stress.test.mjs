/**
 * #579 under uncooperative timing: randomized windows and a 200-session scale run.
 *
 * The deterministic suite (`shells-append-reentry.test.mjs`) pins five shapes. This one asks the
 * same question with the timing left to chance: a fixed seed decides the session count, the window
 * length, the host-event interval and whether the window is one long hold or one short hold per new
 * session. Every round must keep four properties:
 *
 *   · registry touches inside an append window stay under a bound that does not grow with the
 *     number of sessions — the pre-fix layer retried once per tracked session per pass, which is
 *     what turned a locked window into a burst;
 *   · at most one `register` happens in one macrotask while the window is held, and no definition
 *     object is registered twice in that turn — the reproducible form of "the same agent is never
 *     registered twice in one tick" (a retry would reuse the definition object the restore path
 *     holds);
 *   · once the window closes, every session is published again within the cooldown cap, with real
 *     timers (no fake clock);
 *   · nothing is left running afterwards: no retained pass, no unhandled rejection.
 *
 * The implementation is chosen by `DSH_OPS_IMPL_ROOT` so the same file can be pointed at a pristine
 * checkout for the baseline contrast in the report; the default is this worktree's build.
 *
 * @module dsh-ops/test/shells-append-reentry-stress
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createScope } from '@deepseek-ai/dsh-scope'
import { assert, report, test } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'

/** The module under test: this worktree's build, or another checkout's for the baseline run. */
const IMPL_URL = process.env.DSH_OPS_IMPL_ROOT
  ? pathToFileURL(path.join(process.env.DSH_OPS_IMPL_ROOT, 'lib/session-shells.js')).href
  : new URL('../lib/session-shells.js', import.meta.url).href
const { mountSessionBash } = await import(IMPL_URL)

/** The host message this package classifies (it lives outside this repository). */
const HOST_REFUSAL = 'session append cannot reenter while another append is being published'
const flush = () => new Promise(resolve => setImmediate(resolve))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Fixed seed: the same round list on every rerun and every CI run; overridable for a sweep. */
const SEED = Number(process.env.DSH_OPS_STRESS_SEED ?? 20261104)
/** One hundred rounds is this suite's floor; the override exists for the baseline report run. */
const ROUNDS = Number(process.env.DSH_OPS_STRESS_ROUNDS ?? 100)
/** Scale run: sessions created while one long window is held. */
const SCALE_SESSIONS = Number(process.env.DSH_OPS_STRESS_SCALE ?? 200)
const SCALE_WINDOW_MS = 1000
/**
 * Touches allowed inside one append window, as an absolute number.
 *
 * The point of this bound is that it does **not** move with the session count: measured on this
 * host, one window cost 4–6 touches at n = 1, n = 12 and n = 200 alike, while the pre-fix layer
 * cost 52 / 159 / 702 at n = 1 / 3 / 12 and 34 900 at n = 200. Ten leaves room for a slow pass that
 * spends a refused withdrawal *and* a refused register on every cooldown step, and still fails the
 * pre-fix burst immediately.
 */
const TOUCH_LIMIT_PER_WINDOW = 10
/** The 200-session scale run is measured at 4–5 touches; a tighter cap keeps that claim honest. */
const SCALE_TOUCH_LIMIT = 8
/** Measured 1: a pass stops at the first refusal, so a window never sees two registers in one turn. */
const REGISTERS_PER_TURN_LIMIT = 1
/**
 * How long a round may take to republish after its window closes.
 *
 * The layer's cooldown ladder caps at 1 000 ms, and the measured time to republish on this host was
 * 763–1 113 ms across runs — a 46% spread on the same machine. A 1 500 ms budget left only 1.35×
 * headroom and produced false reds under the load a full `shells` filter creates; the deterministic
 * suite caps the same property at 3 000 ms, so this one does too (≈2.7× the measured upper bound).
 */
const CONVERGE_DEADLINE_MS = 3000
/** Poll cadence while waiting for convergence: fast enough to be accurate, cheap enough to ignore. */
const CONVERGE_POLL_MS = 25

/** Deterministic PRNG (mulberry32): a fixed seed yields a fixed round list. */
function prng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Errors no suite may swallow: a rejected promise or a throw inside a timer is a real defect. */
const crashes = []
const onRejection = reason => { crashes.push(`unhandledRejection: ${reason}`) }
const onException = error => { crashes.push(`uncaughtException: ${error}`) }
process.on('unhandledRejection', onRejection)
process.on('uncaughtException', onException)

/**
 * One mounted layer over a host whose registry refuses writes while `state.open` is held.
 *
 * Every register and every withdrawal is counted; a window (one contiguous `open` interval) is
 * measured separately, so "touches inside a window" never mixes in passes that run while the host
 * is free. Successful registrations are tracked through their own disposer: `live` is the number of
 * layers that currently exist, which is the observable counterpart of the module's private
 * `entries` map, so a leak shows up as `live` exceeding the session count.
 * @param {object} [options] - fixture switches.
 * @param {boolean} [options.refuseDispose] - also refuse the withdrawal a pass starts with.
 * @returns {Promise<object>} the fixture surface.
 */
async function setup({ refuseDispose = true } = {}) {
  const { ctx, tools } = await bootHost()
  const warns = []
  ctx.logger.warn = (...parts) => { warns.push(parts.join(' ')) }
  await ctx.plugin(inner => {
    inner.provide('subprocess', { spawn() { throw new Error('publication test must not execute') } })
    inner.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: process.env.DSH_HOME }) })
  })
  const state = {
    open: false, windowId: 0, touchesByWindow: new Map(), registersByTurn: new Map(),
    definitionsByTurn: new Map(), duplicateDefinitions: 0,
    register: 0, dispose: 0, live: 0, maxLive: 0,
  }
  let turn = 0
  const realImmediate = globalThis.setImmediate
  globalThis.setImmediate = function instrumented(fn, ...rest) {
    return realImmediate.call(globalThis, (...args) => { turn += 1; fn(...args) }, ...rest)
  }
  const hadOwn = Object.hasOwn(tools, 'register')
  const original = tools.register
  /** Count one touch against the window it happens in (0 = while the host is free). */
  const countTouch = () => {
    if (!state.open) return
    state.touchesByWindow.set(state.windowId, (state.touchesByWindow.get(state.windowId) ?? 0) + 1)
  }
  tools.register = function counted(definition) {
    state.register += 1
    if (state.open) {
      countTouch()
      state.registersByTurn.set(turn, (state.registersByTurn.get(turn) ?? 0) + 1)
      const definitions = state.definitionsByTurn.get(turn) ?? new Set()
      if (definitions.has(definition)) state.duplicateDefinitions += 1
      definitions.add(definition)
      state.definitionsByTurn.set(turn, definitions)
      throw new Error(HOST_REFUSAL)
    }
    const dispose = original.call(this, definition)
    state.live += 1
    state.maxLive = Math.max(state.maxLive, state.live)
    let withdrawn = false
    return () => {
      if (withdrawn) return
      state.dispose += 1
      if (state.open && refuseDispose) {
        // The layer is still live and this hook stays retryable: the classification under test is
        // what a later pass observes, so neither `live` nor the latch changes here.
        countTouch()
        throw new Error(HOST_REFUSAL)
      }
      withdrawn = true
      state.live -= 1
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
  const allPublished = () => agents.size > 0 && [...agents.keys()].every(published)
  /** Hold the host window; every hold→release pair is one measured window. */
  const hold = () => { state.open = true; state.windowId += 1 }
  const release = () => { state.open = false }
  /** Drive one host event per agent, the cadence a real append burst has. */
  const driveOnce = async () => {
    for (const agent of agents.values()) await ctx.serial('session/event', agent.session, { type: 'agent-preset/selected' })
  }
  const drive = async (ms, interval) => {
    const until = Date.now() + ms
    while (Date.now() < until) { await driveOnce(); await sleep(interval) }
  }
  /**
   * Poll until every session is published again, or the budget runs out.
   *
   * Polling rather than sleeping a fixed interval is the deflake: a fast machine returns as soon as
   * the layer has republished (measured 763–1 113 ms here, 2 ms hot), and a loaded one still gets
   * the whole budget. The deadline is the assertion; the poll cadence is only observation cost.
   * @param {number} deadlineMs - total budget for the wait, in milliseconds.
   * @returns {Promise<number|undefined>} elapsed milliseconds, or undefined on timeout.
   */
  const waitConverged = async (deadlineMs) => {
    const started = Date.now()
    for (;;) {
      if (allPublished()) return Date.now() - started
      if (Date.now() - started >= deadlineMs) return undefined
      await sleep(Math.min(CONVERGE_POLL_MS, Math.max(1, deadlineMs - (Date.now() - started))))
    }
  }
  const restore = () => {
    globalThis.setImmediate = realImmediate
    if (hadOwn) tools.register = original
    else delete tools.register
  }
  return {
    ctx, tools, warns, state, agents, mint, published, allPublished, drive, driveOnce,
    hold, release, waitConverged, restore,
    deferralWarns: () => warns.filter(line => /publishing an append/.test(line)).length,
    failureWarns: () => warns.filter(line => /bash publication failed|teardown failed/.test(line)).length,
  }
}

/**
 * Run one randomized round: mint under the window, keep host events coming, close, then require
 * convergence. The returned measurements are what the assertions use and the report quotes.
 * @param {object} plan - the round's random choices, plus the round's own PRNG.
 * @returns {Promise<object>} measurements for this round.
 */
async function runRound({ n, windowMs, interval, shape, random }) {
  const fixture = await setup({ refuseDispose: true })
  const ids = Array.from({ length: n }, (_, index) => `r${index}`)
  try {
    if (shape === 'sustained') {
      fixture.hold()
      const until = Date.now() + windowMs
      // Every planned session is created even when the window is shorter than the minting: the
      // round's n is the session count the assertions speak about, and the hold closes only after
      // both the minting and the window are done.
      for (const id of ids) {
        await fixture.mint(id)
        // A new session is itself a host append: add host events while the same window is held.
        await fixture.driveOnce()
      }
      await fixture.drive(Math.max(0, until - Date.now()), interval)
      fixture.release()
    } else {
      // One short hold per new session, with host events between holds.
      for (const id of ids) {
        fixture.hold()
        const holdMs = Math.floor(random() * 12)
        await fixture.mint(id)
        await sleep(holdMs)
        fixture.release()
        await fixture.driveOnce()
        await sleep(interval)
      }
    }
    const convergenceMs = await fixture.waitConverged(CONVERGE_DEADLINE_MS)
    return {
      n, windowMs, interval, shape,
      maxTouchesInOneWindow: Math.max(0, ...[...fixture.state.touchesByWindow.values()]),
      windows: fixture.state.touchesByWindow.size,
      maxRegistersPerTurn: Math.max(0, ...[...fixture.state.registersByTurn.values()]),
      duplicateDefinitions: fixture.state.duplicateDefinitions,
      convergenceMs,
      published: [...fixture.agents.keys()].filter(id => fixture.published(id)).length,
      maxLive: fixture.state.maxLive,
      deferralWarns: fixture.deferralWarns(),
      failureWarns: fixture.failureWarns(),
    }
  } finally {
    fixture.state.open = false
    fixture.restore()
    await shutdown(fixture.ctx)
  }
}

await test('randomized timing keeps registry touches bounded and republishes every session', async () => {
  const random = prng(SEED)
  const rounds = []
  for (let round = 0; round < ROUNDS; round += 1) {
    const plan = {
      n: 1 + Math.floor(random() * 12),
      windowMs: Math.floor(random() * 801),
      interval: 1 + Math.floor(random() * 50),
      shape: random() < 0.5 ? 'sustained' : 'per-session',
      random,
    }
    const result = await runRound(plan)
    rounds.push(result)
    // Failure diagnostics first, so a future red names the exact round and its random choices
    // (seed included) instead of only reporting a count.
    if (result.published !== plan.n || result.convergenceMs === undefined) {
      console.log(`  DIAGNOSTIC seed=${SEED} round=${round} plan=${JSON.stringify({ n: plan.n, windowMs: plan.windowMs, interval: plan.interval, shape: plan.shape })} `
        + `result=${JSON.stringify(result)}`)
    }
    assert.equal(result.published, plan.n,
      `round ${round} (seed ${SEED}): every session must be published again — ${JSON.stringify(result)}`)
    assert.ok(result.convergenceMs !== undefined && result.convergenceMs <= CONVERGE_DEADLINE_MS,
      `round ${round} (seed ${SEED}): republished within ${CONVERGE_DEADLINE_MS} ms of the window closing — ${JSON.stringify(result)}`)
    assert.ok(result.maxTouchesInOneWindow <= TOUCH_LIMIT_PER_WINDOW,
      `round ${round}: ${result.maxTouchesInOneWindow} touches in one append window, limit ${TOUCH_LIMIT_PER_WINDOW} — ${JSON.stringify(result)}`)
    assert.ok(result.maxRegistersPerTurn <= REGISTERS_PER_TURN_LIMIT,
      `round ${round}: ${result.maxRegistersPerTurn} registers in one macrotask, limit ${REGISTERS_PER_TURN_LIMIT} — ${JSON.stringify(result)}`)
    assert.equal(result.duplicateDefinitions, 0,
      `round ${round}: no definition registered twice in one macrotask — ${JSON.stringify(result)}`)
    assert.ok(result.maxLive <= plan.n, `round ${round}: live layers never exceeded the session count (${result.maxLive} > ${plan.n})`)
  }
  const worstTouches = Math.max(...rounds.map(round => round.maxTouchesInOneWindow))
  const worstConvergence = Math.max(...rounds.map(round => round.convergenceMs ?? Infinity))
  const largest = rounds.filter(round => round.n >= 10)
  const worstLarge = Math.max(...largest.map(round => round.maxTouchesInOneWindow))
  // The independence claim, stated as a comparison rather than a vibe: the worst window cost does
  // not rise with the session count (measured: 4 touches for both n = 1 and n = 12).
  assert.ok(worstLarge <= TOUCH_LIMIT_PER_WINDOW,
    `the worst window cost at n ≥ 10 (${worstLarge}) stays under the session-independent limit ${TOUCH_LIMIT_PER_WINDOW}`)
  const shapes = rounds.reduce((all, round) => ({ ...all, [round.shape]: (all[round.shape] ?? 0) + 1 }), {})
  const convergences = rounds.map(round => round.convergenceMs ?? Number.POSITIVE_INFINITY).sort((a, b) => a - b)
  const percentile = fraction => convergences[Math.min(convergences.length - 1, Math.floor(fraction * convergences.length))]
  console.log(`  measured: seed=${SEED} rounds=${ROUNDS} worstTouchesInOneWindow=${worstTouches} (n>=10: ${worstLarge}) `
    + `convergenceMs[p50=${percentile(0.5)} p90=${percentile(0.9)} max=${worstConvergence}] deadline=${CONVERGE_DEADLINE_MS} `
    + `maxRegistersPerTurn=${Math.max(...rounds.map(round => round.maxRegistersPerTurn))} `
    + `duplicateDefinitions=${rounds.reduce((sum, round) => sum + round.duplicateDefinitions, 0)} shapes=${JSON.stringify(shapes)}`)
  assert.equal(crashes.length, 0, `no unhandled rejection or uncaught exception across ${ROUNDS} rounds`)
})

await test('two hundred sessions under one held window cost the same bounded trickle and converge', async () => {
  const ids = Array.from({ length: SCALE_SESSIONS }, (_, index) => `s${index}`)
  // Cold start: nothing is published yet, so the window can only cost refusals. The layer count is
  // therefore the session count *after* convergence, never during the cold window.
  {
    const fixture = await setup({ refuseDispose: true })
    try {
      fixture.hold()
      for (const id of ids) await fixture.mint(id)
      await fixture.drive(SCALE_WINDOW_MS, 10)
      const touchesInWindow = Math.max(0, ...[...fixture.state.touchesByWindow.values()])
      const registersPerTurn = Math.max(0, ...[...fixture.state.registersByTurn.values()])
      const liveAtWindowEnd = fixture.state.live
      fixture.release()
      const convergenceMs = await fixture.waitConverged(CONVERGE_DEADLINE_MS)
      // No leak: the layer count is the session count after the window, and a quiet period
      // produces no registry traffic at all (a retained timer or pass would show up here).
      const liveAfterClose = ids.filter(id => fixture.published(id)).length
      const idleFrom = fixture.state.register + fixture.state.dispose
      await sleep(250)
      const idleTouches = fixture.state.register + fixture.state.dispose - idleFrom
      console.log(`  measured (cold): sessions=${SCALE_SESSIONS} windowMs=${SCALE_WINDOW_MS} touchesInWindow=${touchesInWindow} `
        + `registersPerTurn=${registersPerTurn} convergenceMs=${convergenceMs} liveAtWindowEnd=${liveAtWindowEnd} `
        + `liveAfterClose=${liveAfterClose} maxLive=${fixture.state.maxLive} idleTouches=${idleTouches} `
        + `deferralWarns=${fixture.deferralWarns()} failureWarns=${fixture.failureWarns()}`)
      assert.ok(touchesInWindow <= SCALE_TOUCH_LIMIT,
        `${touchesInWindow} touches in a ${SCALE_WINDOW_MS} ms window at ${SCALE_SESSIONS} sessions, limit ${SCALE_TOUCH_LIMIT}`)
      assert.ok(registersPerTurn <= REGISTERS_PER_TURN_LIMIT,
        `${registersPerTurn} registers in one macrotask at ${SCALE_SESSIONS} sessions, limit ${REGISTERS_PER_TURN_LIMIT}`)
      assert.equal(fixture.state.duplicateDefinitions, 0, 'no definition registered twice in one macrotask')
      assert.ok(convergenceMs !== undefined && convergenceMs <= CONVERGE_DEADLINE_MS,
        `${SCALE_SESSIONS} sessions republished within ${CONVERGE_DEADLINE_MS} ms of the window closing (took ${convergenceMs})`)
      assert.equal(liveAtWindowEnd, 0, 'a cold window publishes nothing, so it cannot leak a layer')
      assert.equal(liveAfterClose, SCALE_SESSIONS, 'every session has exactly one live layer after the window')
      assert.equal(fixture.state.maxLive, SCALE_SESSIONS, `no session was ever double-registered (max live ${fixture.state.maxLive})`)
      assert.equal(idleTouches, 0, 'a quiet period after convergence produces no registry traffic')
      assert.equal(fixture.deferralWarns(), 1, 'one held window is reported once, not once per session')
      assert.equal(crashes.length, 0, 'no unhandled rejection or uncaught exception during the cold scale run')
    } finally {
      fixture.state.open = false
      fixture.restore()
      await shutdown(fixture.ctx)
    }
  }
  // Hot start: 200 layers exist before the window opens. The tracked-entry count must be identical
  // before, inside and after the window — the leak check the issue asks for in the shape where a
  // leak would actually be visible.
  {
    const fixture = await setup({ refuseDispose: true })
    try {
      for (const id of ids) await fixture.mint(id)
      const publishStart = Date.now()
      while (Date.now() - publishStart < CONVERGE_DEADLINE_MS && !fixture.allPublished()) await sleep(CONVERGE_POLL_MS)
      const liveBeforeWindow = ids.filter(id => fixture.published(id)).length
      fixture.hold()
      await fixture.drive(SCALE_WINDOW_MS, 10)
      const touchesInWindow = Math.max(0, ...[...fixture.state.touchesByWindow.values()])
      const registersPerTurn = Math.max(0, ...[...fixture.state.registersByTurn.values()])
      const liveInWindow = ids.filter(id => fixture.published(id)).length
      fixture.release()
      const convergenceMs = await fixture.waitConverged(CONVERGE_DEADLINE_MS)
      const liveAfterClose = ids.filter(id => fixture.published(id)).length
      console.log(`  measured (hot):   sessions=${SCALE_SESSIONS} windowMs=${SCALE_WINDOW_MS} touchesInWindow=${touchesInWindow} `
        + `registersPerTurn=${registersPerTurn} convergenceMs=${convergenceMs} liveBefore=${liveBeforeWindow} `
        + `liveInWindow=${liveInWindow} liveAfterClose=${liveAfterClose} maxLive=${fixture.state.maxLive}`)
      assert.equal(liveBeforeWindow, SCALE_SESSIONS, 'all sessions are published before the window opens')
      assert.equal(liveInWindow, SCALE_SESSIONS, `the tracked layer count is unchanged inside the window (was ${liveInWindow})`)
      assert.equal(liveAfterClose, SCALE_SESSIONS, 'and unchanged after it closes')
      assert.equal(fixture.state.maxLive, SCALE_SESSIONS, `no duplicate layer was created (max live ${fixture.state.maxLive})`)
      assert.ok(touchesInWindow <= SCALE_TOUCH_LIMIT,
        `${touchesInWindow} touches in the hot window, limit ${SCALE_TOUCH_LIMIT}`)
      assert.ok(registersPerTurn <= REGISTERS_PER_TURN_LIMIT,
        `${registersPerTurn} registers in one macrotask while hot, limit ${REGISTERS_PER_TURN_LIMIT}`)
      assert.equal(fixture.state.duplicateDefinitions, 0, 'no definition registered twice in one macrotask while hot')
      assert.ok(convergenceMs !== undefined && convergenceMs <= CONVERGE_DEADLINE_MS,
        `hot sessions republished within ${CONVERGE_DEADLINE_MS} ms of the window closing (took ${convergenceMs})`)
      assert.equal(crashes.length, 0, 'no unhandled rejection or uncaught exception during the hot scale run')
    } finally {
      fixture.state.open = false
      fixture.restore()
      await shutdown(fixture.ctx)
    }
  }
})

process.off('unhandledRejection', onRejection)
process.off('uncaughtException', onException)
report('shells-append-reentry-stress')
