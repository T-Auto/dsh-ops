/**
 * Composition-root ownership: the plugin may READ the root, never use it as the
 * receiver of a capability (event subscription, effect, inject, plugin).
 *
 * The guard in this suite reproduces dsh-tui 0.19.0's refusal word for word
 * (`dsh-tui: root.events.on is unavailable from a plugin activation`), so any
 * implementation that reaches for the root again fails here with the message a
 * user would see, not with a generic assertion.
 *
 * RED / GREEN, by hand (a bare `git checkout -- <file>` restores HEAD, which is
 * already fixed and would report a false green — always restore from a pinned
 * commit):
 *   1. `git show 5057124:src/publication/result-admission.ts > src/publication/result-admission.ts`
 *   2. `node scripts/build.mjs` (the suites import `lib/`, so an unbuilt revert is invisible)
 *   3. `node test/run.mjs root-ownership` — AC-1 fails with the dsh-tui message,
 *      and AC-3 already fails from step 1 because it scans `src/`
 *   4. `git show HEAD:src/publication/result-admission.ts > src/publication/result-admission.ts`,
 *      `node scripts/build.mjs`, `node test/run.mjs root-ownership` — all green again.
 *
 * No temporary directory is created: every check runs against an in-memory host,
 * so the suite answers on a machine where subprocess fixtures cannot.
 *
 * @module dsh-ops/test/root-ownership
 */

import fs from 'node:fs'
import path from 'node:path'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { assert, report, test, PACKAGE_ROOT } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { NativeFileTools } from '../lib/projections/native/runtime.js'
import { acquireResultAdmission } from '../lib/publication/result-admission.js'
import { publicationRegistration, publicationReady } from '../lib/publication/reentry.js'
import { nativeProviderReady, registerNativeProviderAtScope } from '../lib/publication/providers.js'

const REFUSAL = 'session append cannot reenter while another append is being published'
const refusal = () => new Error(REFUSAL)
const QUEUE_EFFECT = 'dsh-ops: registry refusal queue'
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

const CAPABILITIES = 'on|once|register|unregister|effect|inject|plugin'
const CAPABILITY_CALL = new RegExp('([A-Za-z_$][\\w$]*(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*)*)\\s*\\.\\s*(' + CAPABILITIES + ')\\s*\\(', 'g')
/** A local name bound to the whole composition-root expression. */
const ROOT_BINDING = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=\n;]+)?=\s*(?:\(\s*)?ctx\.root(?:\s*(?:\?\?|\|\|)\s*ctx)?(?:\s*\))?\s*(?=[,;\n)]|$)/g
const ROOT_READ = /ctx\.root\b/g

/** Blank comments without moving a single offset, so reported lines stay exact. */
function withoutComments(source) {
  const blank = (match) => match.replace(/[^\n]/g, ' ')
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank)
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length

/**
 * Receiver analysis, not a text grep.
 *
 * A capability call is a hit when its receiver is the root expression itself
 * (`ctx.root`, `ctx.root.fiber`) or a local bound to that expression
 * (`const root = ctx.root ?? ctx`). A root value passed as an argument — a
 * WeakMap key, `ctx.get`, a call-budget owner — has no receiver of this shape
 * and is therefore never a hit; that is the difference the 18 documented reads
 * depend on.
 * @param source - one file's text.
 * @returns the aliases, the capability receivers and the legitimate root reads.
 */
function analyseSource(source) {
  const text = withoutComments(source)
  const aliases = new Set([...text.matchAll(ROOT_BINDING)].map((match) => match[1]))
  const receivers = []
  for (const match of text.matchAll(CAPABILITY_CALL)) {
    const receiver = match[1].replace(/\s+/g, '')
    const head = receiver.split('.')[0]
    const fromRoot = receiver === 'ctx.root' || receiver.startsWith('ctx.root.') || aliases.has(head)
    if (!fromRoot) continue
    receivers.push({ receiver, method: match[2], index: match.index, end: match.index + match[0].length, line: lineOf(text, match.index) })
  }
  const reads = [...text.matchAll(ROOT_READ)].map((match) => match.index)
  const captured = reads.filter((index) => receivers.some((receiver) => index >= receiver.index && index < receiver.end))
  return { aliases, receivers, reads, captured }
}

/** Every TypeScript source file in `src/`, relative to the package root. */
function sourceFiles() {
  const files = []
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(target)
      else if (entry.name.endsWith('.ts')) files.push(target)
    }
  }
  walk(path.join(PACKAGE_ROOT, 'src'))
  return files.sort()
}

await test('AC-1: runtime evidence and result admission subscribe on the row ctx, not on the composition root', async () => {
  const { ctx: root } = await bootHost()
  const touched = []
  const guardedRoot = guardedCompositionRoot(root, touched)
  const scope = createScope(root, { id: 'root-ownership-ac1' })
  const subscriptions = []
  const row = scope.ctx.extend({
    root: guardedRoot,
    on: (...args) => { subscriptions.push(String(args[0])); return scope.ctx.on(...args) },
  })
  try {
    assert.equal(row.root, guardedRoot, 'the fixture must present the guarded root through ctx.root')
    let runtime
    try {
      runtime = new NativeFileTools({ ctx: row, config: {} })
    } catch (error) {
      assert.fail('NativeFileTools must construct on a row ctx behind a guarded root: ' + error.message)
    }
    assert.equal(runtime.events, row, 'the runtime must keep the constructing ctx as its subscription receiver')
    let admission
    try {
      admission = acquireResultAdmission(row)
    } catch (error) {
      assert.fail('acquireResultAdmission must not reach for the composition root: ' + error.message)
    }
    assert.equal(typeof admission.authorize, 'function')
    admission.dispose()
    await runtime.stop()

    const names = [...new Set(subscriptions)]
    for (const name of ['tools/result', 'llm/stream', 'session/event', 'agent/disposed', 'session/disposed', 'system-prompt/change', 'tools/execute']) {
      assert.ok(names.includes(name), 'the row ctx must receive the ' + name + ' subscription; saw ' + JSON.stringify(names))
    }
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

await test('AC-3: receiver analysis finds zero root-owned capabilities in src/, and none of the legal reads are misjudged', async () => {
  const files = sourceFiles()
  assert.ok(files.length > 100, 'the scan must cover the real source tree, not an empty glob: ' + files.length + ' files')
  const hits = []
  let reads = 0
  let captured = 0
  for (const file of files) {
    const relative = path.relative(PACKAGE_ROOT, file).replaceAll('\\', '/')
    const { receivers, reads: fileReads, captured: fileCaptured } = analyseSource(fs.readFileSync(file, 'utf8'))
    reads += fileReads.length
    captured += fileCaptured.length
    for (const receiver of receivers) hits.push(relative + ':' + receiver.line + ' ' + receiver.receiver + '.' + receiver.method + '()')
  }
  assert.deepEqual(hits, [], 'the composition root must never be a capability receiver:\n       ' + hits.join('\n       '))
  assert.equal(captured, 0, 'every ctx.root read must be outside a capability receiver')
  // 18 root reads are legitimate (WeakMap keys, service reads, withCallBudget
  // owner keys); the shared queue's root key is the 19th. Removing them is a
  // different change, so their presence is the fixture this check stands on.
  assert.ok(reads >= 18, 'the documented legitimate ctx.root reads must still exist; found ' + reads)

  // The analyser must discriminate, or a clean tree would prove nothing.
  const receiver = analyseSource('const root = ctx.root ?? ctx\nroot.events.on("tools/change", () => {})')
  assert.equal(receiver.receivers.length, 1, 'a binding of ctx.root used as a capability receiver is a hit')
  const direct = analyseSource('ctx.root.on("tools/change", () => {})')
  assert.equal(direct.receivers.length, 1, 'ctx.root as a receiver is a hit')
  assert.equal(direct.captured.length, 1, 'a ctx.root read inside a receiver is captured')
  assert.equal(analyseSource('ctx.root.effect(() => () => {})').receivers.length, 1, 'ctx.root.fiber.effect is a hit')
  assert.equal(analyseSource('ctx.root.inject(["tools"])\nctx.root.plugin(plugin)').receivers.length, 2, 'ctx.root.inject/plugin are hits')
  const legal = analyseSource([
    'const key = ctx.root ?? ctx',
    'owners.get(key)',
    'const state = roots.get(ctx.root ?? ctx)',
    'withCallBudget(ctx.root ?? ctx, String(session.id), signal, () => {})',
    'ctx.root.logger.warn("a property read is allowed")',
  ].join('\n'))
  assert.equal(legal.receivers.length, 0, 'keys, service reads and owner keys are not capability receivers')
  assert.equal(legal.reads.length, 4, 'the four root reads in the fixture are still counted as reads')
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

  const labels = []
  const original = row.fiber.effect
  row.fiber.effect = function (execute, label) {
    labels.push(label ?? 'anonymous')
    return original.call(row.fiber, execute, label)
  }
  try {
    const applied = []
    const disposeFirst = publicationRegistration(first, () => { applied.push('first'); return () => {} })
    const disposeSecond = publicationRegistration(second, () => { applied.push('second'); return () => {} })
    await settleWithin(Promise.all([publicationReady(disposeFirst), publicationReady(disposeSecond)]), 4000, 'both extended registrations')
    assert.deepEqual(applied.sort(), ['first', 'second'], 'both registrations must run, so both really retained the queue')
    const retained = labels.filter((label) => label === QUEUE_EFFECT)
    assert.equal(retained.length, 1, 'one fiber owns one reference; two extended contexts registered ' + retained.length + ' queue effects')
    const leases = labels.filter((label) => label === 'dsh-ops: registry publication lease')
    assert.equal(leases.length, 2, 'each registration still has its own lease')

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
    row.fiber.effect = original
    await rowScope.dispose().catch(() => {})
    await siblingScope.dispose().catch(() => {})
    await shutdown(root)
  }
})

report('root-ownership')
