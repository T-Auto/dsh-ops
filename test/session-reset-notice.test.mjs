/** Real public executors; a settlement gate tests disclosure independently of native execution. */
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import Projections from '@deepseek-ai/dsh-session-projection'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import { withSessionExecution } from '../lib/shells/persistent-tool.js'
import { bashToolDefinition } from '../lib/shells/tool.js'
import { hostBashDefinition } from '../lib/shells/host-tool.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { executeCall, prepareStep } from './lib/executor.mjs'
import { assert, test, report } from './lib/harness.mjs'

const input = { command: 'sensitive-command', description: 'Test settled reset disclosure', execution: 'session' }
const terminal = extra => ({ type: 'shell.completed', requestId: 'fixture', status: 'cancelled',
  exitCode: null, effectState: 'unknown', shellState: 'reset', cleanupConfirmed: true,
  stdoutTotal: 0, stderrTotal: 0, stdout: { text: '', bytesTotal: 0, lossy: false },
  stderr: { text: '', bytesTotal: 0, lossy: false }, error: { code: 'CANCELLED', message: 'joined cancellation' }, ...extra })

for (const mode of ['native', 'ptc']) await test(`${mode} cancellation carries only established reset facts through the public executor`, async () => {
  const { ctx } = await bootHost({ toolsMode: mode })
  try {
    if (mode === 'ptc') {
      await ctx.plugin(Projections)
      await ctx.plugin(Policy, { mode: 'danger-full-access', workspaceRoot: process.cwd() })
      for (const plugin of [Subprocess, Sandbox, FileSystem, NodePtc]) await ctx.plugin(plugin)
    }
    let entered, joined, calls = 0, observedCallId
    const forbidden = () => { throw Error('Fresh execution does not belong to this fixture') }
    const fresh = hostBashDefinition({ get: forbidden }, bashToolDefinition({ file: process.execPath, source: 'fixture' }), forbidden, forbidden)
    const definition = withSessionExecution(fresh, { async execute(_input, call) {
      calls++
      observedCallId = call.callId
      entered.resolve()
      return joined.promise
    } }, () => true)
    await ctx.plugin({ name: 'reset-notice-fixture', inject: ['tools'], apply(inner) { inner.tools.register(definition) } })
    const request = signal => ({ signal, callId: `public-${mode}`, name: mode === 'native' ? definition.name : 'run_code',
      arguments: mode === 'native' ? input : { description: 'Test nested reset disclosure', code: `return await tools.${definition.name}(${JSON.stringify(input)});` } })
    const before = await prepareStep(ctx)
    try {
      const result = await executeCall(ctx, { ...request(AbortSignal.abort()), toolSet: before.toolSet })
      assert.equal(result.error.info.code, 'ABORTED_BEFORE_DISPATCH')
      assert.equal(calls, 0)
      assert.deepEqual(result.additionalContexts ?? [], [])
    } finally { before.dispose() }
    for (const extra of [{}, { effectState: 'none' }, { shellState: 'unchanged' }, { shellState: 'unknown' }, { cleanupConfirmed: false }]) {
      entered = Promise.withResolvers(); joined = Promise.withResolvers()
      const controller = new AbortController()
      let settled = false
      const work = executeCall(ctx, request(controller.signal)).finally(() => { settled = true })
      await entered.promise
      controller.abort()
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(settled, false, 'the outer result must await the cleanup receipt')
      joined.resolve(terminal(extra))
      const result = await work
      assert.equal(result.isError, true)
      assert.equal(result.error.info.code, 'ABORTED')
      assert.equal(result.value, undefined)
      const contexts = result.additionalContexts ?? []
      const expected = extra.shellState === undefined && extra.cleanupConfirmed !== false
      assert.equal(contexts.length, expected ? 1 : 0, JSON.stringify(extra))
      if (expected) {
        assert.deepEqual(contexts[0].source, { kind: 'dsh-ops:shell-reset', callId: observedCallId,
          shellState: 'reset', cleanupConfirmed: true, effectState: extra.effectState ?? 'unknown' })
        assert.match(JSON.stringify(contexts[0].content), /Persistent shell reset.*cleanup confirmed/)
        assert.doesNotMatch(JSON.stringify(contexts[0]), /sensitive-command/)
        if (mode === 'ptc') assert.doesNotMatch(JSON.stringify(result.content), /shell reset/,
          'reserved run_code keeps its own cancelled tool-card text')
      }
    }
  } finally { await shutdown(ctx) }
})

report('session-reset-notice')
