/** Real worker/host audit references, with explicit transport faults only after native settlement. */
import fs from 'node:fs'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { invoke } from '../lib/ptc/worker.js'
import { definition } from '../lib/ptc/contract.js'
import { expireResultSession } from '../lib/kernel/result-lifecycle.js'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { WORKER, requireWorker, callWorker, envelopeOf, request } from './lib/boundary.mjs'
import { mountResident } from './lib/resident.mjs'

requireWorker('ptc-audit-refs')
let serial = 0
async function withBridge(body) {
  await withTempDir('ptc-audit-ref', async root => {
    fs.writeFileSync(path.join(root, 'source.txt'), 'original source\n')
    const context = new Context(); context.logger.level = 0
    await context.plugin(Subprocess)
    const kernel = await mountResident(context, { file: WORKER, cwd: root })
    const original = kernel.invoke.bind(kernel)
    const session = { id: 'audit-refs-' + ++serial, header: { cwd: root } }
    const calls = [], cacheRoots = new Set()
    let nextFault
    kernel.invoke = async (envelope, signal, started) => {
      const fault = nextFault; nextFault = undefined
      const call = { request: envelope.request, started: false }; calls.push(call)
      if (envelope.storage?.root) cacheRoots.add(envelope.storage.root)
      if (fault === 'before-spawn') throw new Error('fixture: admission refused before any worker was created')
      const result = await original(envelope, signal, () => { call.started = true; started?.() })
      call.native = result.value
      // The native leaf really persisted its plan/run. Substitute only its received exchange.
      return !fault ? result : fault === 'lost-reply' ? { ...result, value: undefined, invalid: 'json' } : { ...result, value: fault }
    }
    const ctx = { root: context.root, get(name) {
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) }
      return context.get(name)
    } }
    const api = {
      root, session, calls,
      fault(value) { nextFault = value },
      async call(tool, args, projected = false) {
        const before = calls.length
        const execute = () => invoke(ctx, WORKER, tool, args, { agent: { session } }, new AbortController().signal)
        const entry = definition(tool, execute)
        const value = await (projected ? entry.execute(args, {}) : execute())
        if (projected) assert.deepEqual(validateJsonSchemaValue(entry.output.schema, value), [])
        assert.equal(calls.length, before + 1, 'one requested operation submits at most one resident request; no audit probe')
        return { value, call: calls.at(-1) }
      },
      async page(id) { return (await this.call('result', { action: 'page', id })).value },
      records(id) {
        const store = path.join(root, '.dsh-ops')
        return fs.existsSync(store) ? fs.readdirSync(store).filter(name => name.startsWith(id + '.')) : []
      },
    }
    try { await body(api) }
    finally {
      nextFault = undefined
      await expireResultSession(ctx, session)
      await context.fiber.dispose()
      for (const cache of cacheRoots) fs.rmSync(cache, { recursive: true, force: true })
    }
  })
}
const copy = to => ({ op: 'copy', path: 'source.txt', to })
const failure = code => ({ status: 'error', error: {
  code, phase: 'preflight', effectState: 'none', retryable: false, message: 'fixture: audit persistence failed',
} })

async function rejectsWithoutReference(api, args, code, projected = false) {
  const { value, call } = await api.call('batch', args, projected)
  const data = projected ? value.data : value
  assert.equal(call.native.error.code, code, 'the real native worker rejects before creating this job')
  assert.equal(call.native.error.phase, 'preflight')
  assert.equal(call.native.error.effectState, 'none')
  assert.equal(Object.hasOwn(call.native, 'detailsRef'), false)
  assert.deepEqual(api.records(call.request.job_id), [], 'there is no durable job for the allocated id')
  assert.equal((await api.page(call.request.job_id)).error.code, 'NOT_FOUND')
  assert.equal(data.error.code, code)
  assert.equal(Object.hasOwn(data, 'detailsRef'), false, 'a known preflight refusal must not invent an audit reference')
  assert.equal(Object.hasOwn(value, 'detailsRef'), false)
}

await test('overlapping batch paths omit an uncreated audit reference through the real host and worker', async () => {
  await withBridge(async api => {
    await rejectsWithoutReference(api, { action: 'plan', operations: [copy('a.txt'), copy('b.txt')] }, 'PATH_RESTRICTED')
    assert.equal(fs.existsSync(path.join(api.root, 'a.txt')), false)
  })
})

await test('invalid new batches omit audit references in the PTC definition and SDK outcome', async () => {
  await withBridge(api => rejectsWithoutReference(api, { action: 'run', operations: [] }, 'INVALID_ARGUMENT', true))
})

await test('credential preflight refuses a dummy credential file without inventing an audit reference', async () => {
  await withBridge(async api => {
    fs.writeFileSync(path.join(api.root, '.env'), 'DUMMY=fixture')
    await rejectsWithoutReference(api, { action: 'plan', operations: [{ op: 'copy', path: '.env', to: 'copy.txt' }] }, 'CREDENTIAL_DENIED')
  })
})

await test('expired operation references fail before a new audit job is created', async () => {
  await withBridge(async api => {
    // Legacy result snapshots have an expiry; this fixture never edits a user's audit store.
    const saved = envelopeOf(await callWorker(JSON.stringify(request('result',
      { action: 'put', items: [copy('expired.txt')] }, { root: api.root, scope: api.session.id }))), assert)
    const store = path.join(api.root, '.dsh-ops')
    const name = fs.readdirSync(store).filter(name => name.startsWith(saved.id + '.') && name.endsWith('.json')).sort().at(-1)
    const snapshot = JSON.parse(fs.readFileSync(path.join(store, name), 'utf8')); snapshot.expires = 1
    fs.writeFileSync(path.join(store, name), JSON.stringify(snapshot))
    await rejectsWithoutReference(api, { action: 'plan', operationsRef: saved.id }, 'REFERENCE_EXPIRED')
  })
})

await test('successful plan, run and resume keep real pageable audit references', async () => {
  await withBridge(async api => {
    const plan = (await api.call('batch', { action: 'plan', operations: [copy('planned.txt')] }, true)).value
    assert.equal(plan.status, 'completed'); assert.equal(plan.data.status, 'planned')
    assert.equal((await api.page(plan.data.detailsRef)).items.length, 1)
    assert.equal(fs.existsSync(path.join(api.root, 'planned.txt')), false, 'a plan has no business-file effects')
    const resumed = (await api.call('batch', { action: 'resume', id: plan.data.id }, true)).value
    assert.equal(resumed.status, 'completed'); assert.equal(resumed.data.detailsRef, plan.data.detailsRef)
    const run = (await api.call('batch', { action: 'run', operations: [copy('run.txt')] }, true)).value
    assert.equal(run.status, 'completed'); assert.equal((await api.page(run.data.detailsRef)).items[0].state, 'completed')
    assert.equal(fs.readFileSync(path.join(api.root, 'run.txt'), 'utf8'), 'original source\n')
  })
})

await test('a rejected resume retains the existing plan even when its error reports no effects', async () => {
  await withBridge(async api => {
    const plan = (await api.call('batch', { action: 'plan', operations: [copy('planned.txt')] })).value
    const rejected = (await api.call('batch', { action: 'resume', id: plan.id, protect: ['source.txt'] }, true)).value
    assert.equal(rejected.error.code, 'INVALID_ARGUMENT'); assert.equal(rejected.error.effectState, 'none')
    assert.equal(rejected.data.detailsRef, plan.detailsRef)
    assert.equal((await api.page(rejected.data.detailsRef)).items[0].state, 'pending')
    fs.writeFileSync(path.join(api.root, 'source.txt'), 'changed after planning')
    const failed = (await api.call('batch', { action: 'resume', id: plan.id }, true)).value
    assert.equal(failed.status, 'error'); assert.equal(failed.data.detailsRef, plan.detailsRef)
    assert.equal((await api.page(failed.data.detailsRef)).items[0].state, 'failed')
  })
})

await test('a synchronous failure before worker creation omits only newly allocated audit ids', async () => {
  await withBridge(async api => {
    api.fault('before-spawn')
    const fresh = await api.call('batch', { action: 'plan', operations: [copy('unstarted.txt')] }, true)
    assert.equal(fresh.call.started, false)
    assert.equal(fresh.value.error.effectState, 'none')
    assert.equal(Object.hasOwn(fresh.value.data, 'detailsRef'), false)
    const plan = (await api.call('batch', { action: 'plan', operations: [copy('planned.txt')] })).value
    api.fault('before-spawn')
    const resume = await api.call('batch', { action: 'resume', id: plan.id })
    assert.equal(resume.value.detailsRef, plan.detailsRef)
    assert.equal((await api.page(resume.value.detailsRef)).items[0].state, 'pending')
  })
})

await test('lost output after a real run preserves its recovery identity and completed audit', async () => {
  await withBridge(async api => {
    api.fault('lost-reply')
    const lost = await api.call('batch', { action: 'run', operations: [copy('settled.txt')] }, true)
    assert.equal(lost.call.native.status, 'completed', 'the real operation settled before the transport fault')
    assert.equal(lost.value.status, 'unknown'); assert.equal(lost.value.error.effectState, 'unknown')
    assert.equal(lost.value.data.detailsRef, lost.call.request.job_id)
    assert.equal((await api.page(lost.value.data.detailsRef)).items[0].state, 'completed')
    assert.equal(fs.readFileSync(path.join(api.root, 'settled.txt'), 'utf8'), 'original source\n')
  })
})

await test('ambiguous audit persistence errors retain a saved plan despite preflight and none fields', async () => {
  await withBridge(async api => {
    for (const code of ['IO_ERROR', 'OUTPUT_LIMIT', 'REVISION_CONFLICT', 'NOT_FOUND']) {
      api.fault(failure(code))
      const result = await api.call('batch', { action: 'plan', operations: [copy(code + '.txt')] }, true)
      assert.equal(result.call.native.status, 'planned', 'a real plan exists before the injected ambiguous reply')
      assert.equal(result.value.error.effectState, 'none')
      assert.equal(result.value.data.detailsRef, result.call.request.job_id)
      assert.equal((await api.page(result.value.data.detailsRef)).items[0].state, 'pending')
    }
  })
})

await test('an explicit worker audit reference is not replaced by a newly allocated id', async () => {
  await withBridge(async api => {
    const existing = (await api.call('batch', { action: 'plan', operations: [copy('existing.txt')] })).value
    api.fault({ ...failure('PATH_RESTRICTED'), detailsRef: existing.detailsRef })
    const result = await api.call('batch', { action: 'plan', operations: [copy('other.txt')] }, true)
    assert.notEqual(result.call.request.job_id, existing.detailsRef)
    assert.equal(result.value.data.detailsRef, existing.detailsRef)
    assert.equal((await api.page(result.value.data.detailsRef)).items[0].state, 'pending')
  })
})

report('ptc-audit-refs')
