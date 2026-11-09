import { selectExecutor, executeCall, prepareStep } from './lib/executor.mjs'
import { createScope } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import { bootHost } from './lib/host.mjs'
import { assert, test, report, withTempDir, skipSuite } from './lib/harness.mjs'
import * as ptcModule from '../lib/ptc/index.js'
import { tryResolveWorker } from '../lib/ptc/runtime.js'
import { legacyComponent } from './lib/legacy-component.mjs'
import { BATCHING_GUIDANCE, THIN_CODE_CHARS } from '../lib/projections/ptc/batching-guidance.js'

const worker = tryResolveWorker()
if (!worker.ok) skipSuite('ptc-batching-wiring', worker.reason)
const ptc = legacyComponent(ptcModule)

const scenario = guidanceEnabled => withTempDir('ptc-batching', async root => {
  const { ctx } = await bootHost()
  const agents = []
  let sequence = 0
  try {
    ctx.provide('agents', { list: () => agents })
    await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem); await ctx.plugin(NodePtc)
    await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: 'danger-full-access', workspaceRoot: root, sessionId: session?.id }) }))
    await ctx.plugin(ptc, { binaryPath: worker.file, required: true, batchingGuidance: guidanceEnabled })
    // Component injections settle asynchronously before the first assembly.
    await new Promise(resolve => setTimeout(resolve, 150))
    const agent = { id: 'ptc-' + (++sequence), session: { id: 'ptc-' + sequence, header: { cwd: root }, append() {}, read() { return [] } } }
    agent.ctx = createScope(ctx, agent).ctx
    await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, 'ptc') } })
    agents.push(agent)
    await ctx.serial('agent/created', { agent })
    // Assembly is the only place the section is rendered, so read it the same way the loop does.
    const promptText = async () => {
      const prepared = await prepareStep(ctx, agent)
      try { return prepared.assembly.sections.map(section => section.text).join('\n') }
      finally { prepared.dispose() }
    }
    const run = code => executeCall(ctx, { agent, name: 'run_code', callId: 'batch-' + (++sequence),
      arguments: { description: 'batching fixture', code }, signal: AbortSignal.timeout(30_000) })
    // A turn boundary is the only place the latched decision may change.
    const nextTurn = () => ctx.serial('session/event', agent.session, { type: 'turn/start' })

    // A real session opens its first turn before the first step runs.
    await nextTurn()
    // Turn one carries the playbook unconditionally: the first program decides the
    // shape of every later step, so correction after the fact is too late.
    assert.equal((await promptText()).includes(BATCHING_GUIDANCE), guidanceEnabled,
      guidanceEnabled ? 'the first turn is primed' : 'a row with the switch off never publishes the shape')
    await run('return 1')
    assert.equal((await promptText()).includes(BATCHING_GUIDANCE), guidanceEnabled, 'one wasted step changes nothing on the primed turn')

    // From the second turn on the playbook appears only when a step was wasted.
    await nextTurn()
    assert.equal((await promptText()).includes(BATCHING_GUIDANCE), false, 'the second turn starts unprimed')
    await run('return 2')
    assert.equal((await promptText()).includes(BATCHING_GUIDANCE), guidanceEnabled,
      guidanceEnabled ? 'a wasted step brings it back immediately' : 'still off')

    const dense = "const pad = '" + 'x'.repeat(THIN_CODE_CHARS) + "'\nreturn pad.length"
    await run(dense)
    assert.equal((await promptText()).includes(BATCHING_GUIDANCE), guidanceEnabled, 'a dense program does not withdraw it mid-turn')
    await nextTurn()
    assert.equal((await promptText()).includes(BATCHING_GUIDANCE), false, 'the next turn clears it')
  } finally { await Promise.allSettled(agents.map(agent => ctx.serial('agent/disposed', { agent }))); await ctx.dispose?.() }
})

await test('the PTC section gains the shape only after a thin streak and drops it on the next turn', () => scenario(true))
await test('a row with batchingGuidance off renders no shape even after a long thin streak', () => scenario(false))

report()
