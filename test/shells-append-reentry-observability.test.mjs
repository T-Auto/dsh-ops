/**
 * #579 acceptance: what a host append window may cost the user.
 *
 * The assertions are user-visible facts, not implementation shapes: how many warnings the log
 * receives, whether every session ends up published, and whether the numbers grow with the session
 * count.
 *
 * **Construction, not wall time.** A machine busy running two hundred other suites must not be able
 * to stretch a window, miss a deadline or earn an extra warning, so this file never asserts on a
 * duration:
 *
 * - the *warning window* is driven by a fake `Date.now`: the clock only moves when this file calls
 *   `advance(ms)`, so "one second" means the same thing on every machine and the throttle counts
 *   the same lines everywhere. Real `setTimeout` keeps running the component's cooldown, because a
 *   cooled retry genuinely has to fire — but nothing here measures how long that took;
 * - a jittery burst is a fixed number of *episodes* — hold the window, create one session, send
 *   one host event, release — with a fixed fake-time step between them, all inside one fake
 *   second;
 * - recovery is "advance the fake clock past the cooldown ladder and wait until the count is
 *   reached", never "within N ms", and no host event is sent after the burst: the cooled pass must
 *   publish on its own timer;
 * - the held-window case advances the fake clock across the ladder in fixed steps instead of
 *   asserting that a real five-second sleep was enough.
 *
 * Only the host's append window is simulated (register / restrict / the returned disposer raise the
 * host's own reentry message while it is open). Everything else is the shipped code: the real
 * `mountSessionBash` / `mountPtc` / `mountNative`, the real tool registry and real scopes.
 *
 * Absolute acceptance bounds: `warns` is the bar the issue states; `touches` is the guard that
 * keeps a storm from returning under another name. Each guard is the work the shape owes, written
 * as a formula — never "fewer than the baseline":
 *
 * - bash `2 × sessions + 8`: one refused pass plus one publication per session;
 * - ptc `3 × sessions`: one refused discovery plus the two resident API registers per session,
 *   the zero-redundancy decomposition the implementation reports. Publishing fewer APIs would
 *   change the visible surface, so this is a floor;
 * - native `6 × sessions`: one refused pass plus the five resident definitions per session.
 *
 * @module dsh-ops/test/shells-append-reentry-observability
 */
import { createScope } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { fileURLToPath } from 'node:url'
import { assert, report, test } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { mountSessionBash } from '../lib/session-shells.js'
import { mountPtc } from '../lib/publication/ptc.js'
import { mountNative } from '../lib/publication/native.js'
import { NATIVE_RESIDENT_RAW } from '../lib/capabilities/profiles.js'

/** The host message the plugin classifies (it lives outside this repository). */
const HOST_REFUSAL = 'session append cannot reenter while another append is being published'
/** The staged worker; the controllers only build definitions, they do not spawn here. */
const WORKER = fileURLToPath(new URL('../runtime/win32-x64/dsh-ops-worker.exe', import.meta.url))
/** A jittery burst: this many sessions, one short window each, all inside one fake second. */
const JITTER_SESSIONS = 20
const EPISODE_STEP_MS = 20
/** Past the longest cooldown step, so one more pass must run without any host event. */
const LADDER_PASS_MS = 2000
/** More than one warning window of quiet: the moment a burst may be called over. */
const QUIET_WINDOW_MS = 1200
/** A held window: five fake seconds across the ladder, in fixed steps. */
const HELD_STEPS = 5
const HELD_STEP_MS = 1000
/** Yield so the component's real cooldown timer can fire. A yield, never an assertion. */
const YIELD_MS = 15
const YIELD_TURNS = 400
/** Absolute acceptance bounds; see the module comment for each formula. */
const BOUNDS = Object.freeze({
  bash: Object.freeze({ warns: 2, touches: 2 * JITTER_SESSIONS + 8 }),
  ptc: Object.freeze({ warns: 2, touches: 3 * JITTER_SESSIONS }),
  native: Object.freeze({ warns: 2, touches: 6 * JITTER_SESSIONS }),
})
/** A held window may not cost more than the cooldown steps plus the initial attempts. */
const HELD_TOUCHES = 12

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Replace only the wall clock the throttle reads. Timers stay real: the component's cooldown must
 * actually fire, and no assertion here looks at how long that took.
 * @param {number} [start] - the fake wall clock in Unix milliseconds.
 * @returns {{now: () => number, advance: (ms: number) => void, uninstall: () => void}} the clock.
 */
function installFakeNow(start = 1_700_000_000_000) {
  const realNow = Date.now
  let now = start
  Date.now = () => now
  return {
    now: () => now,
    advance: ms => { now += ms },
    uninstall: () => { Date.now = realNow },
  }
}

/**
 * Yield event-loop turns until the predicate holds. There is no deadline: the call succeeds or it
 * exhausts a fixed number of turns, which is a construction bound rather than a stopwatch.
 * @param {() => boolean} predicate - the condition.
 * @param {string} what - what is awaited, for the failure message.
 * @returns {Promise<boolean>} whether it held.
 */
async function until(predicate, what) {
  for (let turn = 0; turn < YIELD_TURNS; turn += 1) {
    if (predicate()) return true
    await sleep(YIELD_MS)
  }
  if (predicate()) return true
  throw new Error(`gave up after ${YIELD_TURNS} turns waiting for ${what}`)
}

/**
 * The largest count of folded refusals any warning states, or 0 when none does.
 *
 * Aggregation is only acceptable if the number it hides is still recoverable from the log: the
 * operator must be able to read "N refusals happened" even when one line was printed. The match
 * accepts the shapes a summary takes — "12 suppressed", "deferred 12 times", "12 earlier
 * refusal(s) were not reported" — and ignores a bare number.
 * @param {readonly string[]} lines - every warning captured for the scenario.
 * @returns {number} the largest stated suppression count.
 */
function statedSuppressions(lines) {
  const numbers = [...lines.join('\n').matchAll(/(\d+)\s+(?:[A-Za-z-]+\s+){0,2}(?:suppressed|deferred|refusals?|occurrences?|times|more|other)/gi)]
    .map(match => Number(match[1]))
    .filter(count => Number.isFinite(count))
  return Math.max(0, ...numbers)
}

/**
 * The acceptance fact aggregation must not lose: quiet must not mean silent.
 * @param {object} row - one measurement row (needs `path`, `refusals`, `warns`, `lines`).
 */
function assertCountSurvivesAggregation(row) {
  if (row.refusals <= row.warns) return
  const stated = statedSuppressions(row.lines)
  assert.ok(stated >= row.refusals - row.warns,
    `${row.path}: ${row.refusals} refusals were folded into ${row.warns} warning(s), so the log must still state the count `
    + `(stated ${stated}, need at least ${row.refusals - row.warns}): ${JSON.stringify(row.lines)}`)
}

/**
 * Boot the real host, count registry traffic and mount one publication path on it.
 * @param {'bash'|'ptc'|'native'} kind - which path to mount.
 * @returns {Promise<object>} the fixture surface.
 */
async function setup(kind) {
  const { ctx, tools } = await bootHost()
  const warns = []
  ctx.logger.warn = (...parts) => { warns.push(parts.join(' ')) }
  await ctx.plugin(Subprocess)
  const agents = []
  ctx.provide('agents', { list: () => agents })
  ctx.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: 'danger-full-access', workspaceRoot: process.env.DSH_HOME, sessionId: session?.id }) })
  ctx.provide('ptcRuntime', { language: 'typescript' })
  const state = { open: false, register: 0, restrict: 0, dispose: 0, refusals: 0 }
  const originalRegister = tools.register
  tools.register = function windowedRegister(definition) {
    state.register += 1
    if (state.open) { state.refusals += 1; throw new Error(HOST_REFUSAL) }
    const dispose = originalRegister.call(this, definition)
    return () => { state.dispose += 1; if (state.open) { state.refusals += 1; throw new Error(HOST_REFUSAL) }; dispose() }
  }
  if (typeof tools.restrict === 'function') {
    const originalRestrict = tools.restrict
    tools.restrict = function windowedRestrict(patch) {
      state.restrict += 1
      if (state.open) { state.refusals += 1; throw new Error(HOST_REFUSAL) }
      return originalRestrict.call(this, patch)
    }
  }
  let notify
  if (kind === 'bash') {
    const gate = { allows: () => true, watch(listener) { notify = listener; return () => { notify = undefined } } }
    await ctx.plugin({ inject: ['tools'], apply(inner) {
      mountSessionBash(inner, { publishBashTool: true }, { bash: { available: true, file: process.execPath, source: 'explicit', detail: 'observability' } }, gate)
    } })
  } else if (kind === 'ptc') {
    mountPtc(ctx, { binaryPath: WORKER, required: true, allowedTools: [], alwaysLoaded: [] }, { allows: () => true, dynamic: false })
  } else {
    mountNative(ctx, { binaryPath: WORKER, required: true, promptPolicy: true, extraGuidance: '', denyCredentialReads: false }, {
      id: 'mode-standard', tools: NATIVE_RESIDENT_RAW, section: 'mode-standard', gate: { allows: () => true },
    })
  }
  let serial = 0
  const mint = async () => {
    const id = `${kind}-${++serial}`
    const agent = { id, session: { id, mode: 'danger-full-access', header: { cwd: process.env.DSH_HOME }, append() {}, read() { return [] } } }
    agent.ctx = createScope(ctx, agent).ctx
    // Presentation is per scope: it is what makes each controller consider this agent.
    await agent.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.presentAs(kind === 'ptc' ? 'ptc' : 'native') } })
    agents.push(agent)
    await ctx.serial('agent/created', { agent })
    return agent
  }
  const published = agent => tools.get('ops_bash', agent) !== undefined || tools.schemas(agent).some(schema => schema.name.startsWith('ops_'))
  const publishedCount = () => agents.filter(published).length
  const reset = () => { state.register = 0; state.restrict = 0; state.dispose = 0; state.refusals = 0; warns.length = 0 }
  const touches = () => state.register + state.restrict + state.dispose
  const drive = async agent => {
    await ctx.serial('session/event', agent.session, { type: 'agent-preset/selected' })
    notify?.()
  }
  return { ctx, tools, warns, state, agents, mint, published, publishedCount, reset, touches, drive }
}

/**
 * Run one jittery burst: a fixed number of episodes inside one fake second, then close the burst
 * and let the cooled pass publish everyone with **no further host event**.
 * @param {object} fixture - the fixture.
 * @returns {Promise<object>} the measurement row.
 */
async function jitter(fixture) {
  const clock = installFakeNow()
  try {
    fixture.reset()
    for (let index = 0; index < JITTER_SESSIONS; index += 1) {
      // The host is publishing this new session's initial append: the window is held for the episode.
      // It stays held until the path actually attempts a write, so the episode is one refusal on
      // every path (native publishes on a later turn than bash does) and never zero.
      fixture.state.open = true
      const before = fixture.state.refusals
      await fixture.mint()
      for (let turn = 0; turn < 60 && fixture.state.refusals === before; turn += 1) await sleep(1)
      fixture.state.open = false
      // Step past the first cooldown step on the reported clock, then yield the real turn the
      // component's timer needs. The yield is a yield: no assertion measures it.
      clock.advance(EPISODE_STEP_MS)
      await sleep(YIELD_MS * 2)
    }
    // The burst is over: these are the lines the operator sees while it is happening.
    const burst = { touches: fixture.touches(), warns: fixture.warns.length, refusals: fixture.state.refusals }
    const linesAtBurst = fixture.warns.slice()
    // The host keeps working. Nothing is published while the burst is still recent, so the cooled
    // pass must publish everyone by itself; then the host goes quiet for more than one warning
    // window and runs one ordinary pass — the only moment the closing summary may state the whole
    // burst, because a burst can be called over only once it has been quiet for a window.
    clock.advance(LADDER_PASS_MS)
    await until(() => fixture.publishedCount() === fixture.agents.length, 'every session to be published without a host event')
    const publishedWithoutEvent = fixture.publishedCount()
    // The host keeps working. A burst can be called over only after it has been quiet for a whole
    // window, so the fixture says so the way reality does: a quiet window, then one ordinary pass.
    // That pass is what writes the closing summary.
    clock.advance(QUIET_WINDOW_MS)
    await fixture.drive(fixture.agents[0])
    await until(() => fixture.warns.some(line => /recovered after/i.test(line)), 'the closing summary to state the burst')
    await sleep(YIELD_MS * 2)
    const published = fixture.publishedCount()
    return {
      sessions: fixture.agents.length,
      ...burst,
      lines: fixture.warns.slice(),
      linesAtBurst,
      recoveredWithoutEvent: publishedWithoutEvent === fixture.agents.length,
      published: `${published}/${fixture.agents.length}`,
    }
  } finally { clock.uninstall() }
}

const rows = []
const emitRow = row => { rows.push(row); console.log(`  measured ${JSON.stringify(row)}`) }

await test('a jittery append window is reported at most twice, with a fact, and loses no session', async () => {
  const fixture = await setup('bash')
  try {
    const row = await jitter(fixture)
    const reported = { ...row, warns: row.lines.length }
    emitRow({ path: 'bash', ...row })
    assert.ok(reported.warns <= BOUNDS.bash.warns,
      `the burst costs at most ${BOUNDS.bash.warns} warnings, closing summary included: got ${reported.warns} (${JSON.stringify(row)})`)
    assert.ok(row.warns >= 1, 'the deferral is not silent')
    assert.ok(row.linesAtBurst.some(line => /(coold?|deferr?|retry|retrying)/i.test(line)),
      `a warning still states what happens: ${JSON.stringify(row.linesAtBurst)}`)
    assert.equal(row.published, `${row.sessions}/${row.sessions}`, `no session is lost: ${JSON.stringify(row)}`)
    assert.equal(row.touches <= BOUNDS.bash.touches, true, `the burst stays inside the absolute bound: ${JSON.stringify(row)}`)
    assertCountSurvivesAggregation({ path: 'bash', ...reported })
  } finally { await shutdown(fixture.ctx) }
})

await test('a long held append window stays bounded and still recovers', async () => {
  const fixture = await setup('bash')
  const clock = installFakeNow()
  try {
    fixture.reset()
    fixture.state.open = true
    for (let index = 0; index < 3; index += 1) await fixture.mint()
    for (let step = 0; step < HELD_STEPS; step += 1) {
      await sleep(YIELD_MS)
      clock.advance(HELD_STEP_MS)
    }
    const held = { touches: fixture.touches(), warns: fixture.warns.length, publishedDuring: fixture.publishedCount() }
    fixture.state.open = false
    clock.advance(LADDER_PASS_MS)
    await until(() => fixture.publishedCount() === fixture.agents.length, 'every session to be published after the held window')
    const row = {
      path: 'bash', sessions: fixture.agents.length, heldMs: HELD_STEPS * HELD_STEP_MS, ...held,
      recoveredWithoutEvent: true,
      published: `${fixture.publishedCount()}/${fixture.agents.length}`,
    }
    emitRow(row)
    assert.ok(row.touches <= HELD_TOUCHES, `a held window costs at most ${HELD_TOUCHES} touches: ${JSON.stringify(row)}`)
    assert.ok(row.warns <= BOUNDS.bash.warns, `and at most ${BOUNDS.bash.warns} warnings: ${JSON.stringify(row)}`)
    assert.equal(row.publishedDuring, 0, `nothing is published while the lock is held: ${JSON.stringify(row)}`)
    assert.equal(row.published, '3/3', `all three sessions are published (no permanent cooldown): ${JSON.stringify(row)}`)
  } finally { clock.uninstall(); await shutdown(fixture.ctx) }
})

await test('the sibling publication paths stay inside the same absolute bounds', async () => {
  const failures = []
  for (const kind of ['ptc', 'native']) {
    const fixture = await setup(kind)
    try {
      const row = await jitter(fixture)
      const reported = { ...row, warns: row.lines.length }
      emitRow({ path: kind, ...row })
      if (reported.warns > BOUNDS[kind].warns) failures.push(`${kind}: ${reported.warns} warnings > ${BOUNDS[kind].warns} (${JSON.stringify(row)})`)
      if (row.touches > BOUNDS[kind].touches) failures.push(`${kind}: ${row.touches} registry touches > ${BOUNDS[kind].touches} (${JSON.stringify(row)})`)
      if (row.published !== `${row.sessions}/${row.sessions}`) failures.push(`${kind}: lost sessions ${row.published} (${JSON.stringify(row)})`)
      if (!row.recoveredWithoutEvent) failures.push(`${kind}: needed another host event to recover (${JSON.stringify(row)})`)
      try { assertCountSurvivesAggregation({ path: kind, ...reported }) } catch (error) { failures.push(error.message) }
    } finally { await shutdown(fixture.ctx) }
  }
  assert.deepEqual(failures, [], `sibling publication paths:\n${failures.join('\n')}`)
})

await test('the measured table is quoted in the verification report', async () => {
  assert.ok(rows.length >= 4, `one row per path and shape: ${JSON.stringify(rows)}`)
  const paths = new Set(rows.map(row => row.path))
  for (const path of ['bash', 'ptc', 'native']) assert.ok(paths.has(path), `a row exists for ${path}`)
  console.log(`  table ${JSON.stringify(rows)}`)
})

report('shells-append-reentry-observability')
