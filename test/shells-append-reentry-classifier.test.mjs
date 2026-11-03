/**
 * #579 follow-up: the reentry classifier must be total.
 *
 * A host error whose `message` is a throwing getter used to raise a second exception from inside
 * the classifier's own catch block: the pass aborted before arming the cooldown and the TypeError
 * escaped the `setImmediate` callback as an uncaught exception. The classifier must instead
 * degrade to the unclassified path — one warning, no cooldown — and never throw outward.
 *
 * @module dsh-ops/test/shells-append-reentry-classifier
 */
import { createScope } from '@deepseek-ai/dsh-scope'
import { assert, report, test, waitFor } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { mountSessionBash } from '../lib/session-shells.js'

/** The host message this package classifies (it lives outside this repository). */
const HOST_REFUSAL = 'session append cannot reenter while another append is being published'
const flush = () => new Promise(resolve => setImmediate(resolve))
const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * A host whose only bash dependency is the real registry, with a controllable register failure.
 * @returns {Promise<object>} the fixture surface.
 */
async function setup() {
  const { ctx, tools } = await bootHost()
  const warns = []
  ctx.logger.warn = (...parts) => { warns.push(parts.join(' ')) }
  await ctx.plugin(inner => {
    inner.provide('subprocess', { spawn() { throw new Error('publication test must not execute') } })
    inner.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: process.env.DSH_HOME }) })
  })
  const state = {
    open: false,
    register: 0,
    throwFactory: () => new Error(HOST_REFUSAL),
  }
  const hadOwn = Object.hasOwn(tools, 'register')
  const original = tools.register
  tools.register = function counted(definition) {
    state.register += 1
    if (state.open) throw state.throwFactory()
    return original.call(this, definition)
  }
  let notify
  const gate = { allows: () => true, watch(listener) { notify = listener; return () => { notify = undefined } } }
  await ctx.plugin({ inject: ['tools'], apply(inner) {
    mountSessionBash(inner, { publishBashTool: true }, { bash: { available: true, file: process.execPath, source: 'explicit', detail: 'classifier only' } }, gate)
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
  return {
    ctx, tools, warns, state, agents, mint,
    notify: () => { notify?.() },
    published: id => tools.get('ops_bash', agents.get(id)) !== undefined,
    reset() { state.register = 0; warns.length = 0 },
    failureWarns: () => warns.filter(line => /bash publication failed/.test(line)),
    deferralWarns: () => warns.filter(line => /publishing an append/.test(line)),
    restore() { if (hadOwn) tools.register = original; else delete tools.register },
  }
}

/** Run `body` while recording any uncaught exception instead of letting it kill the suite. */
async function whileCapturingUncaught(body) {
  const escaped = []
  const onUncaught = error => { escaped.push(error) }
  process.on('uncaughtException', onUncaught)
  try { await body() } finally { process.off('uncaughtException', onUncaught) }
  return escaped
}

await test('a throwing message getter degrades to the unclassified path and warns once', async () => {
  const fixture = await setup()
  const { ctx, state, mint, notify, reset } = fixture
  try {
    reset()
    // The very first publication meets the window: no previous definition, so the generic path
    // warns once and returns — the shape a classifying exception used to replace with a crash.
    state.throwFactory = () => ({ get message() { throw new TypeError('the message getter itself threw') } })
    state.open = true
    const escaped = await whileCapturingUncaught(async () => {
      await mint('g1')
      await tick(20)
    })
    assert.deepEqual(escaped, [], 'the classifier must not raise its own exception out of the pass')
    assert.equal(state.register, 1, 'the refused register was attempted exactly once')
    assert.equal(fixture.failureWarns().length, 1, 'the failure is still reported once, not swallowed')
    assert.match(fixture.failureWarns()[0], /error message unavailable/,
      'the warning says the message could not be read instead of inventing one')
    assert.equal(fixture.deferralWarns().length, 0, 'an unreadable message is not classified as the host refusal')
    // No cooldown was armed: a second pass runs immediately and attempts the register again.
    notify()
    await flush()
    await tick(5)
    assert.equal(state.register, 2, 'the unclassified path keeps its old immediate-retry behaviour')
    assert.deepEqual(escaped, [], 'the second pass did not escape either')
  } finally { state.open = false; await shutdown(ctx) }
})

await test('the documented false negatives stay unclassified and the literal still classifies', async () => {
  const shapes = [
    ['the literal message', () => new Error(HOST_REFUSAL), true],
    ['upper-cased host text', () => new Error(HOST_REFUSAL.toUpperCase()), false],
    ['host text nested in cause', () => new Error('host wrapper', { cause: new Error(HOST_REFUSAL) }), false],
    ['a null message', () => ({ message: null }), false],
    ['a number', () => 42, false],
    ['undefined', () => undefined, false],
  ]
  for (const [label, throwFactory, cooled] of shapes) {
    const fixture = await setup()
    const { ctx, state, mint, notify, reset, published } = fixture
    try {
      await mint('s1')
      await waitFor(() => published('s1'), { timeoutMs: 1500, what: `the first publication (${label})` })
      reset()
      state.throwFactory = throwFactory
      state.open = true
      notify()
      await flush()
      await tick(10)
      if (cooled) {
        assert.equal(fixture.deferralWarns().length, 1, `${label}: classified and cooled`)
        assert.equal(fixture.failureWarns().length, 0, `${label}: a classified refusal is not a publication failure`)
      } else {
        assert.equal(fixture.deferralWarns().length, 0, `${label}: must stay unclassified`)
        assert.ok(fixture.failureWarns().length >= 1, `${label}: the generic path still reports the failure`)
      }
    } finally { state.open = false; fixture.restore(); await shutdown(ctx) }
  }
})

report('shells-append-reentry-classifier')
