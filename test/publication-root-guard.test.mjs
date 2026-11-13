import { acquireResultAdmission } from '../lib/publication/result-admission.js'
import { createNativeReadDedup } from '../lib/projections/native/read-dedup.js'
import { publicationRegistration } from '../lib/publication/reentry.js'
import { assert, test, report } from './lib/harness.mjs'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

// dsh-tui wraps the composition root and refuses effect/subscribe calls made from
// a plugin activation (`root.events.on`, `root.effect`). The native-tools row is
// such an activation, so anything it constructs must stay off the root.
const refusal = capability => new Error(`dsh-tui: root.${capability} is unavailable from a plugin activation`)

function guardedRoot() {
  return {
    logger: { warn() {} },
    on() { throw refusal('events.on') },
    once() { throw refusal('events.once') },
    effect() { throw refusal('effect') },
    inject() { throw refusal('inject') },
  }
}

function callerContext(root) {
  const listeners = new Map()
  const effects = []
  return {
    root,
    listeners,
    effects,
    on(name, listener, options) {
      const entries = listeners.get(name) ?? []
      entries.push({ listener, options })
      listeners.set(name, entries)
      return () => listeners.set(name, (listeners.get(name) ?? []).filter(entry => entry.listener !== listener))
    },
    effect(callback, label) {
      effects.push(label)
      const cleanup = callback()
      return typeof cleanup === 'function' ? cleanup : () => {}
    },
    get() { return undefined },
  }
}

const names = ctx => [...ctx.listeners.keys()].sort()
const globalOnly = ctx => [...ctx.listeners.values()].flat().every(entry => entry.options?.global === true)

await test('a root that refuses subscriptions does not fail the caller that builds the native runtime', () => {
  const ctx = callerContext(guardedRoot())
  const admission = acquireResultAdmission(ctx)
  try {
    assert.deepEqual(names(ctx), ['system-prompt/change', 'tools/execute'], 'listeners land on the caller context')
    assert.ok(globalOnly(ctx), 'root-level dispatch is preserved through the global option')
  } finally {
    admission.dispose()
  }
  assert.deepEqual(names(ctx), ['system-prompt/change', 'tools/execute'], 'disposal leaves the entries readable but empty')
  assert.equal([...ctx.listeners.values()].flat().length, 0, 'both listeners are removed on dispose')
})

await test('the evidence observer subscribes on the caller context when the root refuses it', () => {
  const ctx = callerContext(guardedRoot())
  const observer = createNativeReadDedup(ctx)
  try {
    assert.deepEqual(names(ctx), ['agent/disposed', 'llm/stream', 'session/disposed', 'session/event', 'tools/result'])
    assert.ok(globalOnly(ctx), 'every observer listener asks for root-level dispatch')
    assert.equal(typeof observer.wrap, 'function')
  } finally {
    observer.dispose()
  }
  assert.equal([...ctx.listeners.values()].flat().length, 0, 'the observer owns and releases its listeners')
})

await test('the refusal queue falls back to the caller lifetime when the root refuses an effect', async () => {
  const ctx = callerContext(guardedRoot())
  let applied = 0
  const dispose = publicationRegistration(ctx, () => {
    ++applied
    return () => {}
  })
  await wait(20)
  assert.equal(applied, 1, 'a refused root effect must not lose the queued registration')
  assert.ok(ctx.effects.includes('dsh-ops: registry refusal queue'), 'teardown is registered on the caller instead')
  dispose()
})

report('publication-root-guard')
