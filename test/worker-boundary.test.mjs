/** Host worker boundaries treat arguments and process output as untrusted values. */
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { invoke as fileCall } from '../lib/file/worker.js'
import { invoke as ptcCall } from '../lib/ptc/worker.js'
import { InvocationDeadlineError } from '../lib/lifecycle/invocations.js'

async function fixture(body) {
  await withTempDir('worker-boundary', async root => {
    const { ctx } = await bootHost()
    const state = { text: '{"status":"completed"}', spawns: 0, observed: 0, missing: new Set(), exitCode: 0, signal: null, lossy: false, onSpawn: undefined }
    try {
      await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) }))
      await ctx.plugin(inner => inner.provide('subprocess', { spawn: () => {
        state.spawns++
        state.onSpawn?.()
        return { done: Promise.resolve({ exitCode: state.exitCode, signal: state.signal }), collected: {
          stdout: state.missing.has('stdout') ? undefined : { readFrom: () => ({ text: state.text, lossy: state.lossy }) },
          stderr: state.missing.has('stderr') ? undefined : { readFrom: () => ({ text: '', lossy: false }) },
        } }
      } }))
      await ctx.plugin(inner => inner.provide('fs', {
        resolve: async file => file, stat: async () => ({ type: 'file', size: 0, version: 'observed-version' }),
      }))
      ctx.on('fs/observed', () => state.observed++)
      const exec = { agent: { session: { id: 'worker-boundary', header: { cwd: root } } } }
      const controller = new AbortController()
      await body({ ctx, exec, state, signal: controller.signal, controller })
    } finally { await shutdown(ctx) }
  })
}

await test('Native non-object arguments fail before spawning or observing files', async () => {
  await fixture(async ({ ctx, exec, state, signal }) => {
    for (const args of [undefined, null, 1, true, 'path', [], [{ path: 'safe.txt' }]]) {
      const value = await fileCall(ctx, 'unused', 'stat', args, exec, signal)
      assert.equal(value.error.code, 'INVALID_ARGUMENT', JSON.stringify(value))
      assert.equal(value.error.effectState, 'none')
    }
    assert.equal(state.spawns, 0); assert.equal(state.observed, 0)
  })
})

await test('Native invalid or scalar JSON reports no effects for reads and unknown effects for writes', async () => {
  await fixture(async ({ ctx, exec, state, signal }) => {
    const outputs = ['{', 'null', 'true', '0', '"completed"', '[]', '[{"status":"completed"}]']
    for (const text of outputs) {
      state.text = text
      const value = await fileCall(ctx, 'unused', 'stat', { path: 'safe.txt' }, exec, signal)
      assert.equal(value.error.code, 'RESULT_UNKNOWN', JSON.stringify(value))
      assert.equal(value.error.effectState, 'none'); assert.equal(value.error.retryable, false)
      assert.doesNotMatch(value.error.nextAction, /do not blindly retry/)
    }
    assert.equal(state.spawns, outputs.length); assert.equal(state.observed, 0)
    state.text = '{"status":"completed","changed":1,"items":[null,0,{"path":"safe.txt","bytesAfter":0}]}'
    const changed = await fileCall(ctx, 'unused', 'replace', { path: 'safe.txt', pattern: 'a', replacement: 'b' }, exec, signal)
    assert.equal(changed.changed, 1); assert.equal(changed.status, 'completed')
    assert.equal(state.observed, 1, 'only a valid matching receipt refreshes host observation')
    state.text = 'null'
    const unsettled = await fileCall(ctx, 'unused', 'write_file', { path: 'new.txt', content: 'new', expectedRevision: 'absent' }, exec, signal)
    assert.equal(unsettled.error.effectState, 'unknown', 'a write may already have happened')
  })
})
await test('PTC non-object arguments fail before spawning batch work', async () => {
  await fixture(async ({ ctx, exec, state, signal }) => {
    for (const args of [undefined, null, 1, true, 'run', [], [{ action: 'run' }]]) {
      const value = await ptcCall(ctx, 'unused', 'batch', args, exec, signal)
      assert.equal(value.error.code, 'INVALID_ARGUMENT', JSON.stringify(value))
      assert.equal(value.error.effectState, 'none'); assert.equal(value.detailsRef, undefined)
    }
    assert.equal(state.spawns, 0)
  })
})

await test('PTC unsettled JSON after spawning keeps possible batch effects and audit identity', async () => {
  await fixture(async ({ ctx, exec, state, signal }) => {
    const outputs = ['{', 'null', 'true', '0', '"completed"', '[]', '[{"status":"completed"}]']
    for (const text of outputs) {
      state.text = text
      const value = await ptcCall(ctx, 'unused', 'batch', { action: 'run', operations: [] }, exec, signal)
      assert.equal(value.error.code, 'RESULT_UNKNOWN', JSON.stringify(value))
      assert.equal(value.error.effectState, 'unknown'); assert.equal(value.error.retryable, false)
      assert.match(value.error.nextAction, /never blindly rerun/); assert.match(value.detailsRef, /^j-/)
    }
    assert.equal(state.spawns, outputs.length)
    state.text = '{"status":"error","changed":1,"error":{"code":"POLICY_DENIED","reason":"write-roots","effectState":"applied"}}'
    const denied = await ptcCall(ctx, 'unused', 'batch', { action: 'run', operations: [] }, exec, signal)
    assert.equal(denied.status, 'rejected'); assert.equal(denied.changed, 1)
    assert.equal(denied.error.effectState, 'applied'); assert.equal(denied.detailsRef, undefined)
  })
})
await test('Missing Native collected readers distinguish read-only and mutating effects', async () => {
  await fixture(async ({ ctx, exec, state, signal }) => {
    for (const missing of [['stdout'], ['stderr'], ['stdout', 'stderr']]) {
      state.missing = new Set(missing)
      for (const [tool, args] of [['stat', { path: 'safe.txt' }], ['write_file', { path: 'new.txt', content: 'new', expectedRevision: 'absent' }]]) {
        const value = await fileCall(ctx, 'unused', tool, args, exec, signal)
        assert.equal(value.error.code, 'RESULT_UNKNOWN', JSON.stringify(value))
        assert.equal(value.error.effectState, tool === 'stat' ? 'none' : 'unknown'); assert.equal(value.error.retryable, false)
        assert.match(value.error.message, /output readers are unavailable/)
        if (tool === 'stat') assert.doesNotMatch(value.error.nextAction, /do not blindly retry/)
        else assert.match(value.error.nextAction, /do not blindly retry/)
      }
    }
    assert.equal(state.spawns, 6); assert.equal(state.observed, 0)
  })
})
await test('Missing PTC collected readers preserve unknown effects and audit identity', async () => {
  await fixture(async ({ ctx, exec, state, signal }) => {
    for (const missing of [['stdout'], ['stderr'], ['stdout', 'stderr']]) {
      state.missing = new Set(missing)
      const value = await ptcCall(ctx, 'unused', 'batch', { action: 'run', operations: [] }, exec, signal)
      assert.equal(value.error.code, 'RESULT_UNKNOWN', JSON.stringify(value))
      assert.equal(value.error.effectState, 'unknown'); assert.equal(value.error.retryable, false)
      assert.match(value.error.message, /output readers are unavailable/)
      assert.match(value.error.nextAction, /never blindly rerun/); assert.match(value.detailsRef, /^j-/)
    }
    assert.equal(state.spawns, 3)
  })
})
await test('Read-only worker interruption, lossy output and nonzero exit report no effects', async () => {
  await fixture(async ({ ctx, exec, state, signal }) => {
    const cases = [
      { outcome: { exitCode: null, signal: 'SIGTERM' }, code: 'RESULT_UNKNOWN', mutatingCode: 'RESULT_UNKNOWN' },
      { outcome: { lossy: true }, code: 'OUTPUT_LIMIT', mutatingCode: 'OUTPUT_LIMIT' },
      { outcome: { exitCode: 1 }, code: 'EXECUTOR_UNAVAILABLE', mutatingCode: 'RESULT_UNKNOWN' },
    ]
    for (const item of cases) {
      Object.assign(state, { exitCode: 0, signal: null, lossy: false }, item.outcome)
      const read = await fileCall(ctx, 'unused', 'stat', { path: 'safe.txt' }, exec, signal)
      assert.equal(read.error.code, item.code, JSON.stringify(read))
      assert.equal(read.error.effectState, 'none', JSON.stringify(read))
      assert.match(read.error.message, /no files were changed/i)
      const write = await fileCall(ctx, 'unused', 'write_file', { path: 'new.txt', content: 'new', expectedRevision: 'absent' }, exec, signal)
      assert.equal(write.error.code, item.mutatingCode, JSON.stringify(write))
      assert.equal(write.error.effectState, 'unknown', JSON.stringify(write))
    }
  })
})

await test('Read-only result paging does not inherit batch effect uncertainty', async () => {
  await fixture(async ({ ctx, exec, state, signal }) => {
    for (const item of [
      { outcome: { exitCode: null, signal: 'SIGTERM' }, code: 'RESULT_UNKNOWN' },
      { outcome: { lossy: true }, code: 'OUTPUT_LIMIT' },
      { outcome: { exitCode: 1 }, code: 'EXECUTOR_UNAVAILABLE' },
    ]) {
      Object.assign(state, { exitCode: 0, signal: null, lossy: false }, item.outcome)
      const value = await ptcCall(ctx, 'unused', 'result', { action: 'page', id: 'result-1' }, exec, signal)
      assert.equal(value.error.code, item.code, JSON.stringify(value))
      assert.equal(value.error.effectState, 'none', JSON.stringify(value))
      assert.equal(value.error.phase, 'execute', JSON.stringify(value))
      assert.match(value.error.message, /no data was changed/i)
    }
  })
})

await test('Read-only interruptions distinguish real deadlines from caller cancellation', async () => {
  for (const [reason, code] of [[new InvocationDeadlineError(), 'TIMEOUT'], [new Error('caller cancelled'), 'ABORTED']]) {
    for (const kind of ['file', 'result']) {
      await fixture(async ({ ctx, exec, state, signal, controller }) => {
        Object.assign(state, { exitCode: null, signal: 'SIGTERM', onSpawn: () => controller.abort(reason) })
        const value = kind === 'file'
          ? await fileCall(ctx, 'unused', 'stat', { path: 'safe.txt' }, exec, signal)
          : await ptcCall(ctx, 'unused', 'result', { action: 'page', id: 'result-1' }, exec, signal)
        assert.equal(value.error.code, code, `${kind}: ${JSON.stringify(value)}`)
        assert.equal(value.error.effectState, 'none', `${kind}: ${JSON.stringify(value)}`)
        assert.match(value.error.message, kind === 'file' ? /no files were changed/i : /no data was changed/i)
      })
    }
  }
})

await test('Oversized write requests name content, the effective limit and splitting', async () => {
  await fixture(async ({ ctx, exec, state, signal }) => {
    const value = await fileCall(ctx, 'unused', 'write_file', {
      path: 'large.txt', content: 'x'.repeat(2 * 1024 * 1024), expectedRevision: 'absent',
    }, exec, signal)
    assert.equal(value.error.code, 'OUTPUT_LIMIT')
    assert.equal(value.error.effectState, 'none')
    assert.match(value.error.message, /content/)
    assert.match(value.error.message, /2 MiB/)
    assert.match(value.error.message, /split/)
    assert.equal(state.spawns, 0)
  })
})

report('worker-boundary')
