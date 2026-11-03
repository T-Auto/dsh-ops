/**
 * #579 acceptance: what a host append window may cost the user.
 *
 * The cooldown suite proves the scheduler's shape; `stress` proves a held window stays bounded.
 * This suite states the three acceptance facts instead, on all three publication paths, and
 * asserts only user-visible results — how many warnings the log receives, whether every session
 * ends up published, and whether the numbers grow with the session count.
 *
 * Only the host's append window is simulated (`register` / `restrict` / the returned disposer
 * raise the host's own reentry message while it is open). Everything else is the shipped code:
 * `mountSessionBash`, `mountPtc`, `mountNative`, the real tool registry and real scopes.
 *
 * Absolute bounds, not "smaller than before": a bound that follows a regression would keep
 * passing. They are guards chosen from the measured fallback behaviour (a refused pass touches the
 * registry once per cooldown step, so one second of a held window cannot exceed a dozen touches),
 * and they leave room for the aggregation work; tighten them once the shared primitive lands.
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
/** A jittery window: one short lock per new session, the shape the issue reports. */
const JITTER_SESSIONS = 20
const JITTER_SPAN_MS = 1000
const JITTER_WINDOW_MS = 5
/**
 * Absolute acceptance bounds. `warns` is the acceptance bar the issue states; `touches` is the
 * guard that keeps a storm from returning under another name. The jitter shape cannot be cheaper
 * than the work each session owes, so each guard is that work as a formula — absolute, never
 * "fewer than the baseline".
 *
 * - bash `2 × sessions + 8`: one refused pass plus one publication per session.
 * - ptc `3 × sessions`: one refused discovery plus the two resident API registers per session —
 *   the zero-redundancy decomposition `{register: 60, restrict: 0, dispose: 0}` at 20 sessions.
 *   Compressing it further would mean publishing fewer APIs, which changes the visible surface,
 *   so this is the floor, not a relaxed bound.
 * - native `2 × sessions`: one refused pass plus one publication per session.
 */
const BOUNDS = Object.freeze({
  bash: Object.freeze({ warns: 2, touches: 2 * JITTER_SESSIONS + 8 }),
  ptc: Object.freeze({ warns: 2, touches: 3 * JITTER_SESSIONS }),
  // Native publishes five resident definitions per session, so its floor is (5 + 1) x sessions, the
  // same arithmetic that gives bash (1 + 1) and ptc (2 + 1). Measured after the fix: 120 touches for
  // 20 sessions = 20 refused discoveries + 100 successful registrations; the bound is the work owed,
  // not the measured value.
  native: Object.freeze({ warns: 2, touches: 6 * JITTER_SESSIONS }),
  
})
/** Every session must be published again within this budget after a window closes. */
const RECOVERY_MS = 1500
const EVENT_MS = 10
/** A lock that never releases long enough to prove nothing wedges. */
const HELD_LOCK_MS = 5000

const flush = () => new Promise(resolve => setImmediate(resolve))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs, what) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (predicate()) return Date.now() - (until - timeoutMs)
    await sleep(10)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
}

/**
 * Whether a warning still tells the operator what is happening. The acceptance asks for either a
 * suppressed-count or a cooling/deferral word — silence is the only forbidden outcome.
 * @param {string} line - one captured `logger.warn` line.
 * @returns {boolean} whether the line carries a fact.
 */
function informative(line) {
  if (/(coold?|deferr?|retry|retrying)/i.test(line)) return true
  return /\d/.test(line) && /(suppress|omit|coalesc|aggregat|more|other)/i.test(line)
}

/**
 * The largest count of folded refusals any warning states, or 0 when none does.
 *
 * Aggregation is only acceptable if the number it hides is still recoverable from the log: the
 * operator must be able to read "N refusals happened" even when only one line was printed. The
 * match accepts the shapes a summary can take — "12 suppressed", "deferred 12 times",
 * "12 refusals folded" — and ignores bare numbers (a latency or a timeout is not a count).
 * @param {readonly string[]} lines - every warning captured for the window.
 * @returns {number} the largest stated suppression count.
 */
function statedSuppressions(lines) {
  // Accept the shapes a summary takes: "12 suppressed", "deferred 12 times", "12 earlier
  // refusal(s) were not reported", "12 refusals folded". An adjective may sit between the number
  // and its noun; a bare number (a latency, a budget) is never a count.
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
 * Boot the real host, count registry traffic, and mount one publication path on it.
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
    await flush()
    return agent
  }
  const published = agent => tools.get('ops_bash', agent) !== undefined || tools.schemas(agent).some(schema => schema.name.startsWith('ops_'))
  const publishedCount = () => agents.filter(published).length
  const allPublished = () => agents.length > 0 && agents.every(published)
  const reset = () => { state.register = 0; state.restrict = 0; state.dispose = 0; state.refusals = 0; warns.length = 0 }
  const touches = () => state.register + state.restrict + state.dispose
  const drive = async agent => { await ctx.serial('session/event', agent.session, { type: 'agent-preset/selected' }); if (notify) notify() }
  return { ctx, tools, warns, state, agents, mint, published, publishedCount, allPublished, reset, touches, drive, notify: () => notify?.() }
}

/**
 * One jittery window per session across a fixed span, then measure recovery.
 * @param {object} fixture - the fixture.
 * @returns {Promise<object>} the measurement row.
 */
async function jitter(fixture) {
  fixture.reset()
  const started = Date.now()
  const interval = Math.round(JITTER_SPAN_MS / JITTER_SESSIONS)
  for (let index = 0; index < JITTER_SESSIONS; index += 1) {
    // The host is publishing the new session's initial append: the lock is held for a few
    // milliseconds, so the publication this creation triggers is refused.
    fixture.state.open = true
    const agent = await fixture.mint()
    await fixture.drive(agent)
    await sleep(JITTER_WINDOW_MS)
    fixture.state.open = false
    await sleep(Math.max(0, interval - JITTER_WINDOW_MS))
  }
  // The burst is over: the counters are read here, so recovery traffic never inflates them.
  while (Date.now() - started < JITTER_SPAN_MS) await sleep(10)
  fixture.state.open = false
  const storm = { touches: fixture.touches(), warns: fixture.warns.length }
  const released = Date.now()
  // The host stops talking: no further event is sent. The cooled pass must publish everyone on its
  // own timer (a path that needs another event wakes up only when the host happens to speak again).
  let withoutEvent = true
  let recovered
  try { recovered = await waitFor(fixture.allPublished, RECOVERY_MS, 'every session to be published without another host event') }
  catch { recovered = undefined; withoutEvent = false }
  // Only then, and only to keep measuring the rest of the row, give the path one ordinary event.
  if (!withoutEvent) {
    for (const agent of fixture.agents) await fixture.drive(agent)
    try { recovered = await waitFor(fixture.allPublished, RECOVERY_MS, 'every session to be published after one event') } catch { recovered = undefined }
  }
  // Let a summary line that the recovery pass writes land before the log is read: the acceptance is
  // about what the operator ends up with, not about the instant the last layer appears.
  await sleep(60)
  return {
    sessions: fixture.agents.length,
    ...storm,
    refusals: fixture.state.refusals,
    lines: fixture.warns.slice(),
    recoveredWithoutEvent: withoutEvent,
    recoveredMs: recovered === undefined ? null : Date.now() - released,
    published: `${fixture.publishedCount()}/${fixture.agents.length}`,
    sample: fixture.warns[0] ?? null,
  }
}

const rows = []
const emitRow = row => { rows.push(row); console.log(`  measured ${JSON.stringify(row)}`) }

await test('a jittery append window is reported at most twice, with a fact, and loses no session', async () => {
  const fixture = await setup('bash')
  try {
    const row = await jitter(fixture)
    emitRow({ path: 'bash', ...row })
    assert.ok(row.warns <= BOUNDS.bash.warns,
      `the log receives at most ${BOUNDS.bash.warns} warnings for ${row.sessions} sessions: got ${row.warns} (${JSON.stringify(row)})`)
    assert.ok(row.warns >= 1, 'the deferral is not silent')
    assert.ok(fixture.warns.some(informative),
      `a warning still states what happens (cooling, deferral or a suppressed count): ${JSON.stringify(fixture.warns)}`)
    assert.equal(row.published, `${row.sessions}/${row.sessions}`, `no session is lost: ${JSON.stringify(row)}`)
    assert.ok(row.recoveredWithoutEvent, `the cooled pass publishes on its own timer, with no further host event: ${JSON.stringify(row)}`)
    assert.ok(row.recoveredMs !== null && row.recoveredMs <= RECOVERY_MS,
      `every session is published within ${RECOVERY_MS} ms: ${JSON.stringify(row)}`)
    // The one fact aggregation must never trade away: a quiet log still says how many refusals happened.
    assertCountSurvivesAggregation({ path: 'bash', ...row })
  } finally { fixture.state.open = false; await shutdown(fixture.ctx) }
})

await test('a five second held append window stays bounded and still recovers', async () => {
  const fixture = await setup('bash')
  try {
    fixture.reset()
    fixture.state.open = true
    for (let index = 0; index < 3; index += 1) await fixture.mint()
    const started = Date.now()
    while (Date.now() - started < HELD_LOCK_MS) {
      for (const agent of fixture.agents) await fixture.drive(agent)
      await sleep(EVENT_MS)
    }
    const held = { touches: fixture.touches(), warns: fixture.warns.length, publishedDuring: fixture.publishedCount() }
    fixture.state.open = false
    const released = Date.now()
    let recovered
    try { recovered = await waitFor(fixture.allPublished, RECOVERY_MS, 'every session to be published after a five second lock') } catch { recovered = undefined }
    const row = { path: 'bash', sessions: fixture.agents.length, heldMs: HELD_LOCK_MS, ...held, recoveredMs: recovered === undefined ? null : Date.now() - released, published: `${fixture.publishedCount()}/${fixture.agents.length}` }
    emitRow(row)
    assert.ok(row.touches <= BOUNDS.bash.touches, `a ${HELD_LOCK_MS} ms held window costs at most ${BOUNDS.bash.touches} touches: ${JSON.stringify(row)}`)
    assert.ok(row.warns <= BOUNDS.bash.warns, `and at most ${BOUNDS.bash.warns} warnings: ${JSON.stringify(row)}`)
    assert.equal(row.publishedDuring, 0, `nothing is published while the lock is held: ${JSON.stringify(row)}`)
    assert.equal(row.published, '3/3', `the release republishes every session (no permanent cooldown): ${JSON.stringify(row)}`)
  } finally { fixture.state.open = false; await shutdown(fixture.ctx) }
})

await test('the sibling publication paths stay inside the same absolute bounds', async () => {
  const failures = []
  for (const kind of ['ptc', 'native']) {
    const fixture = await setup(kind)
    try {
      const row = await jitter(fixture)
      emitRow({ path: kind, ...row })
      if (row.warns > BOUNDS[kind].warns) failures.push(`${kind}: ${row.warns} warnings > ${BOUNDS[kind].warns} (${JSON.stringify(row)})`)
      if (row.touches > BOUNDS[kind].touches) failures.push(`${kind}: ${row.touches} registry touches > ${BOUNDS[kind].touches} (${JSON.stringify(row)})`)
      if (row.published !== `${row.sessions}/${row.sessions}`) failures.push(`${kind}: lost sessions ${row.published} (${JSON.stringify(row)})`)
      if (!row.recoveredWithoutEvent) failures.push(`${kind}: needed another host event to recover (${JSON.stringify(row)})`)
      if (row.recoveredMs === null || row.recoveredMs > RECOVERY_MS) failures.push(`${kind}: recovery ${row.recoveredMs} ms (${JSON.stringify(row)})`)
      // Same invariant on every path: folded refusals stay countable in the log.
      try { assertCountSurvivesAggregation({ path: kind, ...row }) } catch (error) { failures.push(error.message) }
    } finally { fixture.state.open = false; await shutdown(fixture.ctx) }
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
