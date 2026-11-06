import { selectExecutor, executeCall, prepareStep } from './lib/executor.mjs'
import { createScope } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import * as guard from '../lib/components/download-guard/index.js'
import { publicToolName } from '../lib/policy.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'

const toolName = publicToolName('bash')
const command = 'curl -o out.iso https://example.test/a.iso'
let calls = 0
let sequence = 0
await test('real Native and Node PTC dispatch enforce the configured guard and disposal restores calls', () => withTempDir('download-dispatch', async root => {
  const { ctx } = await bootHost()
  const agents = []; ctx.provide('agents', { list: () => agents })
  try {
    await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem); await ctx.plugin(NodePtc)
    await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: 'danger-full-access', workspaceRoot: root, sessionId: session?.id }) }))
    ctx.tools.register({ name: toolName, description: 'Record a shell dispatch without any network or process effect.',
      parameters: { type: 'object', required: ['command'], properties: { command: { type: 'string' } } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => { calls++; return 'executed' } })
    const mint = async mode => {
      const agent = { id: mode, session: { id: mode, header: { cwd: root }, append() {}, read() { return [] } } }
      agent.ctx = createScope(ctx, agent).ctx
      await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, mode) } })
      agents.push(agent); await ctx.serial('agent/created', { agent })
      return agent
    }
    const native = await mint('native')
    const fiber = await ctx.plugin(guard, { downloadGuard: { template: 'fetch --output {file} -- {url}' } })
    const ptc = await mint('ptc')
    const execute = (agent, name, args) => executeCall(ctx, { agent, name, callId: `download-${++sequence}`, arguments: args, signal: AbortSignal.timeout(15_000) })
    calls = 0
    const denied = await execute(native, toolName, { command })
    assert.equal(denied.isError, true, JSON.stringify(denied))
    assert.match(JSON.stringify(denied), /DOWNLOAD_TO_FILE|configured downloader/)
    assert.equal(calls, 0, 'the real tool must not run')
    const nested = await execute(ptc, 'run_code', { description: 'Check the download refusal', code: `return await tools.${toolName}({command:${JSON.stringify(command)}});` })
    assert.match(JSON.stringify(nested), /DOWNLOAD_TO_FILE|configured downloader/)
    assert.equal(calls, 0, 'the PTC nested tool must not run')
    const allowed = await execute(native, toolName, { command: 'node download.cjs --help' })
    assert.equal(allowed.isError, false, JSON.stringify(allowed)); assert.equal(calls, 1)
    await fiber.dispose()
    const restored = await execute(native, toolName, { command })
    assert.equal(restored.isError, false, JSON.stringify(restored)); assert.equal(calls, 2)
  } finally { await shutdown(ctx) }
}))
report('download-guard-dispatch')
