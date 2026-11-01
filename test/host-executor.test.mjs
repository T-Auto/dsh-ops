/** Actual host APIs, without the legacy presentation/execute fixture adapters. */
import fs from 'node:fs'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import Tools from '@deepseek-ai/dsh-tools'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import { integration } from 'dsh-ops/integration'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'

requireWorker('host-executor')
const executorArchitecture = typeof Tools.prototype.setExecutor === 'function'
const select = async (ctx, mode) => executorArchitecture
  ? ctx.plugin(await import('@deepseek-ai/dsh-tool-executor-' + mode))
  : ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.presentAs(mode) } })
const execute = async (ctx, agent, name, args) => {
  const signal = new AbortController().signal
  if (!executorArchitecture) return ctx.get('tools').execute({ agent, name, arguments: args, signal, callId: 'host-contract' })
  const batch = await ctx.get('tools').execute({ agent, signal,
    calls: [{ type: 'tool-call', id: 'host-contract', name, arguments: JSON.stringify(args) }] })
  assert.equal(batch.results.length, 1)
  assert.equal(batch.results[0].callId, 'host-contract')
  return batch.results[0].result
}

await test('unadapted host executors dispatch Native files and scoped PTC, revoke ownership and replace selection', () => withTempDir('host-executor', async root => {
  const ctx = new Context(); ctx.logger.level = 0
  const agents = []
  try {
    await ctx.plugin(Prompt, {})
    await ctx.plugin(Tools, executorArchitecture ? {} : { mode: 'native' })
    if (executorArchitecture) await ctx.plugin(await import('@deepseek-ai/dsh-tool-executor-native'))
    await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem); await ctx.plugin(NodePtc)
    ctx.provide('workingDirectory', { get: session => session.header.cwd, ensure: async agent => agent.session.header.cwd })
    ctx.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: session?.mode ?? 'danger-full-access', workspaceRoot: root, sessionId: session?.id }) })
    ctx.provide('agentPresets', { composedPreset: () => undefined })
    ctx.provide('agents', { list: () => agents })
    await ctx.plugin(integration({ preset: 'executor-native', discovery: false, binaryPath: WORKER }))
    const ptc = await ctx.plugin(integration({ preset: 'executor-ptc', profile: 'ptc', binaryPath: WORKER }))
    async function mint(id, mode) {
      const agent = { id, session: { id, mode: 'danger-full-access', header: { cwd: root, agentPreset: id }, append() {}, read() { return [] } } }
      agent.ctx = createScope(ctx, agent).ctx
      agent.selection = await select(agent.ctx, mode)
      agents.push(agent); await ctx.serial('agent/created', { agent })
      await ctx.get('systemPrompt').assemble({ scope: agent, agent })
      return agent
    }
    fs.writeFileSync(path.join(root, 'note.txt'), 'first\nsecond\n')
    const native = await mint('executor-native', 'native'), code = await mint('executor-ptc', 'ptc')
    const read = await execute(ctx, native, 'ops_read_files', { files: [{ path: 'note.txt' }] })
    assert.equal(read.isError, false, JSON.stringify(read))
    assert.match(JSON.stringify(read.value), /first/)
    const program = await execute(ctx, code, 'run_code', { description: 'Read the scoped file',
      code: "return await tools.ops_inspect_local_file({path:'note.txt',offset:0,limit:1});" })
    assert.equal(program.isError, false, JSON.stringify(program))
    assert.equal(program.value.result.status, 'partial')
    assert.ok(program.value.result.data.items)
    const wrongMode = await execute(ctx, code, 'ops_inspect_local_file', { path: 'note.txt' })
    assert.equal(wrongMode.isError, true, 'PTC accepts only its program transport directly')
    const retained = ctx.get('tools').get('ops_inspect_local_file', code)
    await ptc.dispose()
    assert.equal((await retained.execute({ path: 'note.txt' }, { agent: code })).status, 'rejected')
    await code.selection.dispose()
    if (executorArchitecture) {
      await assert.rejects(ctx.get('systemPrompt').assemble({ scope: code }), /executor.*unavailable/i)
      await assert.rejects(execute(ctx, code, 'run_code', { description: 'Unavailable', code: 'return 1' }), /executor.*unavailable/i)
    } else {
      assert.ok((await ctx.get('systemPrompt').assemble({ scope: code })).tools.every(tool => tool.name !== 'run_code'))
    }
    code.selection = await select(code.ctx, 'native')
    assert.ok((await ctx.get('systemPrompt').assemble({ scope: code })).tools.every(tool => tool.name !== 'run_code'))
    assert.equal((await execute(ctx, native, 'ops_read_files', { files: [{ path: 'note.txt' }] })).isError, false,
      'another scope retains its Native executor throughout')
  } finally { await ctx.fiber.dispose() }
}))
report('host-executor')
