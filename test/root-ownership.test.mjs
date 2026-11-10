/**
 * Composition-root ownership: the plugin may READ the root, never use it as the
 * receiver of a capability (event subscription, effect, inject, plugin).
 *
 * The guard in this suite reproduces dsh-tui 0.19.0's refusal word for word
 * (`dsh-tui: root.events.on is unavailable from a plugin activation`), so any
 * implementation that reaches for the root again fails here with the message a
 * user would see, not with a generic assertion.
 *
 * Each check fails when the behaviour it names is reverted: subscribe the runtime
 * on `ctx.root` again and the guarded root refuses; move the shared source's
 * teardown back to `agent.ctx` and the scope-owner suite goes red; drop either
 * refusal in `acquireSharedFile` and the same suite goes red. The suites import
 * `lib/`, so rebuild before reading a revert.
 *
 * The receiver analysis is type-aware, not a text grep. The compiler is already a
 * devDependency, so the analyser parses the whole `src/` tree with
 * `ts.createProgram` and resolves every capability call's receiver along its
 * aliases. Its negative fixtures are the spellings real code actually uses,
 * parsed with `ts.createSourceFile`, so proving they are caught writes no file.
 *
 * No temporary directory is created: every check runs against an in-memory host,
 * so the suite answers on a machine where subprocess fixtures cannot.
 *
 * @module dsh-ops/test/root-ownership
 */

import SessionStore from '@deepseek-ai/dsh-session'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { assert, report, test, PACKAGE_ROOT } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { CAPABILITIES, hitsFor, rootReceivers, sourceFiles } from './lib/root-receivers.mjs'
import { NativeFileTools } from '../lib/projections/native/runtime.js'
import { acquireResultAdmission } from '../lib/publication/result-admission.js'
import { publicationRegistration, publicationReady } from '../lib/publication/reentry.js'
import { nativeProviderReady, registerNativeProviderAtScope } from '../lib/publication/providers.js'

const REFUSAL = 'session append cannot reenter while another append is being published'
const refusal = () => new Error(REFUSAL)
const SUBSCRIPTIONS = new Set(['on', 'once', 'register', 'unregister'])

/** Race one waiting publication against a deadline so a stalled queue fails instead of hanging the gate. */
function settleWithin(promise, ms, what) {
  let timer
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(what + ' did not settle within ' + ms + ' ms')), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** One capability refusal carrying the exact shipped wording. */
function refuse(capability, touched) {
  return () => {
    touched.push(capability)
    throw new Error('dsh-tui: ' + capability + ' is unavailable from a plugin activation')
  }
}

/**
 * Substitute the composition root's capabilities with the dsh-tui refusal.
 *
 * Only the root is refused: child contexts keep their own events service and
 * fiber, exactly as the host guard leaves them. Everything else on the root
 * stays readable, because reading `root` (a WeakMap key, a logger, a service) is
 * allowed and the fix must not be mistaken for "do not touch root at all".
 * @param root - the real composition root context.
 * @param touched - collects the capability names that were actually attempted.
 * @returns a proxy of the root whose capabilities throw instead of running.
 */
function guardedCompositionRoot(root, touched) {
  const forward = (object, property) => {
    const value = Reflect.get(object, property, object)
    return typeof value === 'function' ? value.bind(object) : value
  }
  const events = new Proxy(root.events, {
    get(object, property) {
      if (typeof property === 'string' && SUBSCRIPTIONS.has(property)) return refuse('root.events.' + property, touched)
      return forward(object, property)
    },
  })
  const fiber = new Proxy(root.fiber, {
    get(object, property) {
      if (property === 'effect') return refuse('root.effect', touched)
      return forward(object, property)
    },
  })
  return new Proxy(root, {
    get(object, property) {
      if (property === 'events') return events
      if (property === 'fiber') return fiber
      if (typeof property === 'string' && SUBSCRIPTIONS.has(property)) return refuse('root.events.' + property, touched)
      if (property === 'effect') return refuse('root.effect', touched)
      if (property === 'inject' || property === 'plugin') return refuse('root.' + property, touched)
      return forward(object, property)
    },
  })
}

await test('AC-1: runtime evidence and result admission subscribe on the row ctx, not on the composition root', async () => {
  const { ctx: root } = await bootHost()
  const touched = []
  const guardedRoot = guardedCompositionRoot(root, touched)
  await root.plugin(SessionStore)
  const scope = createScope(root, { id: 'root-ownership-ac1' })
  const subscriptions = []
  const delivered = []
  let row
  // The receiver has to be a row ctx, not any ctx that merely answers `on`: only
  // a ctx without a scope tag receives `session/event` and `session/disposed`,
  // because the store dispatches them through a scope carrier. So the fixture is a
  // real plugin row (untagged, like every consumer row) and the recorder forwards
  // through it, which makes the listener that fires the runtime's own.
  await root.plugin({
    apply(inner) {
      const base = inner.extend({ root: guardedRoot })
      row = base.extend({
        on: (name, listener, ...rest) => {
          subscriptions.push(String(name))
          return base.on(name, (...args) => { delivered.push(String(name)); return listener(...args) }, ...rest)
        },
      })
    },
  })
  try {
    assert.equal(row.root, guardedRoot, 'the fixture must present the guarded root through ctx.root')
    let runtime
    try {
      runtime = new NativeFileTools({ ctx: row, config: {} })
    } catch (error) {
      assert.fail('NativeFileTools must construct on a row ctx behind a guarded root: ' + error.message)
    }
    let admission
    try {
      admission = acquireResultAdmission(row)
    } catch (error) {
      assert.fail('acquireResultAdmission must not reach for the composition root: ' + error.message)
    }
    assert.equal(typeof admission.authorize, 'function')

    // Behaviour, not the field that stores it: the two events a scope tag filters
    // out are dispatched at a live session and must reach these listeners. Reading
    // `runtime.events` only proved which object was kept; an implementation that
    // subscribed elsewhere and stored the row anyway would have passed.
    const events = [...new Set(subscriptions)]
    for (const name of ['tools/result', 'llm/stream', 'session/event', 'agent/disposed', 'session/disposed', 'system-prompt/change', 'tools/execute']) {
      assert.ok(events.includes(name), 'the row ctx must receive the ' + name + ' subscription; saw ' + JSON.stringify(events))
    }
    // The control that makes the delivery assertion mean something: the same two
    // listeners on a scope-tagged ctx (the shape an agent's ctx has) must receive
    // neither event, because the store dispatches through a scope carrier. Without
    // it "delivered" could hold for every ctx and prove nothing.
    const agentScoped = []
    for (const name of ['session/event', 'session/disposed']) scope.ctx.on(name, () => { agentScoped.push(name) })
    const store = root.get('sessions')
    assert.ok(store, 'the fixture needs the real session store to dispatch session events')
    const session = store.prepare('root-ownership-ac1', { meta: { cwd: PACKAGE_ROOT } })
    const detach = store.enter(session)
    store.announce(session)
    try {
      session.append('step/end', { turn: 1, step: 1 })
      detach()
    } finally {
      await runtime.stop()
      admission.dispose()
    }
    assert.deepEqual(delivered.sort(), ['session/disposed', 'session/event'],
      'both session events must be delivered to the listeners the row ctx owns. Delivered: ' + JSON.stringify(delivered))
    assert.deepEqual(agentScoped, [],
      'a scope-tagged ctx must receive neither session event, so the delivery above really discriminates. Received: ' + JSON.stringify(agentScoped))
    assert.deepEqual(touched, [], 'no capability may be taken from the composition root')
  } finally {
    await scope.dispose()
    await shutdown(root)
  }
})

await test('AC-2: a first-time queue and a native provider registration own their effects on the row ctx', async () => {
  const { ctx: root } = await bootHost()
  const touched = []
  const guardedRoot = guardedCompositionRoot(root, touched)
  const scope = createScope(root, { id: 'root-ownership-ac2' })
  const row = scope.ctx.extend({ root: guardedRoot })
  const applied = []
  const withdrawn = []
  const mounted = []
  try {
    // No queue exists for this root yet: this is the first publication and the
    // one that has to take its release effect from the row ctx.
    let dispose
    try {
      dispose = publicationRegistration(row, () => {
        applied.push('notification')
        return () => { withdrawn.push('notification') }
      })
    } catch (error) {
      assert.fail('a first publication on a guarded root must not take root.effect: ' + error.message)
    }
    await settleWithin(publicationReady(dispose), 4000, 'the first publication')
    assert.deepEqual(applied, ['notification'], 'the queued registration must actually run')
    dispose()
    assert.deepEqual(withdrawn, ['notification'])

    const definition = {
      name: 'root-ownership-fixture',
      description: 'a provider definition owned by the row ctx',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [] },
      execute: async () => ({}),
    }
    let stop
    try {
      stop = registerNativeProviderAtScope(row, scopeOf(scope.ctx), [definition], (tool) => {
        mounted.push(tool.name)
        return () => { withdrawn.push(tool.name) }
      })
    } catch (error) {
      assert.fail('provider registration must not take root.effect: ' + error.message)
    }
    assert.deepEqual(mounted, ['root-ownership-fixture'], 'the registration must actually happen')
    await settleWithin(nativeProviderReady(stop), 4000, 'the provider notification')
    stop()
    assert.ok(withdrawn.includes('root-ownership-fixture'), 'the returned teardown must withdraw the registration')
    assert.deepEqual(touched, [], 'no capability may be taken from the composition root')
  } finally {
    await scope.dispose()
    await shutdown(root)
  }
})

await test('AC-3: receiver analysis finds zero root-owned capabilities in src/', async () => {
  const files = sourceFiles()
  assert.ok(files.length > 100, 'the scan must cover the real source tree, not an empty glob: ' + files.length + ' files')
  const hits = []
  for (const { sourceFile, relative } of files) {
    for (const hit of rootReceivers(sourceFile)) hits.push(relative + ':' + hit.line + ' ' + hit.receiver + '.' + hit.method + '()')
  }
  assert.deepEqual(hits, [], 'the composition root must never be a capability receiver:\n       ' + hits.join('\n       '))
})

await test('AC-3b: the analyser catches the spellings of a root receiver, and leaves the legal reads alone', async () => {
  // The spellings real code uses to reach the root, each parsed on its own. The
  // assertion names the spelling that escaped; shapes the analyser deliberately
  // does not follow are listed under `limits` below.
  const bypasses = {
    'historical baseline (ctx.root.on)': 'ctx.root.on("tools/change", () => {})',
    'destructured root (const { root } = ctx)': 'const { root } = ctx\nroot.on("tools/change", () => {})',
    'as-cast alias (const r = ctx.root as Context)': 'const r = ctx.root as Context\nr.on("tools/change", () => {})',
    'second alias hop (const b = a)': 'const a = ctx.root ?? ctx\nconst b = a\nb.on("tools/change", () => {})',
    'deferred assignment (let r; r = ctx.root)': 'let r\nr = ctx.root\nr.on("tools/change", () => {})',
    'helper parameter (target.on)': 'function subscribe(target: Context) { target.on("tools/change", () => {}) }\nsubscribe(ctx.root ?? ctx)',
    'carrier hop (ctx.root.events.on)': 'ctx.root.events.on("tools/change", () => {})',
    'carrier hop (ctx.root.fiber.effect)': 'ctx.root.fiber.effect(() => () => {})',
    'reflect.set (ctx.root.reflect.set)': 'ctx.root.reflect.set("tools", service)',
    'reflect.set through the root alias': 'const root = ctx.root ?? ctx\nroot.reflect.set("tools", service)',
    'inject/plugin on the root': 'ctx.root.inject(["tools"])\nctx.root.plugin(plugin)',
  }
  for (const [name, snippet] of Object.entries(bypasses)) {
    assert.ok(hitsFor(snippet).length > 0, 'the analyser must catch ' + name + ', but it reported no receiver')
  }
  for (const capability of CAPABILITIES) {
    assert.equal(hitsFor('ctx.root.' + capability + '(argument)').length, 1, 'ctx.root.' + capability + ' is a capability call')
  }

  // The legal shapes, each named: the analysis must not answer "root used as a
  // receiver" for a root that is only a key, a service read or an owner key.
  const legal = {
    'owners.get(key)': 'const key = ctx.root ?? ctx\nowners.get(key)',
    'withCallBudget(ctx.root ?? ctx, ...)': 'withCallBudget(ctx.root ?? ctx, String(session.id), signal, () => {})',
    'ctx.root.logger.warn': 'ctx.root.logger.warn("a property read is allowed")',
    'root.tools.set (the tools service, not the root)': 'ctx.root.tools.set("name", definition)',
  }
  for (const [name, snippet] of Object.entries(legal)) {
    assert.equal(hitsFor(snippet).length, 0, name + ' is a legal root read, but the analyser called it a capability receiver')
  }

  // A later assignment does not reach back: a use sees the value the name holds
  // at that point. Without this, an analysis that indexed the last assignment of
  // a name would count both subscriptions below as root receivers.
  assert.equal(
    hitsFor('let r = ctx.root\nr.on("tools/change", () => {})\nr = ctx\nr.on("tools/second", () => {})').length,
    1,
    'the binding a use reads is the one before it, not the last assignment in the file',
  )

  // Known limits, pinned rather than pretended away: each one is a shape ordinary
  // code really reaches, that this analysis deliberately does not follow. The pin
  // is an `assert.equal(0)` — the moment the analyser starts catching one, this
  // fails and the declaration has to be corrected, so the limit list cannot rot.
  const limits = {
    // The analysis follows what a name is *initialized or assigned* with, never
    // what a function returns. Giving every function a "does it return the root"
    // verdict is a call graph, and the runtime checks already cover this shape.
    'helper return value (pick(ctx).on)': 'function pick(context: Context) { return context.root ?? context }\npick(ctx).on("tools/change", () => {})',
    // A container is a different value: `arr` holds the root, it is not the
    // root. Element identity would have to be indexed (`arr[0]` is the root,
    // `arr[1]` is not) and a coarse "a container that holds the root makes every
    // element the root" rule would call `const pair = { root, api }; pair.api.on(...)`
    // a hit — the false red this analysis exists to avoid.
    'object container (const o = { r: ctx.root })': 'const o = { r: ctx.root }\no.r.on("tools/change", () => {})',
    // `this.r` is a class property, not a local: resolving it needs the class
    // symbol and `this` typing, and a field can be reassigned from any method, so
    // one initializer is not a value a use can trust.
    'class field (this.r = c.root)': 'class C { r: Context\n constructor(c: Context) { this.r = c.root }\n m() { this.r.on("tools/change", () => {}) } }',
  }
  for (const [name, snippet] of Object.entries(limits)) {
    assert.equal(hitsFor(snippet).length, 0, 'the analyser is documented not to resolve ' + name + '; it now does, so update the limit list')
  }
})


await test('AC-4: two rows on one root share a refusal window, and one row unloading does not interrupt the other', async () => {
  const { ctx: root } = await bootHost()
  const scopeA = createScope(root, { id: 'root-ownership-ac4-a' })
  const scopeB = createScope(root, { id: 'root-ownership-ac4-b' })
  let locked = true
  let attemptsA = 0
  let attemptsB = 0
  const applied = []
  try {
    assert.equal(scopeA.ctx.root, root, 'row A must sit on the checked root')
    assert.equal(scopeB.ctx.root, root, 'row B must sit on the same root')
    const disposeA = publicationRegistration(scopeA.ctx, () => {
      ++attemptsA
      if (locked) throw refusal()
      applied.push('A')
      return () => {}
    })
    const disposeB = publicationRegistration(scopeB.ctx, () => {
      ++attemptsB
      if (locked) throw refusal()
      applied.push('B')
      return () => {}
    })
    assert.equal(attemptsA, 1, 'the first registration takes the refusal window synchronously')
    assert.equal(attemptsB, 0, 'a second row must wait in the same window; a per-row queue would try immediately')
    const cancellation = publicationReady(disposeA).catch((error) => error)
    const survivor = publicationReady(disposeB)
    await scopeA.dispose()
    const cancelled = await cancellation
    assert.match(String(cancelled?.message ?? cancelled), /cancelled/, 'row A\'s own pending work is cancelled by its unload')
    locked = false
    const settlement = await settleWithin(survivor, 4000, 'row B publication after row A unloaded').then(() => undefined, (error) => error)
    assert.equal(settlement, undefined, 'row B must settle after row A unloads instead of reading "Publication root disposed": ' + settlement)
    assert.ok(applied.includes('B'), 'row B\'s registration must run')

    disposeB()
    await scopeB.dispose()
    // Every owner is gone: the queue must be disposed and rebuilt for the next
    // row, not left stopped (a stopped queue silently swallows submissions).
    const later = createScope(root, { id: 'root-ownership-ac4-later' })
    const laterApplied = []
    const disposeLater = publicationRegistration(later.ctx, () => {
      laterApplied.push('later')
      return () => {}
    })
    await settleWithin(publicationReady(disposeLater), 2000, 'a row registered after every prior owner unloaded')
    assert.deepEqual(laterApplied, ['later'])
    disposeLater()
    await later.dispose()
  } finally {
    await scopeA.dispose().catch(() => {})
    await scopeB.dispose().catch(() => {})
    await shutdown(root)
  }
})

await test('AC-4b: references count owner fibers, so two extended contexts share one reference and one release', async () => {
  const { ctx: root } = await bootHost()
  const rowScope = createScope(root, { id: 'root-ownership-ac4b-row' })
  const siblingScope = createScope(root, { id: 'root-ownership-ac4b-sibling' })
  const row = rowScope.ctx
  const first = row.extend({})
  const second = row.extend({})
  assert.notEqual(first, second, 'extend must produce distinct context objects')
  assert.equal(first.fiber, second.fiber, 'both extended contexts must share the row fiber')
  assert.equal(first.root, root, 'both extended contexts still read the shared root')

  try {
    const applied = []
    const disposeFirst = publicationRegistration(first, () => { applied.push('first'); return () => {} })
    const disposeSecond = publicationRegistration(second, () => { applied.push('second'); return () => {} })
    await settleWithin(Promise.all([publicationReady(disposeFirst), publicationReady(disposeSecond)]), 4000, 'both extended registrations')
    assert.deepEqual(applied.sort(), ['first', 'second'], 'both registrations must run, so both really retained the queue')

    // A sibling row keeps the queue alive: the row fiber unload must release
    // exactly the one reference it took, never two.
    let locked = true
    let attempts = 0
    let appliedSibling = false
    const disposeSibling = publicationRegistration(siblingScope.ctx, () => {
      ++attempts
      if (locked) throw refusal()
      appliedSibling = true
      return () => {}
    })
    const cancelledFirst = publicationReady(disposeFirst).catch(() => undefined)
    const cancelledSecond = publicationReady(disposeSecond).catch(() => undefined)
    await rowScope.dispose()
    await cancelledFirst
    await cancelledSecond
    locked = false
    const surviving = await settleWithin(publicationReady(disposeSibling), 4000, 'the sibling row after the extended fiber unloaded')
      .then(() => undefined, (error) => error)
    assert.equal(surviving, undefined, 'the sibling row must settle; an over-released reference reads "Publication root disposed": ' + surviving)
    assert.ok(appliedSibling, 'the sibling registration must run')
    assert.ok(attempts >= 2, 'the sibling really retried after its refusal: ' + attempts + ' attempt(s)')

    disposeSibling()
    await siblingScope.dispose()
    const later = createScope(root, { id: 'root-ownership-ac4b-later' })
    const laterApplied = []
    const disposeLater = publicationRegistration(later.ctx, () => { laterApplied.push('later'); return () => {} })
    await settleWithin(publicationReady(disposeLater), 2000, 'a row registered after the last owner unloaded')
    assert.deepEqual(laterApplied, ['later'])
    disposeLater()
    await later.dispose()
  } finally {
    await rowScope.dispose().catch(() => {})
    await siblingScope.dispose().catch(() => {})
    await shutdown(root)
  }
})

report('root-ownership')
