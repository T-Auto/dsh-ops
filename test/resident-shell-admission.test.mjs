/** Real host ownership and policy over a scripted kernel-owned shell queue. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getSpillLedger } from '../lib/shells/spill-ledger.js'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { assert, test, report } from './lib/harness.mjs'
import { fixture, bounded, turn } from './lib/resident-shell-admission.mjs'

await test('the kernel owns FIFO admission and reads the current policy when a queued head arrives', async () => {
  await fixture(async f => {
    const owner = await f.agent()
    const first = await f.submit(owner, { command: 'printf first' })
    const second = await f.submit(owner, { command: 'printf second', timeoutMs: 2_147_483_647 })
    assert.equal(first.request.timeoutMs, 120_000)
    assert.equal(second.request.timeoutMs, 2_147_483_647)
    const beforeInvalid = f.frames.length
    const invalid = await f.host.execute({ command: 'printf invalid-timeout', timeoutMs: 2_147_483_648 },
      { agent: owner.agent, callId: 'over-maximum-timeout' })
    assert.equal(invalid.status, 'rejected')
    assert.equal(invalid.error.code, 'INVALID_ARGUMENT')
    assert.equal(invalid.effectState, 'none')
    assert.equal(f.frames.length, beforeInvalid)
    assert.equal(first.request.sessionKey, second.request.sessionKey)
    assert.notEqual(first.request.requestId, second.request.requestId)
    assert.equal(f.frames.filter(frame => frame.type === 'shell.execute').length, 2)
    assert.equal(f.frames.filter(frame => frame.type === 'shell.admission').length, 0)
    assert.equal(f.preparations.length, 0)
    assert.equal(f.confinements.length, 0)
    setSandboxMode(owner.agent.session, 'workspace-write')
    const admitted = await f.admit(first)
    assert.equal(admitted.decision, 'launch')
    assert.equal(f.confinements.at(-1).policy.mode, 'workspace-write')
    assert.equal(admitted.launch.cwd, f.directory)
    assert.equal(admitted.launch.env.NO_COLOR, '1')
    assert.equal(admitted.launch.env.TERM, 'dumb')
    assert.equal(admitted.launch.env.PAGER, 'cat')
    assert.equal(admitted.launch.env.LC_MESSAGES, 'C')
    assert.equal(admitted.launch.argv[0], process.execPath)
    assert.equal(admitted.launch.argv.includes(first.request.command), false)
    assert.deepEqual(admitted.launch.argv, f.confinements.at(-1).wrapped)
    assert.deepEqual(f.confinements.at(-1).argv.slice(1), ['--noprofile', '--norc', '-c', 'fixture-driver',
      f.bootstraps[0].commandPipe, f.bootstraps[0].receiptPipe])
    const result = await f.finish(first)
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.stdout, { text: '', bytesTotal: 0, lossy: false })
    assert.deepEqual(result.stderr, { text: '', bytesTotal: 0, lossy: false })
    assert.equal(f.frames.some(frame => frame.type === 'shell.release' && frame.requestId === first.request.requestId), true)
    assert.equal((await f.admit(second, true)).decision, 'reuse')
    await f.finish(second)
    assert.equal(f.preparations.length, 1)
  })
})

await test('a committed mode change retires old shell state while preserving the kernel queue', async () => {
  await fixture(async f => {
    const owner = await f.agent()
    const first = await f.submit(owner)
    assert.equal((await f.admit(first)).decision, 'launch')
    await f.finish(first)
    const asked = Promise.withResolvers(), grant = Promise.withResolvers()
    f.state.approval = request => { asked.resolve(request); return grant.promise }
    const head = await f.submit(owner, { sandbox_permissions: 'danger-full-access', justification: 'Pending head approval.' })
    const queued = await f.submit(owner)
    f.emit({ type: 'shell.admit', requestId: head.request.requestId, hasShell: true })
    await bounded(asked.promise, 'approval at the active queue head')
    const start = f.frames.length
    setSandboxMode(owner.agent.session, 'read-only')
    const retired = await f.message('shell.retire', start)
    assert.equal(retired.sessionKey, queued.request.sessionKey)
    grant.resolve('allowed-once')
    await turn()
    assert.equal(f.frames.slice(start).some(frame => frame.type === 'shell.admission' && frame.requestId === head.request.requestId), false)
    assert.equal(f.frames.slice(start).some(frame => frame.type === 'cancel' && frame.requestId === queued.request.requestId), false)
    assert.equal(f.aborts.length, 0)
    f.complete(head.request, { status: 'cancelled', exitCode: null, effectState: 'none', shellState: 'reset',
      error: { code: 'CANCELLED', message: 'Native retired the approval-pending head.' } })
    assert.equal((await head.result).effectState, 'none')
    assert.equal(f.frames.filter(frame => frame.type === 'shell.execute').length, 3)
    const admitted = await f.admit(queued)
    assert.equal(admitted.decision, 'launch')
    assert.equal(f.confinements.at(-1).policy.mode, 'read-only')
    assert.equal((await f.finish(queued)).status, 'completed')
  }, { mode: 'workspace-write' })
})

await test('policy changes during delayed approval reject the queued command without effects', async () => {
  await fixture(async f => {
    const owner = await f.agent(), grant = Promise.withResolvers(), asked = Promise.withResolvers()
    f.state.approval = request => { asked.resolve(request); return grant.promise }
    const call = await f.submit(owner, { sandbox_permissions: 'danger-full-access', justification: 'Fixture escalation.' })
    assert.equal(f.approvals.length, 0, 'approval belongs to the kernel-admitted head')
    const admission = f.admit(call)
    const request = await bounded(asked.promise, 'approval request')
    assert.equal(request.agent, owner.agent)
    setSandboxMode(owner.agent.session, 'workspace-write')
    grant.resolve('allowed-once')
    const rejected = await admission
    assert.equal(rejected.decision, 'reject')
    assert.equal(rejected.error.code, 'AUTHORITY_CHANGED')
    assert.equal(f.preparations.length, 0)
    assert.equal(f.confinements.length, 0)
    f.complete(call.request, { status: 'rejected', exitCode: null, effectState: 'none', shellState: 'reset', error: rejected.error })
    const value = await bounded(call.result, 'rejected command')
    assert.equal(value.status, 'rejected')
    assert.equal(value.effectState, 'none')
  }, { mode: 'read-only' })
})

await test('allowed-once widening closes its shell and is never inherited by the next call', async () => {
  await fixture(async f => {
    const owner = await f.agent()
    const widened = await f.submit(owner, { sandbox_permissions: 'danger-full-access', justification: 'One command only.' })
    const launch = await f.admit(widened)
    assert.equal(launch.decision, 'launch')
    assert.equal(launch.closeAfter, true)
    assert.equal(f.approvals.length, 1)
    assert.equal(f.confinements.length, 0)
    await f.finish(widened, { shellState: 'reset' })
    assert.equal(f.ctx.get('sandboxPolicy').resolve({ session: owner.agent.session }).mode, 'workspace-write')
    const ordinary = await f.submit(owner)
    assert.equal((await f.admit(ordinary)).decision, 'launch')
    assert.equal(f.confinements.at(-1).policy.mode, 'workspace-write')
    await f.finish(ordinary)
    const nextGrant = await f.submit(owner, { sandbox_permissions: 'danger-full-access', justification: 'A separate command.' })
    const retired = await f.admit(nextGrant, true)
    assert.equal(retired.decision, 'retire')
    const separate = await f.admit(nextGrant)
    assert.equal(separate.decision, 'launch')
    assert.equal(separate.closeAfter, true)
    assert.equal(f.approvals.length, 2)
    await f.finish(nextGrant, { shellState: 'reset' })
  }, { mode: 'workspace-write' })
})

await test('reuse omits cwd recovery and passes explicit cwd to the existing shell', async () => {
  await fixture(async f => {
    const owner = await f.agent(), child = path.join(f.directory, 'child')
    fs.mkdirSync(child)
    const first = await f.submit(owner)
    assert.equal((await f.admit(first)).decision, 'launch')
    await f.finish(first)
    const ensures = f.state.ensureCalls
    f.state.directoryError = new Error('Reuse must preserve the live shell directory without recovery')
    const reused = await f.submit(owner)
    const reuse = await f.admit(reused, true)
    assert.equal(reuse.decision, 'reuse')
    assert.equal(reuse.commandCwd, undefined)
    assert.equal(f.state.ensureCalls, ensures)
    await f.finish(reused)
    f.state.directoryError = undefined
    const explicit = await f.submit(owner, { workdir: child })
    const changed = await f.admit(explicit, true)
    assert.equal(changed.decision, 'reuse')
    assert.equal(changed.commandCwd, child)
    await f.finish(explicit)
    const following = await f.submit(owner)
    const followingAdmission = await f.admit(following, true)
    assert.equal(followingAdmission.decision, 'reuse')
    assert.equal(followingAdmission.commandCwd, undefined)
    await f.finish(following)
    assert.equal(f.preparations.length, 1)
  })
})

await test('Agent disposal awaits its close receipt while a sibling continues on the same host', async () => {
  await fixture(async f => {
    const first = await f.agent(), sibling = await f.agent()
    const firstCall = await f.submit(first), siblingCall = await f.submit(sibling)
    assert.notEqual(firstCall.request.sessionKey, siblingCall.request.sessionKey)
    assert.equal((await f.admit(firstCall)).decision, 'launch')
    assert.equal((await f.admit(siblingCall)).decision, 'launch')
    await f.finish(firstCall); await f.finish(siblingCall)
    const start = f.frames.length
    let disposed = false
    const disposal = first.dispose().then(() => { disposed = true })
    const close = await f.message('shell.close', start, frame => frame.sessionKey === firstCall.request.sessionKey)
    await turn()
    assert.equal(disposed, false)
    const another = await f.submit(sibling)
    assert.equal((await f.admit(another, true)).decision, 'reuse')
    assert.equal((await f.finish(another)).status, 'completed')
    assert.equal(f.frames.slice(start).some(frame => frame.type === 'shell.close' && frame.sessionKey === siblingCall.request.sessionKey), false)
    f.acknowledge(close)
    await bounded(disposal, 'first Agent disposal')
    assert.equal(disposed, true)
  })
})

await test('the owning Cordis plugin awaits kernel cleanup before disposal completes', async () => {
  await fixture(async f => {
    const owner = await f.agent(), call = await f.submit(owner)
    assert.equal((await f.admit(call)).decision, 'launch')
    await f.finish(call)
    let disposed = false
    const start = f.frames.length
    const disposal = f.owner.dispose().then(() => { disposed = true })
    const close = await f.message('shell.close', start)
    await turn()
    assert.equal(disposed, false)
    f.acknowledge(close)
    await bounded(disposal, 'admission owner disposal')
    assert.equal(disposed, true)
  })
})

await test('a pre-aborted call never enters the kernel queue', async () => {
  await fixture(async f => {
    const owner = await f.agent(), cancellation = new AbortController()
    cancellation.abort(new DOMException('Fixture cancelled before enqueue', 'AbortError'))
    const result = await f.host.execute({ command: 'printf forbidden' }, {
      agent: owner.agent, signal: cancellation.signal, callId: 'pre-aborted',
    })
    assert.equal(result.status, 'rejected')
    assert.equal(result.effectState, 'none')
    assert.equal(result.error.code, 'CANCELLED')
    assert.equal(f.frames.length, 0)
    assert.equal(f.preparations.length, 0)
  })
})

await test('a queued abort sends cancel and waits for the kernel completion receipt', async () => {
  await fixture(async f => {
    const owner = await f.agent(), cancellation = new AbortController()
    const call = await f.submit(owner, {}, cancellation.signal)
    let settled = false
    void call.result.then(() => { settled = true })
    const start = f.frames.length
    cancellation.abort(new DOMException('Fixture queued cancellation', 'AbortError'))
    const cancelled = await f.message('cancel', start)
    assert.equal(cancelled.requestId, call.request.requestId)
    await turn()
    assert.equal(settled, false)
    assert.deepEqual(f.frames.slice(start), [{ type: 'cancel', requestId: call.request.requestId }])
    assert.equal(f.preparations.length, 0)
    f.complete(call.request, { status: 'cancelled', exitCode: null, effectState: 'none', shellState: 'reset' })
    const result = await bounded(call.result, 'kernel cancellation receipt')
    assert.equal(result.status, 'cancelled')
    assert.equal(result.effectState, 'none')
    assert.equal(result.cleanupConfirmed, true)
  })
})

await test('cancellation during approval ignores a grant arriving after kernel completion', async () => {
  await fixture(async f => {
    const owner = await f.agent(), cancellation = new AbortController()
    const asked = Promise.withResolvers(), grant = Promise.withResolvers()
    f.state.approval = request => { asked.resolve(request); return grant.promise }
    const call = await f.submit(owner, { sandbox_permissions: 'danger-full-access', justification: 'Cancelled approval.' }, cancellation.signal)
    f.emit({ type: 'shell.admit', requestId: call.request.requestId, hasShell: false,
      bootstrap: { commandPipe: 'fixture-command', receiptPipe: 'fixture-receipt' } })
    await bounded(asked.promise, 'pending approval')
    const start = f.frames.length
    cancellation.abort(new DOMException('Fixture cancelled during approval', 'AbortError'))
    assert.equal((await f.message('cancel', start)).requestId, call.request.requestId)
    f.complete(call.request, { status: 'cancelled', exitCode: null, effectState: 'none', shellState: 'reset' })
    assert.equal((await bounded(call.result, 'cancelled approval result')).effectState, 'none')
    grant.resolve('allowed-once')
    await turn()
    assert.equal(f.frames.some(frame => frame.type === 'shell.admission' && frame.requestId === call.request.requestId), false)
    assert.equal(f.preparations.length, 0)
    assert.equal(f.confinements.length, 0)
  }, { mode: 'read-only' })
})

await test('an environment baseline change retires old state without exposing its values in diagnostics', async () => {
  await fixture(async f => {
    const owner = await f.agent(), before = 'fixture-env-before-private', after = 'fixture-env-after-private'
    f.state.environment = { RESIDENT_ADMISSION_FIXTURE_VALUE: before }
    const first = await f.submit(owner)
    const initial = await f.admit(first)
    assert.equal(initial.launch.env.RESIDENT_ADMISSION_FIXTURE_VALUE, before)
    await f.finish(first)
    const next = await f.submit(owner)
    f.state.environment = { RESIDENT_ADMISSION_FIXTURE_VALUE: after }
    const retired = await f.admit(next, true)
    assert.deepEqual(retired, { type: 'shell.admission', requestId: next.request.requestId, decision: 'retire' })
    const fresh = await f.admit(next)
    assert.equal(fresh.decision, 'launch')
    assert.equal(fresh.launch.env.RESIDENT_ADMISSION_FIXTURE_VALUE, after)
    await f.finish(next)
    assert.equal(f.logs.some(log => log.includes(before) || log.includes(after)), false, 'Environment values must not appear in logs')
  })
})

for (const cleanupConfirmed of [true, false]) {
  await test(`transport loss preserves ${cleanupConfirmed ? 'confirmed' : 'unconfirmed'} cleanup and never sends to the dead kernel`, async () => {
    await fixture(async f => {
      const owner = await f.agent(), call = await f.submit(owner)
      assert.equal((await f.admit(call)).decision, 'launch')
      f.emit({ type: 'shell.started', requestId: call.request.requestId })
      f.transport.available = false
      const start = f.frames.length
      f.emit({ type: 'shell.unavailable', cleanupConfirmed,
        error: { code: 'EXECUTOR_UNAVAILABLE', message: 'Fixture kernel transport lost; cleanup observation retained.' } })
      const result = await bounded(call.result, 'lost transport result')
      assert.equal(result.status, 'failed')
      assert.equal(result.error.code, 'EXECUTOR_UNAVAILABLE')
      assert.equal(result.effectState, 'unknown')
      assert.equal(result.cleanupConfirmed, cleanupConfirmed)
      if (cleanupConfirmed) await bounded(f.host.dispose(), 'confirmed transport-loss cleanup')
      else {
        f.state.expectedCleanupFailure = true
        await assert.rejects(bounded(f.host.dispose(), 'unconfirmed transport-loss cleanup'), /Fixture kernel transport lost/)
      }
      assert.deepEqual(f.frames.slice(start), [])
      const refused = await f.host.execute({ command: 'printf forbidden' }, { agent: owner.agent, callId: 'after-loss' })
      assert.equal(refused.effectState, 'none')
      assert.equal(refused.status, 'rejected')
      assert.deepEqual(f.frames.slice(start), [])
    })
  })
}

await test('a failed admission reply waits for transport cleanup instead of abandoning the kernel head', async () => {
  await fixture(async f => {
    const owner = await f.agent(), aborted = Promise.withResolvers()
    const call = await f.submit(owner)
    let settled = false
    void call.result.then(() => { settled = true })
    f.state.sendFailure = frame => frame.type === 'shell.admission'
    f.state.onAbort = error => aborted.resolve(error)
    f.emit({ type: 'shell.admit', requestId: call.request.requestId, hasShell: false,
      bootstrap: { commandPipe: 'fixture-command', receiptPipe: 'fixture-receipt' } })
    assert.match((await bounded(aborted.promise, 'admission transport abort')).message, /Fixture control write rejected/)
    await turn()
    assert.equal(settled, false)
    assert.equal(f.aborts.length, 1)
    assert.equal(f.frames.some(frame => frame.type === 'shell.admission'), false)
    f.emit({ type: 'shell.unavailable', cleanupConfirmed: true,
      error: { code: 'EXECUTOR_UNAVAILABLE', message: 'Fixture transport failure joined its range.' } })
    const result = await bounded(call.result, 'failed admission cleanup receipt')
    assert.equal(result.status, 'failed')
    assert.equal(result.effectState, 'unknown')
    assert.equal(result.cleanupConfirmed, true)
  })
})

await test('disposal joins a delayed sibling close even when another owner cleanup fails', async () => {
  await fixture(async f => {
    const first = await f.agent(), sibling = await f.agent()
    const a = await f.submit(first), b = await f.submit(sibling)
    await f.admit(a); await f.finish(a)
    await f.admit(b); await f.finish(b)
    const start = f.frames.length
    let settled = false
    const disposal = f.host.dispose()
    void disposal.then(() => { settled = true }, () => { settled = true })
    const firstClose = await f.message('shell.close', start, frame => frame.sessionKey === a.request.sessionKey)
    const siblingClose = await f.message('shell.close', start, frame => frame.sessionKey === b.request.sessionKey)
    f.state.expectedCleanupFailure = true
    f.emit({ type: 'shell.closed', requestId: firstClose.requestId, cleanupConfirmed: false,
      error: { code: 'EXECUTOR_UNAVAILABLE', message: 'Fixture first owner cleanup failed.' } })
    await turn()
    assert.equal(settled, false)
    f.acknowledge(siblingClose)
    await assert.rejects(bounded(disposal, 'all owner cleanup'), /Fixture first owner cleanup failed/)
    assert.equal(settled, true)
  })
})

await test('32 idle owners consume the owner budget and disposal joins every close', async () => {
  await fixture(async f => {
    for (let index = 0; index < 32; index++) {
      const owner = await f.agent(), call = await f.submit(owner)
      assert.equal((await f.admit(call)).decision, 'launch')
      await f.finish(call)
    }
    const extra = await f.agent(), start = f.frames.length
    const refused = await f.host.execute({ command: 'printf overflow' }, { agent: extra.agent, callId: 'idle-owner-overflow' })
    assert.equal(refused.status, 'rejected')
    assert.equal(refused.error.code, 'EXECUTOR_BUSY')
    assert.equal(refused.effectState, 'none')
    assert.equal(f.frames.length, start, 'The 33rd owner never enters the kernel')
    let disposed = false
    const disposal = f.host.dispose().then(() => { disposed = true })
    await turn()
    const closes = f.frames.slice(start).filter(frame => frame.type === 'shell.close')
    assert.equal(closes.length, 32)
    assert.equal(new Set(closes.map(frame => frame.sessionKey)).size, 32)
    for (const close of closes.slice(0, -1)) f.acknowledge(close)
    await turn()
    assert.equal(disposed, false)
    f.acknowledge(closes.at(-1))
    await bounded(disposal, 'all 32 idle owners')
    assert.equal(disposed, true)
  })
})

await test('terminal collection copies both streams before release and before the result settles', async () => {
  await fixture(async f => {
    const owner = await f.agent(), call = await f.submit(owner)
    await f.admit(call)
    const stdout = Buffer.from('out snowman ☃\n'), stderr = Buffer.from('stderr: 不同\n')
    const split = stdout.indexOf(Buffer.from('☃')) + 1
    const outGate = Promise.withResolvers(), errGate = Promise.withResolvers()
    const outAsked = Promise.withResolvers(), errAsked = Promise.withResolvers()
    const reply = (request, bytes, eof) => ({ type: 'shell.output', requestId: request.requestId, stream: request.stream,
      offset: request.offset, nextOffset: request.offset + bytes.length, bytesBase64: bytes.toString('base64'), lossy: false, eof })
    f.state.outputRead = async request => {
      if (request.stream === 'stderr') { errAsked.resolve(); await errGate.promise; return reply(request, stderr, true) }
      if (request.offset === 0) return reply(request, stdout.subarray(0, split), false)
      assert.equal(request.offset, split)
      outAsked.resolve(); await outGate.promise
      return reply(request, stdout.subarray(split), true)
    }
    let settled = false
    const completion = f.finish(call, { stdoutTotal: stdout.length, stderrTotal: stderr.length })
    void completion.then(() => { settled = true })
    await bounded(Promise.all([outAsked.promise, errAsked.promise]), 'both output streams')
    assert.equal(settled, false)
    assert.equal(f.frames.some(frame => frame.type === 'shell.release'), false)
    outGate.resolve(); await turn()
    assert.equal(settled, false, 'The stderr copy still owns the terminal record')
    assert.equal(f.frames.some(frame => frame.type === 'shell.release'), false)
    errGate.resolve()
    const result = await completion
    assert.deepEqual(result.stdout, { text: stdout.toString('utf8'), bytesTotal: stdout.length, lossy: false })
    assert.deepEqual(result.stderr, { text: stderr.toString('utf8'), bytesTotal: stderr.length, lossy: false })
    assert.equal(f.frames.filter(frame => frame.type === 'shell.release' && frame.requestId === call.request.requestId).length, 1)
    assert.equal(f.reads.filter(read => read.stream === 'stdout').length, 2)
    assert.equal(f.reads.filter(read => read.stream === 'stderr').length, 1)
  })
})

for (const [label, total, bytes] of [['premature EOF', 3, Buffer.from('a')], ['cursor beyond total', 1, Buffer.from('ab')]]) {
  await test(`contradictory terminal output ${label} aborts and waits for joined cleanup`, async () => {
    await fixture(async f => {
      const owner = await f.agent(), call = await f.submit(owner), aborted = Promise.withResolvers()
      await f.admit(call)
      f.state.onAbort = error => aborted.resolve(error)
      f.state.outputRead = request => {
        const data = request.stream === 'stdout' ? bytes : Buffer.alloc(0)
        return { type: 'shell.output', requestId: request.requestId, stream: request.stream, offset: request.offset,
          nextOffset: request.offset + data.length, bytesBase64: data.toString('base64'), lossy: false, eof: true }
      }
      let settled = false
      const completion = f.finish(call, { stdoutTotal: total })
      void completion.then(() => { settled = true })
      assert.match((await bounded(aborted.promise, 'contradictory terminal abort')).message, /terminal receipt/)
      await turn()
      assert.equal(settled, false)
      assert.equal(f.frames.some(frame => frame.type === 'shell.release'), false)
      f.emit({ type: 'shell.unavailable', cleanupConfirmed: true,
        error: { code: 'EXECUTOR_UNAVAILABLE', message: 'Contradictory output transport joined its range.' } })
      const result = await completion
      assert.equal(result.status, 'failed')
      assert.equal(result.effectState, 'unknown')
      assert.equal(result.cleanupConfirmed, true)
      assert.equal(result.stdout.lossy, true)
      assert.equal(f.frames.some(frame => frame.type === 'shell.release'), false)
    })
  })
}

await test('withdrawing the real Cordis sandbox provider awaits dependent shell cleanup', async () => {
  await fixture(async f => {
    const owner = await f.agent(), call = await f.submit(owner)
    assert.equal((await f.admit(call)).decision, 'launch')
    await f.finish(call)
    const start = f.frames.length
    let disposed = false
    const withdrawal = f.sandboxProvider.dispose().then(() => { disposed = true })
    const close = await f.message('shell.close', start, frame => frame.sessionKey === call.request.sessionKey)
    await turn()
    assert.equal(disposed, false, 'Authority provider disposal must join the dependent shell owner')
    assert.equal(f.ctx.get('opsShellAdmission'), undefined, 'The withdrawing owner cannot remain publicly available')
    const retained = await f.host.execute({ command: 'printf forbidden' }, { agent: owner.agent, callId: 'withdrawn-provider' })
    assert.equal(retained.status, 'rejected')
    assert.equal(retained.effectState, 'none')
    assert.equal(f.frames.slice(start).some(frame => frame.type === 'shell.execute'), false)
    f.acknowledge(close)
    await bounded(withdrawal, 'sandbox provider withdrawal')
    assert.equal(disposed, true)
    assert.equal(f.ctx.get('sandbox'), undefined)
    assert.equal(f.ctx.get('opsShellAdmission'), undefined)
  }, { providerOwned: true })
})

await test('a capture error retains bytes and joins the other stream without aborting sibling sessions', async () => {
  for (const nativeError of [undefined, { code: 'COMMAND_FAILED', message: 'The command failed before capture ended.' }]) {
    await fixture(async f => {
      const owner = await f.agent(), sibling = await f.agent(), call = await f.submit(owner)
      await f.admit(call)
      const captureError = { code: 'OUTPUT_FAILED', message: 'Fixture output capture became unavailable.' }
      const stderr = Buffer.from('distinct stderr\n'), stderrGate = Promise.withResolvers(), stderrAsked = Promise.withResolvers()
      f.state.outputRead = async request => {
        let bytes = Buffer.alloc(0), error, eof = true
        if (request.requestId === call.request.requestId) {
          if (request.stream === 'stdout') { bytes = Buffer.from('part'); error = captureError; eof = false }
          else { stderrAsked.resolve(); await stderrGate.promise; bytes = stderr }
        }
        return { type: 'shell.output', requestId: request.requestId, stream: request.stream, offset: request.offset,
          nextOffset: request.offset + bytes.length, bytesBase64: bytes.toString('base64'), lossy: false, eof, ...(error ? { error } : {}) }
      }
      let settled = false
      const completion = f.finish(call, { stdoutTotal: 10, stderrTotal: stderr.length,
        ...(nativeError ? { status: 'failed', exitCode: 42, error: nativeError } : {}) })
      void completion.then(() => { settled = true })
      await bounded(stderrAsked.promise, 'capture sibling stream')
      await turn()
      assert.equal(settled, false)
      assert.equal(f.frames.some(frame => frame.type === 'shell.release' && frame.requestId === call.request.requestId), false)
      assert.equal(f.aborts.length, 0)
      const other = await f.submit(sibling)
      assert.equal((await f.admit(other)).decision, 'launch')
      assert.equal((await f.finish(other)).status, 'completed')
      stderrGate.resolve()
      const result = await completion
      assert.equal(result.status, 'failed')
      assert.deepEqual(result.error, nativeError ?? captureError)
      assert.deepEqual(result.stdout, { text: 'part', bytesTotal: 10, lossy: true, error: captureError })
      assert.deepEqual(result.stderr, { text: stderr.toString(), bytesTotal: stderr.length, lossy: false })
      assert.equal(f.frames.filter(frame => frame.type === 'shell.release' && frame.requestId === call.request.requestId).length, 1)
      assert.equal(f.aborts.length, 0)
      assert.equal(f.transport.available, true)
    })
  }
})

await test('an older reset completion cannot erase the next shell while its output drain is pending', async () => {
  await fixture(async f => {
    const owner = await f.agent(), first = await f.submit(owner)
    assert.equal((await f.admit(first)).decision, 'launch')
    const tails = Promise.withResolvers(), readersStarted = Promise.withResolvers()
    let readers = 0, firstSettled = false
    f.state.outputRead = async request => {
      if (request.requestId === first.request.requestId) {
        if (++readers === 2) readersStarted.resolve()
        await tails.promise
      }
      return { type: 'shell.output', requestId: request.requestId, stream: request.stream,
        offset: request.offset, nextOffset: request.offset, bytesBase64: '', lossy: false, eof: true }
    }
    const firstCompletion = f.finish(first, { shellState: 'reset' })
    void firstCompletion.then(() => { firstSettled = true })
    await bounded(readersStarted.promise, 'older reset output readers')
    assert.equal(firstSettled, false)
    const second = await f.submit(owner)
    assert.equal((await f.admit(second)).decision, 'launch')
    assert.equal((await f.finish(second)).shellState, 'preserved')
    assert.equal(firstSettled, false)
    tails.resolve()
    assert.equal((await firstCompletion).shellState, 'reset')
    const third = await f.submit(owner)
    assert.equal((await f.admit(third, true)).decision, 'reuse', 'The old output drain must not erase the newer launch facts')
    await f.finish(third)
    assert.equal(f.preparations.length, 2)
  })
})

await test('a locally refused enqueue preserves the existing shell launch facts', async () => {
  await fixture(async f => {
    const owner = await f.agent(), first = await f.submit(owner)
    assert.equal((await f.admit(first)).decision, 'launch')
    await f.finish(first)
    const start = f.frames.length
    f.state.sendFailure = frame => frame.type === 'shell.execute'
    const refused = await f.host.execute({ command: 'printf not-enqueued' }, { agent: owner.agent, callId: 'local-enqueue-refusal' })
    assert.equal(refused.status, 'rejected')
    assert.equal(refused.effectState, 'none')
    assert.equal(f.frames.length, start)
    assert.equal(f.aborts.length, 0)
    f.state.sendFailure = undefined
    const next = await f.submit(owner)
    assert.equal((await f.admit(next, true)).decision, 'reuse')
    await f.finish(next)
    assert.equal(f.preparations.length, 1)
  })
})

await test('native cancellation suppresses a late approval while terminal output still drains', async () => {
  await fixture(async f => {
    const owner = await f.agent(), asked = Promise.withResolvers(), grant = Promise.withResolvers()
    const tails = Promise.withResolvers(), readersStarted = Promise.withResolvers()
    let readers = 0, settled = false
    f.state.approval = request => { asked.resolve(request); return grant.promise }
    const call = await f.submit(owner, { sandbox_permissions: 'danger-full-access', justification: 'Native-cancelled approval.' })
    void call.result.then(() => { settled = true })
    f.emit({ type: 'shell.admit', requestId: call.request.requestId, hasShell: false,
      bootstrap: { commandPipe: 'fixture-command', receiptPipe: 'fixture-receipt' } })
    await bounded(asked.promise, 'approval before native cancellation')
    f.state.outputRead = async request => {
      if (++readers === 2) readersStarted.resolve()
      await tails.promise
      return { type: 'shell.output', requestId: request.requestId, stream: request.stream,
        offset: request.offset, nextOffset: request.offset, bytesBase64: '', lossy: false, eof: true }
    }
    const start = f.frames.length
    f.complete(call.request, { status: 'cancelled', exitCode: null, effectState: 'none', shellState: 'reset',
      error: { code: 'CANCELLED', message: 'Native queue retired the head before execution.' } })
    await bounded(readersStarted.promise, 'native-cancelled output readers')
    grant.resolve('allowed-once')
    await turn()
    assert.equal(settled, false)
    assert.equal(f.frames.slice(start).some(frame => frame.type === 'shell.admission' || frame.type === 'cancel'), false)
    assert.equal(f.aborts.length, 0)
    assert.equal(f.preparations.length, 0)
    assert.equal(f.confinements.length, 0)
    tails.resolve()
    const result = await bounded(call.result, 'native-cancelled final output')
    assert.equal(result.status, 'cancelled')
    assert.equal(result.effectState, 'none')
    assert.equal(f.frames.filter(frame => frame.type === 'shell.release' && frame.requestId === call.request.requestId).length, 1)
    assert.equal(f.aborts.length, 0)
  }, { mode: 'read-only' })
})

await test('queued admission snapshots the original Agent and call identity before caller mutation', async () => {
  await fixture(async f => {
    const siblingDirectory = path.join(f.directory, 'other-session')
    fs.mkdirSync(siblingDirectory)
    const original = await f.agent(), sibling = await f.agent(siblingDirectory)
    const shared = { agent: original.agent, callId: 'original-call-id', signal: new AbortController().signal }
    const start = f.frames.length
    const result = f.host.execute({ command: 'printf original-owner', sandbox_permissions: 'danger-full-access',
      justification: 'Approve this original session only.' }, shared)
    const request = await f.message('shell.execute', start)
    shared.agent = sibling.agent
    shared.callId = 'mutated-call-id'
    const admitted = await f.admit({ request, result })
    assert.equal(admitted.decision, 'launch')
    assert.equal(admitted.closeAfter, true)
    assert.equal(f.approvals.length, 1)
    assert.equal(f.approvals[0].agent, original.agent)
    assert.equal(f.approvals[0].callId, 'original-call-id')
    assert.equal(f.environmentCalls.length, 1)
    assert.equal(f.environmentCalls[0].agent, original.agent)
    assert.equal(f.environmentCalls[0].callId, 'original-call-id')
    assert.equal(admitted.launch.cwd, original.agent.session.header.cwd)
    assert.notEqual(admitted.launch.cwd, sibling.agent.session.header.cwd)
    assert.equal((await f.finish({ request, result }, { shellState: 'reset' })).status, 'completed')
  }, { mode: 'read-only' })
})

await test('caller cancellation suppresses approval replies before the native terminal receipt', async () => {
  await fixture(async f => {
    const owner = await f.agent(), cancellation = new AbortController()
    const asked = Promise.withResolvers(), grant = Promise.withResolvers()
    f.state.approval = request => { asked.resolve(request); return grant.promise }
    const call = await f.submit(owner, { sandbox_permissions: 'danger-full-access', justification: 'Cancelled queue head.' }, cancellation.signal)
    f.emit({ type: 'shell.admit', requestId: call.request.requestId, hasShell: false,
      bootstrap: { commandPipe: 'fixture-command', receiptPipe: 'fixture-receipt' } })
    await bounded(asked.promise, 'approval before caller cancellation')
    let settled = false
    void call.result.then(() => { settled = true })
    const start = f.frames.length
    cancellation.abort(new DOMException('Fixture caller cancellation', 'AbortError'))
    assert.equal((await f.message('cancel', start)).requestId, call.request.requestId)
    grant.resolve('allowed-once')
    await turn()
    assert.equal(settled, false)
    assert.equal(f.frames.slice(start).some(frame => frame.type === 'shell.admission'), false)
    assert.equal(f.aborts.length, 0)
    assert.equal(f.preparations.length, 0)
    f.complete(call.request, { status: 'cancelled', exitCode: null, effectState: 'none', shellState: 'reset',
      error: { code: 'CANCELLED', message: 'Native joined the cancelled head.' } })
    const result = await bounded(call.result, 'caller cancellation terminal')
    assert.equal(result.status, 'cancelled')
    assert.equal(result.effectState, 'none')
    assert.equal(f.aborts.length, 0)
  }, { mode: 'read-only' })
})

await test('failed retirement closes only that owner and refuses reuse until cleanup is joined', async () => {
  await fixture(async f => {
    const owner = await f.agent(), sibling = await f.agent()
    const first = await f.submit(owner), other = await f.submit(sibling)
    await f.admit(first); await f.finish(first)
    await f.admit(other); await f.finish(other)
    f.state.autoRetire = false
    const start = f.frames.length
    setSandboxMode(owner.agent.session, 'read-only')
    const retire = await f.message('shell.retire', start)
    f.emit({ type: 'shell.closed', requestId: retire.requestId, cleanupConfirmed: false,
      error: { code: 'EXECUTOR_UNAVAILABLE', message: 'Fixture retirement cleanup failed.' } })
    const close = await f.message('shell.close', start, frame => frame.sessionKey === first.request.sessionKey)
    const beforeRefusal = f.frames.length
    const refused = await f.host.execute({ command: 'printf forbidden-reuse' }, { agent: owner.agent, callId: 'failed-retirement' })
    assert.equal(refused.status, 'rejected')
    assert.equal(refused.effectState, 'none')
    assert.equal(f.frames.length, beforeRefusal)
    const next = await f.submit(sibling)
    assert.equal((await f.admit(next, true)).decision, 'reuse')
    assert.equal((await f.finish(next)).status, 'completed')
    assert.equal(f.frames.slice(start).some(frame => frame.type === 'shell.close' && frame.sessionKey === other.request.sessionKey), false)
    assert.equal(f.aborts.length, 0)
    f.acknowledge(close)
    await bounded(owner.dispose(), 'failed retirement owner close')
  })
})

await test('startup script variables reject before approval or runtime without disclosing their values', async () => {
  await fixture(async f => {
    const owner = await f.agent(), value = 'fixture-private-startup-script'
    for (const name of ['NIU_ENV', 'nIu_eNv', 'BASH_ENV', 'bAsH_eNv', 'ENV', 'eNv']) {
      f.state.environment = { [name]: value }
      const call = await f.submit(owner, { sandbox_permissions: 'danger-full-access', justification: 'Must never request approval.' })
      const admission = await f.admit(call)
      assert.equal(admission.decision, 'reject')
      assert.equal(admission.error.code, 'UNSUPPORTED_STARTUP_ENV')
      assert.equal(admission.error.message.includes(name), true)
      assert.equal(admission.error.message.includes(value), false)
      assert.equal(f.approvals.length, 0)
      assert.equal(f.preparations.length, 0)
      assert.equal(f.confinements.length, 0)
      assert.equal(f.bootstraps.length, 0)
      f.complete(call.request, { status: 'rejected', exitCode: null, effectState: 'none', shellState: 'reset', error: admission.error })
      const result = await bounded(call.result, 'startup environment refusal')
      assert.equal(result.status, 'rejected')
      assert.equal(result.effectState, 'none')
      assert.equal(result.error.code, 'UNSUPPORTED_STARTUP_ENV')
    }
    assert.equal(JSON.stringify(f.frames).includes(value), false)
    assert.equal(f.logs.join('\n').includes(value), false)
    f.state.environment = { NIU_ENV: '', BASH_ENV: '', ENV: '' }
    const ordinary = await f.submit(owner)
    assert.equal((await f.admit(ordinary)).decision, 'launch')
    assert.equal((await f.finish(ordinary)).status, 'completed')
  }, { mode: 'read-only' })
})

await test('runtime environment merge cannot add a startup script before confinement or bootstrap', async () => {
  await fixture(async f => {
    const owner = await f.agent(), value = 'fixture-private-runtime-startup'
    f.state.environment = { NIU_ENV: '', BASH_ENV: '', ENV: '' }
    f.state.runtimeEnvironment = { nIu_eNv: value, bAsH_eNv: value, eNv: value }
    const call = await f.submit(owner)
    const admission = await f.admit(call)
    assert.equal(admission.decision, 'reject')
    assert.equal(admission.error.code, 'UNSUPPORTED_STARTUP_ENV')
    for (const name of Object.keys(f.state.runtimeEnvironment)) assert.equal(admission.error.message.includes(name), true)
    assert.equal(admission.error.message.includes(value), false)
    assert.equal(f.preparations.length, 1)
    assert.equal(f.confinements.length, 0)
    assert.equal(f.bootstraps.length, 0)
    f.complete(call.request, { status: 'rejected', exitCode: null, effectState: 'none', shellState: 'reset', error: admission.error })
    const result = await bounded(call.result, 'runtime startup environment refusal')
    assert.equal(result.effectState, 'none')
    assert.equal(result.error.code, 'UNSUPPORTED_STARTUP_ENV')
    assert.equal(JSON.stringify(f.frames).includes(value), false)
    assert.equal(f.logs.join('\n').includes(value), false)
  }, { mode: 'read-only' })
})

await test('sealed session spill is retained only after both copies and attributed to the exact Session', async () => {
  await fixture(async f => {
    const owner = await f.agent(), sibling = await f.agent(), call = await f.submit(owner)
    await f.admit(call)
    const file = path.join(f.directory, `dsh-ops-native-123-${randomUUID().replaceAll('-', '')}`, `stdout-${randomUUID().replaceAll('-', '')}.log`)
    const gate = Promise.withResolvers(), asked = Promise.withResolvers(), ledger = getSpillLedger()
    f.state.outputRead = async request => {
      if (request.stream === 'stderr') { asked.resolve(); await gate.promise }
      return { type: 'shell.output', ...request, nextOffset: request.stream === 'stdout' ? 200000 : 0,
        bytesBase64: request.stream === 'stdout' ? Buffer.from('prefix').toString('base64') : '',
        lossy: request.stream === 'stdout', eof: true, ...(request.stream === 'stdout' ? {
          spillPath: file, spillOrigin: 'ops-native-v1', spillPid: 123, spillSealed: true,
        } : {}) }
    }
    const finishing = f.finish(call, { stdoutTotal: 200000 })
    await bounded(asked.promise, 'sibling stream'); await turn()
    assert.equal(ledger.entries().some(entry => entry.path === file), false)
    gate.resolve()
    const result = await finishing
    assert.equal(result.stdout.spillPath, file); assert.equal(result.stdout.text, 'prefix')
    assert.equal(result.stdout.bytesTotal, 200000); assert.equal(result.stdout.lossy, true)
    const entry = ledger.entries().find(entry => entry.path === file)
    assert.equal(entry.sessionId, owner.agent.session.id); assert.notEqual(entry.sessionId, sibling.agent.session.id)
    assert.equal(entry.pid, 123); assert.equal(entry.origin, 'ops-native-v1'); assert.equal(entry.bytes, 200000)
    assert.equal(f.frames.some(frame => frame.type === 'shell.release'), true)
  })
})

for (const mode of ['raw error', 'spill degradation', 'unknown cleanup']) {
  await test(`${mode} cannot publish or settle a session recovery path`, async () => {
    await fixture(async f => {
      const owner = await f.agent(), call = await f.submit(owner)
      await f.admit(call)
      const file = path.join(f.directory, `dsh-ops-native-123-${randomUUID().replaceAll('-', '')}`, `stdout-${randomUUID().replaceAll('-', '')}.log`)
      f.state.outputRead = request => ({ type: 'shell.output', ...request, nextOffset: request.stream === 'stdout' ? 9 : 0,
        bytesBase64: '', lossy: request.stream === 'stdout', eof: mode !== 'raw error' || request.stream !== 'stdout',
        ...(request.stream === 'stdout' ? { spillPath: file, spillOrigin: 'ops-native-v1', spillPid: 123, spillSealed: true,
          ...(mode === 'raw error' ? { error: { code: 'OUTPUT_INCOMPLETE', message: 'fixture capture failed' } } : {}),
          ...(mode === 'spill degradation' ? { spillError: 'fixture complete-file close failed' } : {}),
        } : {}) })
      const result = await f.finish(call, { stdoutTotal: 9, cleanupConfirmed: mode !== 'unknown cleanup' })
      assert.equal(result.stdout.spillPath, undefined)
      assert.equal(getSpillLedger().entries().some(entry => entry.path === file), false)
      assert.equal(f.aborts.length, 0)
      if (mode === 'raw error') assert.equal(result.status, 'failed')
      if (mode === 'spill degradation') assert.equal(result.stdout.spillError, 'fixture complete-file close failed')
    })
  })
}

await test('an unsealed terminal spill fails the protocol before ledger handoff', async () => {
  await fixture(async f => {
    const owner = await f.agent(), call = await f.submit(owner), aborted = Promise.withResolvers()
    await f.admit(call)
    f.state.onAbort = error => aborted.resolve(error)
    f.state.outputRead = request => ({ type: 'shell.output', ...request, nextOffset: 0, bytesBase64: '', lossy: false, eof: true,
      spillPath: '/unsealed', spillOrigin: 'ops-native-v1', spillPid: 123, spillSealed: false })
    const finishing = f.finish(call)
    assert.match((await bounded(aborted.promise, 'unsealed spill abort')).message, /not sealed/)
    assert.equal(f.frames.some(frame => frame.type === 'shell.release'), false)
    f.emit({ type: 'shell.unavailable', cleanupConfirmed: true, error: { code: 'EXECUTOR_UNAVAILABLE', message: 'fixture joined kernel' } })
    assert.equal((await finishing).stdout.spillPath, undefined)
  })
})

report('resident-shell-admission')
