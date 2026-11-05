import { createScope } from '@deepseek-ai/dsh-scope'
import { outcomeSchema } from '../lib/projections/ptc/schema.js'
import { acquire } from '../lib/publication/registrar.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { prepareStep, executeCall } from './lib/executor.mjs'
import { assert, test, report } from './lib/harness.mjs'

const name = 'registrar_fixture'
const canonical = { description: 'Registrar fixture', parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' }, render: () => [] } }
const agentScope = (ctx, id, parent) => {
  const agent = { id, session: { id } }
  agent.ctx = createScope(ctx, agent, parent ? { parent } : undefined).ctx
  return agent
}
const grant = (agent, label, extra = {}) => {
  const token = {}
  return { consumer: {}, agent, token, entitled: true,
    dispatch: async () => ({ source: label }), ...extra }
}
const call = (ctx, agent, step) => executeCall(ctx, { agent, name, toolSet: step.toolSet, arguments: {}, callId: 'fixture' })

await test('shared canonical generation merges consumers and isolates exact agents', async () => {
  const { ctx, tools } = await bootHost()
  const steps = []
  try {
    const a = agentScope(ctx, 'a'), b = agentScope(ctx, 'b')
    const first = await acquire(ctx, undefined, name, canonical)
    const second = await acquire(ctx, undefined, name, canonical)
    first.grant(grant(a, 'a'))
    second.grant(grant(b, 'b'))
    const definition = tools.get(name)
    const sa = await prepareStep(ctx, a), sb = await prepareStep(ctx, b); steps.push(sa, sb)
    assert.equal(tools.definitions().filter(d => d.name === name).length, 1)
    assert.deepEqual((await call(ctx, a, sa)).value, { source: 'a' })
    assert.deepEqual((await call(ctx, b, sb)).value, { source: 'b' })
    const repeated = await prepareStep(ctx, a); steps.push(repeated)
    assert.equal(tools.get(name), definition, 'step selection must preserve owner identity')
    const revokeAmbiguous = second.grant(grant(a, 'ambiguous'))
    const ambiguous = await prepareStep(ctx, a); steps.push(ambiguous)
    assert.equal(tools.executable(name, a, ambiguous.toolSet), undefined)
    revokeAmbiguous()
    first.dispose(); second.dispose()
    assert.equal(tools.get(name), undefined)
    assert.equal(Object.hasOwn(tools, 'register'), false)
  } finally { steps.forEach(s => s.dispose()); await shutdown(ctx) }
})

await test('revocation and new token cannot empower an old captured handle', async () => {
  const { ctx, tools } = await bootHost()
  const steps = []
  try {
    const a = agentScope(ctx, 'a')
    const lease = await acquire(ctx, undefined, name, canonical)
    const old = grant(a, 'old')
    const revoke = lease.grant(old)
    const captured = await prepareStep(ctx, a); steps.push(captured)
    const oldDefinition = tools.get(name)
    revoke()
    lease.grant({ ...grant(a, 'new'), consumer: old.consumer })
    assert.equal(tools.executable(name, a, captured.toolSet), undefined)
    assert.equal((await call(ctx, a, captured)).isError, true)
    const direct = await oldDefinition.execute({}, { agent: a, toolSet: captured.toolSet })
    assert.equal(direct.error.code, 'PUBLICATION_DENIED')
    const fresh = await prepareStep(ctx, a); steps.push(fresh)
    assert.deepEqual((await call(ctx, a, fresh)).value, { source: 'new' })
    lease.dispose()
  } finally { steps.forEach(s => s.dispose()); await shutdown(ctx) }
})

await test('late ancestor source withdraws fallback synchronously and unload stays conservative', async () => {
  const { ctx, tools } = await bootHost()
  const steps = []
  try {
    const parent = agentScope(ctx, 'parent'), child = agentScope(ctx, 'child', parent)
    const lease = await acquire(child.ctx, child, name, canonical)
    lease.grant(grant(child, 'fallback'))
    const before = await prepareStep(ctx, child); steps.push(before)
    let changes = 0
    const stop = ctx.on('tools/change', () => { ++changes; tools.definitions(child) }, { global: true })
    const source = { ...canonical, name, execute: async () => ({ source: 'ancestor' }) }
    const remove = parent.ctx.get('tools').register(source)
    assert.equal(tools.get(name, child), source)
    assert.equal(tools.executable(name, child, before.toolSet), undefined)
    const inherited = await prepareStep(ctx, child); steps.push(inherited)
    assert.deepEqual((await call(ctx, child, inherited)).value, { source: 'ancestor' })
    remove()
    assert.equal(tools.get(name, child), undefined, 'source unload must not resurrect fallback')
    assert.ok(changes >= 2)
    lease.dispose(); stop()
    const next = await acquire(child.ctx, child, name, canonical)
    next.grant(grant(child, 'new-lifecycle'))
    assert.ok(tools.get(name, child))
    next.dispose()
  } finally { steps.forEach(s => s.dispose()); await shutdown(ctx) }
})

await test('hidden ancestor is discovered without bypassing child or parent deny', async () => {
  const { ctx, tools } = await bootHost()
  const steps = []
  try {
    const parent = agentScope(ctx, 'parent'), child = agentScope(ctx, 'child', parent)
    const source = { ...canonical, name, execute: async () => ({ source: 'global' }) }
    const remove = tools.register(source)
    const deny = parent.ctx.get('tools').restrict({ deny: [name] })
    const childDeny = child.ctx.get('tools').restrict({ deny: [name] })
    const lease = await acquire(child.ctx, child, name, canonical)
    lease.grant(grant(child, 'must-not-run'))
    const step = await prepareStep(ctx, child); steps.push(step)
    assert.equal(tools.executable(name, child, step.toolSet), undefined)
    assert.equal(tools.get(name, child), undefined)
    childDeny(); deny()
    assert.equal(tools.get(name, child), source)
    remove()
    assert.equal(tools.get(name, child), undefined)
    lease.dispose()
  } finally { steps.forEach(s => s.dispose()); await shutdown(ctx) }
})
await test('entitlement snapshots prevent silent A to B transfer and expansion', async () => {
  const { ctx, tools } = await bootHost()
  const steps = []
  try {
    const a = agentScope(ctx, 'a')
    const lease = await acquire(ctx, undefined, name, canonical)
    const A = grant(a, 'A'), B = grant(a, 'B', { entitled: false })
    const revokeA = lease.grant(A), revokeB = lease.grant(B)
    const old = await prepareStep(ctx, a); steps.push(old)
    A.entitled = false; B.entitled = true
    assert.deepEqual((await call(ctx, a, old)).value, { source: 'A' }, 'caller mutation cannot transfer entitlement')
    revokeA(); revokeB()
    lease.grant(B)
    assert.equal((await call(ctx, a, old)).isError, true)
    const fresh = await prepareStep(ctx, a); steps.push(fresh)
    assert.deepEqual((await call(ctx, a, fresh)).value, { source: 'B' })
    lease.dispose()
    const empty = await acquire(ctx, undefined, name, canonical)
    const denied = grant(a, 'denied', { entitled: false })
    const revoke = empty.grant(denied)
    const excluded = await prepareStep(ctx, a); steps.push(excluded)
    denied.entitled = true
    assert.equal(tools.executable(name, a, excluded.toolSet), undefined)
    revoke(); empty.grant(denied)
    assert.equal(tools.executable(name, a, excluded.toolSet), undefined)
    empty.dispose()
  } finally { steps.forEach(s => s.dispose()); await shutdown(ctx) }
})

await test('failed refresh rolls back membership and throwing cancels do not stop cleanup', async () => {
  const { ctx, tools } = await bootHost()
  try {
    const a = agentScope(ctx, 'a')
    let fail = true, canceled = 0
    const unstable = { ...canonical, get output() {
      if (fail) throw new Error('injected canonical failure')
      return canonical.output
    } }
    const lease = await acquire(ctx, undefined, name, unstable)
    const failed = grant(a, 'failed', { cancel: () => { ++canceled; throw new Error('failed cancel') } })
    assert.throws(() => lease.grant(failed), AggregateError)
    assert.equal(canceled, 1)
    assert.equal(tools.get(name), undefined)
    fail = false
    // The same consumer is reusable only if failed insertion really rolled back.
    lease.grant({ ...failed, cancel: () => { ++canceled; throw new Error('cancel A') } })
    lease.grant(grant(a, 'second', { cancel: () => { ++canceled; throw new Error('cancel B') } }))
    assert.throws(() => lease.dispose(), AggregateError)
    assert.equal(canceled, 3)
    assert.equal(tools.get(name), undefined)
    lease.dispose()
    const replacement = await acquire(ctx, undefined, name, canonical)
    replacement.grant(grant(a, 'replacement'))
    assert.ok(tools.get(name), 'closed entry and its listener must not interfere')
    replacement.dispose()
  } finally { await shutdown(ctx) }
})
await test('descendant leases retain their source owner, dispatch and ancestor restrictions', async () => {
  const { ctx, tools } = await bootHost()
  const steps = []
  try {
    const parent = agentScope(ctx, 'parent'), child = agentScope(ctx, 'child', parent)
    const first = await acquire(ctx, undefined, name, canonical)
    let executions = 0
    first.grant(grant(parent, 'parent', { dispatch: async () => { ++executions; return { source: 'parent' } } }))
    const second = await acquire(child.ctx, child, name, canonical)
    second.grant(grant(child, 'child', { dispatch: async () => { ++executions; return { source: 'child' } } }))
    const pa = await prepareStep(ctx, parent), ch = await prepareStep(ctx, child); steps.push(pa, ch)
    assert.equal(tools.get(name, parent), tools.get(name, child), 'one inherited source definition')
    assert.deepEqual((await call(ctx, parent, pa)).value, { source: 'parent' })
    assert.deepEqual((await call(ctx, child, ch)).value, { source: 'child' })
    const deny = parent.ctx.get('tools').restrict({ deny: [name] })
    const blocked = await prepareStep(ctx, child); steps.push(blocked)
    assert.equal((await call(ctx, child, blocked)).isError, true)
    assert.equal(executions, 2, 'ancestor deny must stop dispatch')
    deny()
    second.dispose()
    const fresh = await prepareStep(ctx, parent); steps.push(fresh)
    assert.deepEqual((await call(ctx, parent, fresh)).value, { source: 'parent' })
    const absent = await prepareStep(ctx, child); steps.push(absent)
    assert.equal(tools.executable(name, child, absent.toolSet), undefined)
    await assert.rejects(acquire(child.ctx, child, name, { ...canonical }), /Conflicting canonical/)
    first.dispose()
  } finally { steps.forEach(s => s.dispose()); await shutdown(ctx) }
})

await test('source context unload cancels all leases even after parent lease release', async () => {
  const { ctx, tools } = await bootHost()
  const steps = []
  try {
    const parent = { id: 'parent', session: { id: 'parent' } }
    const source = createScope(ctx, parent); parent.ctx = source.ctx
    const child = agentScope(ctx, 'child', parent)
    const first = await acquire(parent.ctx, parent, name, canonical)
    let canceled = 0
    first.grant(grant(parent, 'parent', { cancel: () => { ++canceled } }))
    const second = await acquire(child.ctx, child, name, canonical)
    second.grant(grant(child, 'child', { cancel: () => { ++canceled; throw new Error('cancel child') } }))
    second.grant(grant(parent, 'parent-via-child', { cancel: () => { ++canceled; throw new Error('cancel parent') } }))
    first.dispose()
    assert.equal(canceled, 1)
    const pa = await prepareStep(ctx, parent), ch = await prepareStep(ctx, child); steps.push(pa, ch)
    assert.deepEqual((await call(ctx, child, ch)).value, { source: 'child' })
    await source.dispose()
    assert.equal(canceled, 3, 'throwing cancel must not prevent remaining cancellation')
    assert.equal(tools.get(name, parent), undefined)
    assert.equal(tools.get(name, child), undefined)
    assert.equal((await call(ctx, parent, pa)).isError, true)
    assert.equal((await call(ctx, child, ch)).isError, true)
    assert.throws(() => second.grant(grant(child, 'resurrection')), /disposed/)
    second.dispose()
    assert.equal(canceled, 3, 'lease release after source unload cannot cancel twice')
  } finally { steps.forEach(s => s.dispose()); await shutdown(ctx) }
})
const bounded = async work => {
  let timer
  try { return await Promise.race([work, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Cancellation did not settle within deadline')), 500)
  })]) } finally { clearTimeout(timer) }
}
await test('real host validates bounded cancellation of uncooperative dispatch and observes late rejection', async () => {
  const { ctx, tools } = await bootHost()
  const steps = [], unhandled = []
  const observe = error => unhandled.push(error)
  process.on('unhandledRejection', observe)
  try {
    for (const mode of ['revoke', 'caller', 'unload']) {
      const a = { id: mode, session: { id: mode } }
      const source = createScope(ctx, a); a.ctx = source.ctx
      const schema = { ...canonical, output: { schema: outcomeSchema({ type: 'object' }), render: () => [] } }
      const lease = await acquire(a.ctx, a, name, schema)
      let started, rejectLate, dispatchSignal, calls = 0
      const entered = new Promise(resolve => { started = resolve })
      const dispatch = (_args, exec) => {
        ++calls; dispatchSignal = exec.signal; started()
        return new Promise((_, reject) => { rejectLate = reject })
      }
      const revoke = lease.grant(grant(a, 'uncooperative', { dispatch }))
      const step = await prepareStep(ctx, a); steps.push(step)
      const caller = new AbortController()
      const work = executeCall(ctx, { agent: a, name, toolSet: step.toolSet, arguments: {}, callId: mode, signal: caller.signal })
      await entered
      if (mode === 'caller') caller.abort()
      else if (mode === 'unload') await bounded(source.dispose())
      else {
        revoke()
        lease.grant(grant(a, 'replacement', { dispatch: async () => { ++calls; return { status: 'completed', data: {} } } }))
      }
      const result = await bounded(work)
      if (mode === 'caller') {
        // The host owns the outer caller-abort receipt; registrar still bounds its handoff.
        assert.equal(result.isError, true)
        assert.equal(result.error.info.code, 'ABORTED')
      } else {
        assert.equal(result.isError, false, JSON.stringify(result))
        assert.equal(result.value.status, 'unknown')
        assert.equal(result.value.error.code, 'RESULT_UNKNOWN')
        assert.equal(result.value.error.effectState, 'unknown')
        assert.equal(result.value.error.retry, 'never')
      }
      assert.equal(dispatchSignal.aborted, true)
      assert.equal(calls, 1, 'new grant cannot take over or replay work')
      if (mode !== 'unload') {
        rejectLate(new Error('late provider rejection'))
        await new Promise(resolve => setImmediate(resolve))
        if (mode !== 'caller') assert.equal(result.value.status, 'unknown', 'late settlement cannot replace receipt')
      }
      lease.dispose()
      await bounded(source.dispose())
    }
    assert.deepEqual(unhandled, [])
  } finally {
    process.removeListener('unhandledRejection', observe)
    steps.forEach(step => step.dispose()); await shutdown(ctx)
  }
})
await test('already aborted real host call does not start dispatch', async () => {
  const { ctx } = await bootHost()
  let step
  try {
    const a = agentScope(ctx, 'pre-aborted')
    const schema = { ...canonical, output: { schema: outcomeSchema({ type: 'object' }), render: () => [] } }
    const lease = await acquire(ctx, undefined, name, schema)
    let calls = 0
    lease.grant(grant(a, 'never', { dispatch: async () => { ++calls; return { status: 'completed', data: {} } } }))
    step = await prepareStep(ctx, a)
    const caller = new AbortController(); caller.abort()
    const result = await executeCall(ctx, { agent: a, name, toolSet: step.toolSet, arguments: {}, callId: 'pre-aborted', signal: caller.signal })
    assert.equal(calls, 0)
    assert.notEqual(result.value?.error?.code, 'RESULT_UNKNOWN')
    assert.ok(result.isError || result.value?.error?.effectState === 'none')
    lease.dispose()
  } finally { step?.dispose(); await shutdown(ctx) }
})

await test('real membership change invalidates shared old steps without side effects and fresh resolve recovers', async () => {
  const { ctx, tools } = await bootHost()
  const steps = []
  try {
    const a = agentScope(ctx, 'rotation-a'), b = agentScope(ctx, 'rotation-b')
    const lease = await acquire(ctx, undefined, name, canonical)
    let effects = 0
    const revoke = lease.grant(grant(a, 'old-a'))
    lease.grant(grant(b, 'b', { dispatch: async () => { ++effects; return { source: 'b' } } }))
    const oldA = await prepareStep(ctx, a), oldB = await prepareStep(ctx, b); steps.push(oldA, oldB)
    revoke(); lease.grant(grant(a, 'new-a'))
    for (const [agent, step] of [[a, oldA], [b, oldB]]) {
      assert.equal(tools.executable(name, agent, step.toolSet), undefined)
      const result = await call(ctx, agent, step)
      assert.equal(result.isError, true)
      assert.equal(result.error.info.code, 'UNKNOWN_TOOL')
    }
    assert.equal(effects, 0, 'no automatic replay or dispatch under invalidated step')
    const freshA = await prepareStep(ctx, a), freshB = await prepareStep(ctx, b); steps.push(freshA, freshB)
    assert.deepEqual((await call(ctx, a, freshA)).value, { source: 'new-a' })
    assert.deepEqual((await call(ctx, b, freshB)).value, { source: 'b' })
    assert.equal(effects, 1)
    lease.dispose()
  } finally { steps.forEach(step => step.dispose()); await shutdown(ctx) }
})

report('publication-registrar')
