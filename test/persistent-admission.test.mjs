/** New public mode's head-selection and state-loss facts over actual host identities. */
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { assert, test, report } from './lib/harness.mjs'
import { fixture, bounded } from './lib/resident-shell-admission.mjs'

const selection = source => ({ file: process.execPath, source })

await test('runtime selection happens at the native head and changes retire only the existing shell', async () => {
  let bash = selection('first')
  await fixture(async f => {
    const owner = await f.agent(), initial = await f.submit(owner)
    bash = selection('selected-before-head')
    assert.equal((await f.admit(initial)).decision, 'launch')
    assert.equal(f.preparations[0][0].source, 'selected-before-head')
    assert.equal((await f.finish(initial)).stateLost, undefined)
    const next = await f.submit(owner)
    bash = selection('changed-runtime')
    assert.equal((await f.admit(next, true)).decision, 'retire')
    assert.equal((await f.admit(next, false)).decision, 'launch')
    const result = await f.finish(next)
    assert.equal(result.shellState, 'preserved')
    assert.equal(result.stateLost, 'runtime-changed')
    assert.equal(f.preparations[1][0].source, 'changed-runtime')
    const following = await f.submit(owner)
    assert.equal((await f.admit(following, true)).decision, 'reuse')
    assert.equal((await f.finish(following)).stateLost, undefined)
  }, { admissionOptions: { selectBash: () => bash } })
})

await test('environment reset remains visible even though the replacement shell survives', async () => {
  await fixture(async f => {
    const owner = await f.agent(), initial = await f.submit(owner)
    await f.admit(initial); await f.finish(initial)
    f.state.environment = { PUBLIC_FIXTURE_VALUE: 'changed' }
    const next = await f.submit(owner)
    assert.equal((await f.admit(next, true)).decision, 'retire')
    assert.equal((await f.admit(next, false)).decision, 'launch')
    const result = await f.finish(next)
    assert.equal(result.stateLost, 'environment-changed')
    assert.equal(result.shellState, 'preserved')
  })
})

await test('control retirement preserves a queued request and reports its lost prior state', async () => {
  await fixture(async f => {
    const owner = await f.agent(), initial = await f.submit(owner)
    await f.admit(initial); await f.finish(initial)
    const queued = await f.submit(owner)
    const before = f.frames.length
    setSandboxMode(owner.agent.session, 'read-only')
    await f.message('shell.retire', before)
    assert.equal((await f.admit(queued, false)).decision, 'launch')
    const value = await f.finish(queued)
    assert.equal(value.stateLost, 'authority-changed')
    assert.equal(value.shellState, 'preserved')
    assert.equal(f.confinements.at(-1).policy.mode, 'read-only')
  })
})

await test('changing the selected runtime during approval refuses that head without launch', async () => {
  let bash = selection('before-approval')
  await fixture(async f => {
    const owner = await f.agent(), waiting = Promise.withResolvers(), asked = Promise.withResolvers()
    f.state.approval = () => { asked.resolve(); return waiting.promise }
    const call = await f.submit(owner, { sandbox_permissions: 'workspace-write', justification: 'Write this approved fixture.' })
    const admission = f.admit(call)
    await bounded(asked.promise, 'approval request')
    bash = selection('after-approval')
    waiting.resolve('allowed-once')
    const reply = await admission
    assert.equal(reply.decision, 'reject')
    assert.equal(reply.error.code, 'RUNTIME_CHANGED')
    assert.equal(f.preparations.length, 0)
    const value = await f.finish(call, { status: 'rejected', exitCode: null, effectState: 'none', shellState: 'reset', error: reply.error })
    assert.equal(value.effectState, 'none')
    assert.equal(f.approvals.length, 1)
  }, { mode: 'read-only', admissionOptions: { selectBash: () => bash } })
})

await test('cached publication guard is checked again when the native queue admits the request', async () => {
  let active = true
  await fixture(async f => {
    const owner = await f.agent(), call = await f.submit(owner, {}, undefined, () => active)
    active = false
    const reply = await f.admit(call)
    assert.equal(reply.decision, 'reject')
    assert.equal(reply.error.code, 'EXECUTOR_UNAVAILABLE')
    assert.equal(f.preparations.length, 0)
    assert.equal(f.approvals.length, 0)
    await f.finish(call, { status: 'rejected', exitCode: null, effectState: 'none', shellState: 'reset', error: reply.error })
  })
})

await test('local refusal leaves existing shell state unchanged and does not retire the owner', async () => {
  await fixture(async f => {
    const owner = await f.agent(), initial = await f.submit(owner)
    await f.admit(initial); await f.finish(initial)
    const before = f.frames.length
    const bad = await f.host.execute({ command: '' }, { agent: owner.agent })
    assert.equal(bad.shellState, 'unchanged')
    assert.equal(bad.effectState, 'none')
    assert.equal(f.frames.length, before)
    const next = await f.submit(owner)
    assert.equal((await f.admit(next, true)).decision, 'reuse')
    assert.equal((await f.finish(next)).stateLost, undefined)
  })
})

await test('temporary consumer withdrawal retires state without permanently disposing the actual Agent', async () => {
  let bash = selection('consumer')
  await fixture(async f => {
    const owner = await f.agent(), initial = await f.submit(owner)
    assert.equal(f.host.availableFor(owner.agent), true)
    await f.admit(initial); await f.finish(initial)
    const before = f.frames.length
    bash = undefined
    assert.equal(f.host.availableFor(owner.agent), false)
    f.host.reconcile()
    await f.message('shell.retire', before)
    bash = selection('consumer')
    assert.equal(f.host.availableFor(owner.agent), true)
    const restored = await f.submit(owner)
    assert.equal(restored.request.sessionKey, initial.request.sessionKey)
    assert.equal((await f.admit(restored)).decision, 'launch')
    assert.equal((await f.finish(restored)).stateLost, 'authority-changed')
  }, { admissionOptions: { selectBash: () => bash } })
})

await test('each admitted call retains exact confinement diagnostics and partial enforcement', async () => {
  await fixture(async f => {
    f.state.confinement = { enforcement: 'partial', denialSignatures: ['fixture access denied'] }
    const owner = await f.agent(), first = await f.submit(owner)
    await f.admit(first)
    // Provider-owned metadata can change after return; a live shell retains its launch snapshot.
    f.state.confinement.denialSignatures[0] = 'replacement signature'
    const stderr = 'fixture access denied'
    f.state.outputRead = async ({ requestId, stream, offset }) => {
      const bytes = Buffer.from(stream === 'stderr' ? stderr : '')
      return { type: 'shell.output', requestId, stream, offset, nextOffset: bytes.length, bytesBase64: bytes.toString('base64'), lossy: false, eof: true }
    }
    const initial = await f.finish(first, { exitCode: 1, stderrTotal: Buffer.byteLength(stderr) })
    assert.deepEqual(initial.sandbox, { mode: 'read-only', denied: true, enforcement: 'partial' })
    assert.equal(initial.denialObservation, 'detected')
    assert.equal(initial.effectState, 'unknown')
    assert.ok(initial.restriction)
    const next = await f.submit(owner)
    assert.equal((await f.admit(next, true)).decision, 'reuse')
    const reused = await f.finish(next, { exitCode: 1, stderrTotal: Buffer.byteLength(stderr) })
    assert.equal(reused.denialObservation, 'detected')
    assert.equal(f.confinements.length, 1)
  }, { mode: 'read-only' })
})

await test('missing signatures in truncated stderr never establish absence of denial', async () => {
  await fixture(async f => {
    f.state.confinement = { enforcement: 'partial', denialSignatures: ['fixture denied'] }
    const owner = await f.agent(), call = await f.submit(owner)
    await f.admit(call)
    f.state.outputRead = async ({ requestId, stream, offset }) => ({ type: 'shell.output', requestId, stream, offset,
      nextOffset: stream === 'stderr' ? 200000 : 0, bytesBase64: stream === 'stderr' ? Buffer.from('prefix').toString('base64') : '',
      lossy: stream === 'stderr', eof: true })
    const value = await f.finish(call, { exitCode: 1, stderrTotal: 200000 })
    assert.equal(value.denialObservation, 'incomplete')
    assert.equal(value.sandbox.enforcement, 'partial')
    assert.equal(value.stderr.lossy, true)
    assert.equal(value.effectState, 'unknown')
  }, { mode: 'read-only' })
})

await test('runner signature preserves native effects and never claims the command was unstarted', async () => {
  await fixture(async f => {
    f.state.confinement = { enforcement: 'full', runnerFailureRules: [{ fatalSignatures: ['fixture runner fatal'] }] }
    const owner = await f.agent(), call = await f.submit(owner)
    await f.admit(call)
    const stderr = 'fixture runner fatal'
    f.state.outputRead = async ({ requestId, stream, offset }) => {
      const bytes = Buffer.from(stream === 'stderr' ? stderr : '')
      return { type: 'shell.output', requestId, stream, offset, nextOffset: bytes.length, bytesBase64: bytes.toString('base64'), lossy: false, eof: true }
    }
    const value = await f.finish(call, { exitCode: 1, stderrTotal: Buffer.byteLength(stderr), effectState: 'unknown' })
    assert.equal(value.error.code, 'EXECUTOR_UNAVAILABLE')
    assert.equal(value.effectState, 'unknown')
    assert.equal(value.shellState, 'preserved')
    assert.equal(value.cleanupConfirmed, true)
    assert.doesNotMatch(value.error.message, /before the command|no effects/i)
  }, { mode: 'read-only' })
})

report('persistent-admission')
