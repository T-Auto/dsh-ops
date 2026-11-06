import { selectExecutor, executeCall, prepareStep } from './lib/executor.mjs'
import { createScope } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import { mountConsumer } from '../lib/consumer/mount.js'
import { isLongStandaloneSleep, JOB_WAIT_GUIDANCE } from '../lib/shells/job-wait-guidance.js'
import { resolveConfig } from '../lib/config.js'
import { BASH_TOOL } from '../lib/policy.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'

await test('only bounded standalone long sleeps qualify, with no loop or external command inference', () => {
  for (const command of ['sleep 20', 'sleep 0.5m', 'sudo sleep 1h', '/usr/bin/sleep 1d', 'Start-Sleep -Seconds 30', 'Start-Sleep -Milliseconds 20000']) assert.equal(isLongStandaloneSleep(command), true, command)
  for (const command of ['sleep 19', 'sleep infinity', 'sleep $WAIT', 'for x in a; do sleep 50; done', 'sleep 30 && echo done', 'echo "sleep 30"', 'Start-Sleep -Milliseconds 19000', 'sleep 1e9', 'sleep -1', null]) assert.equal(isLongStandaloneSleep(command), false, String(command))
})

await test('the owning consumer observes real Native/PTC results and keeps untriggered prompt bytes unchanged', () => withTempDir('job-wait-guidance', async root => {
  const { ctx } = await bootHost()
  const agents = []; ctx.provide('agents', { list: () => agents })
  let allowed = true, failing = false, sequence = 0, executions = 0
  try {
    await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem); await ctx.plugin(NodePtc)
    await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: 'danger-full-access', workspaceRoot: root, sessionId: session?.id }) }))
    ctx.tools.register({ name: BASH_TOOL, description: 'Record the command without sleeping or spawning.',
      parameters: { type: 'object', required: ['command'], properties: { command: { type: 'string' } } },
      output: { schema: { type: 'object', properties: { status: { type: 'string' }, exitCode: { type: 'number' } } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async () => { executions++; return { status: failing ? 'failed' : 'completed', exitCode: failing ? 1 : 0 } } })
    const jobs = { name: 'job_output', description: 'Observe a fixture job.', parameters: { type: 'object', properties: { wait: { type: 'boolean' } } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'fixture' }
    let removeJobs = ctx.tools.register(jobs)
    const mint = async mode => {
      const agent = { id: `${mode}-${++sequence}`, session: { id: `${mode}-${sequence}`, header: { cwd: root }, append() {}, read() { return [] } } }
      agent.ctx = createScope(ctx, agent).ctx
      await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, mode) } })
      agents.push(agent); await ctx.serial('agent/created', { agent }); return agent
    }
    const mount = promptPolicy => ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) {
      mountConsumer(inner, { id: 'wait-fixture', gate: { allows: () => allowed }, core: resolveConfig({ promptPolicy, publishBashTool: false }), shell: true,
        presentation: 'native', files: false, residentTools: false, discovery: false, native: { alwaysLoaded: [] }, external: { allowed: [] }, replaceOfficial: false })
    } })
    const owner = await mount(true)
    const native = await mint('native'), ptc = await mint('ptc'), untouched = await mint('native')
    const sections = async agent => (await ctx.get('systemPrompt').assemble({ scope: agent })).sections
    const hints = async agent => (await sections(agent)).filter(section => section.text.includes(JOB_WAIT_GUIDANCE))
    const before = JSON.stringify(await sections(untouched))
    const execute = (agent, name, args) => executeCall(ctx, { agent, name, arguments: args, callId: `wait-${++sequence}`, signal: AbortSignal.timeout(15_000) })
    assert.equal((await hints(native)).length, 0)
    for (const command of ['sleep 1', 'for x in a; do sleep 50; done', 'echo normal']) await execute(native, BASH_TOOL, { command })
    assert.equal((await hints(native)).length, 0)
    failing = true; await execute(native, BASH_TOOL, { command: 'sleep 30' }); failing = false
    assert.equal((await hints(native)).length, 0, 'a failed sleep must not create guidance')
    const value = await execute(native, BASH_TOOL, { command: 'sleep 30' })
    assert.deepEqual(value.value, { status: 'completed', exitCode: 0 }, 'the result is unchanged')
    assert.equal((await hints(native)).length, 1)
    await execute(native, BASH_TOOL, { command: 'sleep 40' }); assert.equal((await hints(native)).length, 1)
    assert.equal(JSON.stringify(await sections(untouched)), before, 'untriggered prompt bytes stay identical')
    const nested = await execute(ptc, 'run_code', { description: 'Observe a successful delay result', code: `return await tools.${BASH_TOOL}({command:'sleep 30'});` })
    assert.equal(nested.isError, false, JSON.stringify(nested)); assert.equal((await hints(ptc)).length, 1)
    removeJobs(); assert.equal((await hints(native)).length, 0, 'absence of the wait tool withdraws guidance')
    removeJobs = ctx.tools.register(jobs)
    allowed = false; assert.equal((await hints(native)).length, 0, 'live ownership is authoritative')
    allowed = true; assert.equal((await hints(native)).length, 1)
    await owner.dispose(); assert.equal((await hints(native)).length, 0)
    const disabled = await mount(false)
    await execute(native, BASH_TOOL, { command: 'sleep 30' }); assert.equal((await hints(native)).length, 0, 'promptPolicy false registers no hint')
    assert.equal(executions, 8, 'no command is blocked, repeated or fabricated')
    await disabled.dispose(); removeJobs()
  } finally { await shutdown(ctx) }
}))
report('job-wait-guidance')
