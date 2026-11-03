/**
 * #579 Native follow-up: a publication refused inside the host's append window must still
 * happen once the window closes.
 *
 * The sibling suites cover the Bash/`session-shells` controller and the shared cooling module.
 * This one drives the REAL Native publication controller (`publication/native`) on a real Cordis
 * host + real tool registry + real prompt assembly, with the registry stubbed to throw the
 * host's own reentry message while a window is open. It pins the three properties of the fix:
 *
 *   1. a refused session is not left without tooling — the cooldown pass publishes it;
 *   2. the retry cost is one registry touch per cooldown step, independent of the session count
 *      (the refusal is process-global, so a locked window must not multiply by sessions);
 *   3. the window is reported once through the shared aggregator, not once per attempt.
 *
 * An unclassified failure and a hostile thrown value keep their old, single-warning behaviour:
 * only the append window is transient by construction.
 *
 * @module dsh-ops/test/native-append-reentry
 */
import path from 'node:path'
import fs from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import { assert, report, skipSuite, test } from './lib/harness.mjs'
import { PACKAGE_ROOT } from './lib/harness.mjs'

const WORKER = path.join(PACKAGE_ROOT, 'runtime', 'win32-x64', 'dsh-ops-worker.exe')
const HOST_REFUSAL = 'session append cannot reenter while another append is being published'
const HOME = process.env.DSH_HOME
const tick = ms => new Promise(resolve => setTimeout(resolve, ms))
const flush = () => new Promise(resolve => setImmediate(resolve))

if (!fs.existsSync(WORKER)) skipSuite('native-append-reentry', `no staged worker at ${path.relative(PACKAGE_ROOT, WORKER)}; run npm run build:ptc`)

const load = rel => import(new URL(`file:///${PACKAGE_ROOT.replaceAll('\\', '/')}/lib/${rel}`).href)
const { mountNative } = await load('publication/native.js')
const { NATIVE_RESIDENT_RAW } = await load('capabilities/profiles.js')

/**
 * Boot one real host with the Native controller mounted and the registry instrumented.
 * @param {object} [options] - fixture switches.
 * @param {boolean} [options.jitter] - refuse only some attempts (a jittery window).
 * @param {Error|object|string} [options.failure] - what a refused register throws.
 * @returns {Promise<object>} the fixture surface.
 */
async function boot({ jitter = false, failure = new Error(HOST_REFUSAL) } = {}) {
  const ctx = new Context()
  ctx.logger.level = 0
  const warns = []
  ctx.logger.warn = (...parts) => { warns.push(parts.join(' ')) }
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  const tools = ctx.get('tools')
  const agents = []
  ctx.provide('agents', { list: () => agents })
  await ctx.plugin(Subprocess)
  await ctx.plugin(Sandbox)
  await ctx.plugin(inner => {
    inner.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: 'workspace-write', workspaceRoot: HOME, sessionId: session?.id }) })
    inner.provide('ptcRuntime', { language: 'typescript' })
  })
  const state = { open: false, attempts: 0, register: 0, dispose: 0, successWhileOpen: 0 }
  const originalRegister = tools.register
  tools.register = function counted(definition) {
    state.register += 1
    if (state.open) {
      state.attempts += 1
      const refused = jitter ? state.attempts % 5 < 2 : true
      if (refused) throw failure
      state.successWhileOpen += 1
    }
    const dispose = originalRegister.call(this, definition)
    return () => { state.dispose += 1; dispose() }
  }
  mountNative(ctx, { binaryPath: WORKER, required: true, promptPolicy: true, extraGuidance: '', denyCredentialReads: false }, {
    id: 'mode-standard', tools: NATIVE_RESIDENT_RAW, section: 'mode-standard', gate: { allows: () => true },
  })
  let serial = 0
  const names = agent => tools.schemas(agent).map(tool => tool.name).filter(name => name.startsWith('ops_'))
  const mint = async () => {
    const id = `native-edge-${++serial}`
    const agent = { id, session: { id, mode: 'workspace-write', header: { cwd: HOME }, append() {}, read() { return [] } } }
    agent.ctx = createScope(ctx, agent).ctx
    await agent.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.presentAs('native') } })
    agents.push(agent)
    await ctx.serial('agent/created', { agent })
    return agent
  }
  /** Drive host events for `ms` and count them. */
  const events = async (ms) => {
    const started = Date.now()
    let count = 0
    while (Date.now() < started + ms) {
      for (const agent of agents) { await ctx.serial('session/event', agent.session, { type: 'agent-preset/selected' }); count += 1 }
      await tick(10)
    }
    return count
  }
  /** Close the window, then drive ordinary events until every session is published. */
  const recover = async (limitMs = 4000) => {
    state.open = false
    const closedAt = Date.now()
    for (const agent of agents) await ctx.serial('session/event', agent.session, { type: 'agent-preset/selected' })
    for (;;) {
      if (agents.every(agent => names(agent).length > 0)) return Date.now() - closedAt
      if (Date.now() - closedAt > limitMs) return null
      await ctx.serial('session/event', agents[0].session, { type: 'agent-preset/selected' })
      await tick(5)
    }
  }
  return { ctx, tools, agents, state, warns, mint, events, recover, names,
    published: () => agents.map(agent => names(agent).length),
    deferralWarns: () => warns.filter(line => /publication was deferred/.test(line)).length,
    recoveredWarns: () => warns.filter(line => /publication recovered after/.test(line)).length,
    failureWarns: () => warns.filter(line => /publication failed/.test(line)).length,
    dispose: async () => { await ctx.fiber.dispose() } }
}

await test('a session refused inside the host append window is published after the window closes', async () => {
  const fixture = await boot()
  try {
    // Cold start inside the window: the three sessions exist before their tools can register.
    fixture.state.open = true
    for (let index = 0; index < 3; index += 1) await fixture.mint()
    await flush()
    const events = await fixture.events(600)
    assert.ok(events > 0, 'the window saw host events')
    assert.deepEqual(fixture.published(), [0, 0, 0], 'nothing can be published while the host refuses')
    const recoveryMs = await fixture.recover()
    assert.notEqual(recoveryMs, null,
      `every session must be published after the window closes (measured ${JSON.stringify(fixture.published())})`)
    assert.deepEqual(fixture.published(), [5, 5, 5], 'each session gets its five resident Native tools')
    assert.equal(fixture.deferralWarns(), 1, 'the window is reported once, through the shared aggregator')
    assert.equal(fixture.failureWarns(), 0, 'a classified refusal is not a publication failure')
    assert.equal(fixture.recoveredWarns(), 1, 'the recovery names how many refusals the window suppressed')
    assert.ok(recoveryMs < 3000, `recovery stays bounded by the ladder (measured ${recoveryMs} ms)`)
  } finally { await fixture.dispose() }
})

await test('the retry costs one touch per cooldown step, independent of the session count', async () => {
  const measure = async count => {
    const fixture = await boot()
    try {
      fixture.state.open = true
      for (let index = 0; index < count; index += 1) await fixture.mint()
      await flush()
      await fixture.events(1000)
      const during = { touches: fixture.state.register + fixture.state.dispose, warns: fixture.warns.length }
      const recoveryMs = await fixture.recover()
      return { during, recoveryMs, published: fixture.published() }
    } finally { await fixture.dispose() }
  }
  const three = await measure(3)
  const six = await measure(6)
  // The ladder is 25/100/400/1000 ms: at most one touch per step inside a one-second window.
  assert.ok(three.during.touches <= 6, `three sessions: bounded touches (${JSON.stringify(three.during)})`)
  assert.ok(six.during.touches <= 6, `six sessions: bounded touches (${JSON.stringify(six.during)})`)
  assert.ok(Math.abs(three.during.touches - six.during.touches) <= 1,
    `touch count must not scale with sessions: ${three.during.touches} vs ${six.during.touches}`)
  assert.ok(three.during.warns <= 1 && six.during.warns <= 1, 'one warning per window, not one per attempt')
  assert.deepEqual(three.published, [5, 5, 5], 'three sessions all recover')
  assert.deepEqual(six.published, [5, 5, 5, 5, 5, 5], 'six sessions all recover')
  assert.notEqual(three.recoveryMs, null)
  assert.notEqual(six.recoveryMs, null)
})

await test('an unclassified publication failure keeps its single warning and is not retried', async () => {
  const fixture = await boot({ failure: new Error('the native worker could not start') })
  try {
    fixture.state.open = true
    for (let index = 0; index < 2; index += 1) await fixture.mint()
    await flush()
    await fixture.events(400)
    const touches = fixture.state.register
    // Each session reports its own real failure once; what must never happen is a retry loop.
    assert.equal(fixture.failureWarns(), fixture.agents.length, 'one line per failed session, not per attempt')
    assert.equal(fixture.deferralWarns(), 0, 'a real failure is not treated as an append-window refusal')
    await fixture.recover(600)
    assert.deepEqual(fixture.published(), [0, 0], 'no retry loop for a failure that is not the window')
    assert.ok(fixture.state.register <= touches + 1, `no extra attempts after the window (${fixture.state.register} vs ${touches})`)
  } finally { await fixture.dispose() }
})

await test('a hostile thrown value is reported without raising a second exception', async () => {
  const hostile = { get message() { throw new TypeError('the message getter itself threw') } }
  const fixture = await boot({ failure: hostile })
  try {
    fixture.state.open = true
    await fixture.mint()
    await flush()
    await fixture.events(300)
    assert.equal(fixture.warns.filter(line => /publication failed/.test(line)).length, 1, 'the failure is reported once')
    assert.equal(fixture.deferralWarns(), 0, 'an unreadable message is not the append window')
    assert.ok(fixture.warns.some(line => /error message unavailable/.test(line)),
      'the shared classifier reports the unreadable message instead of throwing')
    assert.ok(fixture.warns.every(line => !/the message getter itself threw/.test(line)), 'no second exception leaks into the log')
  } finally { await fixture.dispose() }
})

report('native-append-reentry')
