/** Real restart and guarded-root lifetimes for the shared publication queue. */
import { createScope } from '@deepseek-ai/dsh-scope'
import { publicationRegistration, publicationReady, publicationPending } from '../lib/publication/reentry.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { assert, test, report } from './lib/harness.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const refusal = () => new Error('session append cannot reenter while another append is being published')
const definition = name => ({ name, description: name, parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) })
const ready = async dispose => {
  let timer
  try {
    await Promise.race([publicationReady(dispose), new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('publication did not settle within 4s')), 4000)
    })])
  } finally { clearTimeout(timer) }
}

async function reloadFixture(body) {
  const { ctx, tools } = await bootHost()
  let release, owner, restarting, unloading = false
  const barrier = new Promise(resolve => { release = resolve })
  const fiber = await ctx.plugin({ apply(scoped) {
    owner = scoped
    scoped.effect(() => async () => { unloading = true; await barrier }, 'fixture reload barrier')
  } })
  const effect = owner.effect.bind(owner)
  // Hold the actual publication cancellation too: Cordis runs unload effects in parallel.
  owner.effect = (setup, label) => label === 'dsh-ops: registry publication lease' ? effect(() => {
    const dispose = setup()
    return async () => { await barrier; dispose() }
  }, label) : effect(setup, label)
  const restart = () => { restarting = fiber.restart(); return restarting }
  try {
    await body({ ctx, tools, owner, fiber, restart, release, assertUnloading: async () => {
      await tick()
      assert.equal(unloading, true)
      assert.notEqual(fiber.uid, null, 'real restart retains the fiber identity')
      assert.equal(fiber.state, 5, 'Cordis UNLOADING refuses effects despite a retained uid')
    } })
  } finally {
    owner.effect = effect
    release()
    await restarting
    await shutdown(ctx)
  }
}

await test('an unloading owner returns cancelled setup readiness and can publish after reloading', () => reloadFixture(async ({ owner, restart, release, assertUnloading }) => {
  const restarting = restart()
  await assertUnloading()
  let attempts = 0
  const cancelled = publicationRegistration(owner, () => { ++attempts; return () => {} })
  await assert.rejects(publicationReady(cancelled), /Publication owner inactive/)
  assert.equal(publicationPending(cancelled), false)
  assert.equal(attempts, 0)
  release()
  await restarting
  const recovered = publicationRegistration(owner, () => { ++attempts; return () => {} })
  await ready(recovered)
  assert.equal(attempts, 1)
  recovered()
}))

await test('queued work skips a retained-uid unloading owner before delayed cancellation', () => reloadFixture(async ({ ctx, owner, restart, release, assertUnloading }) => {
  let locked = true, attempts = 0, blocker, pending, healthy
  try {
    blocker = publicationRegistration(ctx, () => { if (locked) throw refusal(); return () => {} })
    pending = publicationRegistration(owner, () => { ++attempts; return () => {} })
    healthy = publicationRegistration(ctx, () => () => {})
    const restarting = restart()
    await assertUnloading()
    assert.equal(publicationPending(pending), true)
    locked = false
    await ready(healthy)
    await assert.rejects(publicationReady(pending), /Publication owner inactive/)
    assert.equal(attempts, 0)
    release()
    await restarting
    await assert.rejects(publicationReady(pending), /Publication owner inactive/)
  } finally { locked = false; release(); pending?.(); healthy?.(); blocker?.() }
}))

await test('restart triggered inside apply rejects readiness and retains its exact undo', () => reloadFixture(async ({ owner, restart, release, assertUnloading }) => {
  let restarting, undos = 0
  const registration = publicationRegistration(owner, () => {
    restarting = restart()
    assert.equal(owner.fiber.state, 5)
    return () => { ++undos }
  })
  try {
    await assertUnloading()
    await assert.rejects(publicationReady(registration), /Publication owner inactive/)
    assert.equal(publicationPending(registration), false)
    assert.equal(undos, 1)
    release()
    await restarting
    registration()
    assert.equal(undos, 1)
  } finally { release(); registration() }
}))

await test('publication during the legitimate LOADING phase remains available', async () => {
  const { ctx } = await bootHost()
  let registration, attempts = 0
  try {
    await ctx.plugin({ apply(owner) {
      assert.equal(owner.fiber.state, 1)
      registration = publicationRegistration(owner, () => { ++attempts; return () => {} })
    } })
    await ready(registration)
    assert.equal(attempts, 1)
    assert.equal(publicationPending(registration), false)
  } finally { registration?.(); await shutdown(ctx) }
})

async function guardedFixture(body) {
  const { ctx, tools } = await bootHost()
  const rootEffect = ctx.effect.bind(ctx)
  const first = { id: 'fallback-first' }, sibling = { id: 'fallback-sibling' }
  const a = createScope(ctx, first), b = createScope(ctx, sibling), c = createScope(ctx, { id: 'fallback-successor' })
  // Guard the composition root, while preserving the real scoped effect capability.
  a.ctx.effect = a.ctx.effect.bind(a.ctx)
  b.ctx.effect = b.ctx.effect.bind(b.ctx)
  c.ctx.effect = c.ctx.effect.bind(c.ctx)
  ctx.effect = () => { throw new Error('fixture composition root refuses effects') }
  try { await body({ ctx, tools, first, sibling, a, b, c }) }
  finally { ctx.effect = rootEffect; await shutdown(ctx) }
}

await test('a fallback queue remains owned while a live sibling still needs its old withdrawal handle', () => guardedFixture(async ({ tools, sibling, a, b }) => {
  const first = publicationRegistration(a.ctx, () => () => {})
  const registration = publicationRegistration(b.ctx, () => b.ctx.get('tools').register(definition('fallback-live')))
  try {
    await ready(registration)
    await a.dispose()
    assert.notEqual(b.ctx.fiber.uid, null)
    assert.ok(tools.get('fallback-live', sibling))
    registration()
    assert.equal(tools.get('fallback-live', sibling), undefined, 'the old handle must still execute its exact undo immediately')
  } finally { registration(); first() }
}))

await test('fallback owner teardown cannot drop a refused withdrawal or let its replacement overtake it', () => guardedFixture(async ({ tools, sibling, a, b }) => {
  let locked = true, undos = 0, replacement
  const first = publicationRegistration(a.ctx, () => () => {})
  const registration = publicationRegistration(b.ctx, () => {
    const undo = b.ctx.get('tools').register(definition('fallback-refused'))
    return () => { ++undos; if (locked) throw refusal(); undo() }
  })
  try {
    registration()
    assert.equal(undos, 1)
    await a.dispose()
    replacement = publicationRegistration(b.ctx, () => b.ctx.get('tools').register(definition('fallback-refused')))
    assert.equal(publicationPending(replacement), true)
    locked = false
    await ready(replacement)
    assert.equal(undos, 2, 'the owed withdrawal must precede registration of the same name')
    assert.equal(tools.definitions(sibling).filter(tool => tool.name === 'fallback-refused').length, 1)
    replacement()
    assert.equal(tools.get('fallback-refused', sibling), undefined)
  } finally { locked = false; replacement?.(); registration(); first() }
}))

await test('stopping the last fallback owner retains an owed withdrawal until refusal clears', () => guardedFixture(async ({ a, b }) => {
  let locked = true, attempts = 0, resolveUndo, timer
  const undone = new Promise(resolve => { resolveUndo = resolve })
  const first = publicationRegistration(a.ctx, () => () => {})
  const registration = publicationRegistration(b.ctx, () => () => {
    ++attempts
    if (locked) throw refusal()
    resolveUndo()
  })
  try {
    registration()
    assert.equal(attempts, 1)
    await a.dispose()
    await b.dispose()
    locked = false
    await Promise.race([undone, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('stopped queue lost its owed withdrawal')), 4000)
    })])
    assert.ok(attempts >= 2)
  } finally { locked = false; clearTimeout(timer); registration(); first() }
}))

await test('a new fallback owner inherits queued withdrawal debt before publishing its replacement', () => guardedFixture(async ({ a, b, c }) => {
  let locked = true, replacement
  const events = []
  const first = publicationRegistration(a.ctx, () => () => {})
  const registration = publicationRegistration(b.ctx, () => () => {
    if (locked) throw refusal()
    events.push('withdrawal')
  })
  try {
    registration()
    await a.dispose()
    await b.dispose()
    replacement = publicationRegistration(c.ctx, () => { events.push('replacement'); return () => {} })
    assert.equal(publicationPending(replacement), true, 'a live successor must wait behind the old debt rather than be cancelled')
    assert.deepEqual(events, [])
    locked = false
    await ready(replacement)
    assert.deepEqual(events, ['withdrawal', 'replacement'])
    assert.equal(publicationPending(replacement), false)
  } finally { locked = false; replacement?.(); registration(); first() }
}))

report('publication-reload')
