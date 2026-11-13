/** Activation ownership across standalone integrations and the shipped composition root. */
import fs from 'node:fs'
import path from 'node:path'
import { Duplex, PassThrough, Writable } from 'node:stream'
import { createScope } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import * as Bundle from '../lib/index.js'
import { diagnose, integration, residentKernel } from '../lib/integration/index.js'
import { sharedWorkerSelection } from '../lib/execution/resident/provider.js'
import { invoke as fileCall } from '../lib/execution/files.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { selectExecutor, prepareStep, executeCall } from './lib/executor.mjs'
import { assert, test, report, waitFor, withTempDir } from './lib/harness.mjs'
import { requireWorker, WORKER } from './lib/boundary.mjs'

const quietRoot = {
  ...Object.fromEntries(['minimal', 'standard', 'ptc', 'ops-ptc', 'cordis', 'discovery',
    'download-guard', 'resultCache', 'panel', 'tui', 'disk'].map(name => [name, { enabled: false }])),
  global: { bash: false, hidePwsh: false, hideOfficialTools: false, forceDefaultOpsPtc: false },
  other: { pwsh7Link: false },
}
const nativeOptions = { profile: 'native', binaryPath: WORKER, required: true,
  residentNames: ['stat'], discovery: false, promptPolicy: false }
const workerIdentity = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)
let sequence = 0

async function realHost(root, { ptc = false } = {}) {
  const { ctx, tools } = await bootHost()
  const starts = [], agents = []
  class ObservedSubprocess extends Subprocess {
    spawn(spec) {
      const handle = super.spawn(spec)
      starts.push({ argv: [...spec.argv], handle })
      return handle
    }
  }
  await ctx.plugin(ObservedSubprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem)
  if (ptc) await ctx.plugin(NodePtc, { executionMode: 'per-call' })
  ctx.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({
    mode: session?.mode ?? (ptc ? 'danger-full-access' : 'read-only'), workspaceRoot: root, sessionId: session?.id,
  }) })
  ctx.provide('agents', { list: () => agents })
  ctx.provide('agentPresets', { composedPreset: () => undefined })
  async function mint(preset, presentation = 'native') {
    const id = `resident-composition-${++sequence}`
    const agent = { id, session: { id, mode: ptc ? 'danger-full-access' : 'read-only',
      header: { cwd: root, agentPreset: preset }, append() {}, read() { return [] } } }
    agent.ctx = createScope(ctx, agent).ctx
    await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, presentation) } })
    agents.push(agent); await ctx.serial('agent/created', { agent })
    await waitFor(() => tools.get('ops_stat', agent), { timeoutMs: 5000, what: 'resident-backed stat publication' })
    return agent
  }
  return { ctx, tools, mint, starts,
    workerStarts: () => starts.filter(start => workerIdentity(start.argv[0]) === workerIdentity(WORKER)) }
}
async function nativeStat(ctx, agent) {
  const result = await executeCall(ctx, { agent, name: 'ops_stat', arguments: { path: 'note.txt' }, callId: `resident-stat-${++sequence}` })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(result.value.status, 'completed', JSON.stringify(result))
  assert.equal(result.value.data.exists, true, JSON.stringify(result))
  return result
}

function heldKernel(ctx) {
  const input = new PassThrough()
  let complete, launches = 0, exits = 0
  const done = new Promise(resolve => { complete = resolve })
  const finish = () => { complete({ exitCode: 0, signal: null }); control.destroy() }
  const control = Duplex.from({ readable: input, writable: new Writable({ write(bytes, _encoding, callback) {
    callback()
    if (JSON.parse(bytes.toString()).type === 'shutdown') queueMicrotask(finish)
  } }) })
  ctx.provide('subprocess', { spawn() {
    ++launches
    return { control, done, collected: {}, terminate: finish, async waitForExit() { await done; ++exits; return true } }
  } })
  return { finish, send: value => input.write(`${JSON.stringify(value)}\n`),
    get launches() { return launches }, get exits() { return exits } }
}

await test('conflicting explicit root selections fail before a process or consumer starts', () => withTempDir('resident-selection', async root => {
  const first = path.join(root, 'first-worker'), second = path.join(root, 'second-worker')
  assert.deepEqual(sharedWorkerSelection([{}, { binaryPath: first }, { binaryPath: path.join(root, '.', 'first-worker') }]), { binaryPath: first })
  assert.throws(() => sharedWorkerSelection([{ binaryPath: 'relative-worker' }]), /absolute path/)
  const { ctx, tools } = await bootHost()
  let spawns = 0
  try {
    ctx.provide('subprocess', { spawn() { ++spawns; throw new Error('conflicting configuration must not spawn') } })
    await assert.rejects(async () => await ctx.plugin(Bundle, { ...quietRoot, presets: {
      first: { ...nativeOptions, binaryPath: first }, second: { ...nativeOptions, binaryPath: second },
    } }), /Conflicting OPS kernel binaryPath selections/)
    assert.equal(spawns, 0)
    assert.equal(ctx.get('opsKernel'), undefined)
    assert.deepEqual(tools.definitions(), [])
  } finally { await shutdown(ctx) }
}))

await test('standalone integration reports its missing provider before publication without lazy startup', async () => {
  const { ctx, tools } = await bootHost()
  let spawns = 0
  try {
    ctx.provide('subprocess', { spawn() { ++spawns; throw new Error('integration must not start its own kernel') } })
    await assert.rejects(async () => await ctx.plugin(integration({ preset: 'missing-provider', ...nativeOptions })),
      /provider is missing or not ready.*Mount residentKernel\(\).*before integration\(\)/)
    assert.equal(spawns, 0)
    assert.equal(ctx.get('opsKernel'), undefined)
    assert.deepEqual(tools.definitions(), [])
  } finally { await shutdown(ctx) }
})

requireWorker('resident-composition')
await test('concurrent providers reserve one service while its handshake is pending', async () => {
  const { ctx } = await bootHost(), host = heldKernel(ctx)
  let owner
  const starting = (async () => { owner = await ctx.plugin(residentKernel({ binaryPath: WORKER })) })()
  void starting.catch(() => {})
  try {
    await waitFor(() => host.launches === 1)
    assert.equal(ctx.get('opsKernel'), undefined)
    await assert.rejects(async () => await ctx.plugin(residentKernel({ binaryPath: WORKER })), /opsKernel|already|provider/i)
    assert.equal(host.launches, 1, 'the reservation precedes process startup completion')
    host.send({ type: 'ready', version: 1, pid: 123 })
    await starting
    assert.equal(ctx.get('opsKernel').available, true)
  } finally { host.finish(); await starting.catch(() => {}); await owner?.dispose(); await shutdown(ctx) }
})

for (const valid of [true, false]) await test(`root publishes only after a ${valid ? 'delayed' : 'failed'} kernel handshake`, async () => {
  const { ctx, tools } = await bootHost(), host = heldKernel(ctx)
  const agent = { id: 'held-root', session: { id: 'held-root', mode: 'read-only', header: { cwd: process.cwd(), agentPreset: 'native' } } }
  agent.ctx = createScope(ctx, agent).ctx
  ctx.provide('agents', { list: () => [agent] })
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'read-only', workspaceRoot: process.cwd(), sessionId: agent.id }) })
  let owner
  const starting = (async () => { owner = await ctx.plugin(Bundle, { ...quietRoot, presets: { native: nativeOptions } }) })()
  void starting.catch(() => {})
  try {
    await waitFor(() => host.launches === 1)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(tools.definitions(agent), [])
    assert.equal(ctx.get('opsKernel'), undefined)
    host.send({ type: 'ready', version: valid ? 1 : 999, pid: 123 })
    if (valid) {
      await starting
      await waitFor(() => tools.get('ops_stat', agent))
      assert.equal(ctx.get('opsKernel').available, true)
    } else {
      await assert.rejects(starting, /Invalid resident handshake/)
      assert.deepEqual(tools.definitions(agent), [])
      assert.equal(ctx.get('opsKernel'), undefined)
      assert.ok(host.exits > 0, 'failed startup awaits its owned range')
    }
    assert.equal(host.launches, 1)
  } finally { host.finish(); await starting.catch(() => {}); await owner?.dispose(); await shutdown(ctx) }
})

for (const retirement of ['consumer', 'provider']) await test(`two standalone integrations share one owned kernel across ${retirement} disposal`, () => withTempDir('resident-integrations', async root => {
  fs.writeFileSync(path.join(root, 'note.txt'), 'shared resident\n')
  const host = await realHost(root), steps = []
  const { ctx, tools } = host
  try {
    const provider = await ctx.plugin(residentKernel({ binaryPath: WORKER }))
    const client = ctx.get('opsKernel')
    assert.equal(client.available, true)
    const first = await ctx.plugin(integration({ preset: 'first', ...nativeOptions }))
    await ctx.plugin(integration({ preset: 'second', ...nativeOptions }))
    const agents = [await host.mint('first'), await host.mint('second')]
    for (const agent of agents) await nativeStat(ctx, agent)
    assert.equal(host.workerStarts().length, 1)
    assert.deepEqual(host.workerStarts()[0].argv, [WORKER, '--serve'])
    await assert.rejects(async () => await ctx.plugin(residentKernel({ binaryPath: WORKER })), /provider already belongs/)
    await assert.rejects(async () => await ctx.plugin(integration({ preset: 'conflicting-consumer', ...nativeOptions,
      binaryPath: path.join(root, 'other-worker') })), /Conflicting OPS kernel binaryPath selection/)
    await assert.rejects(async () => await ctx.plugin(integration({ preset: 'relative-consumer', ...nativeOptions,
      binaryPath: path.relative(process.cwd(), WORKER) })), /absolute path/)
    assert.equal(host.workerStarts().length, 1, 'refused owners and consumers cannot spawn a second kernel')
    if (retirement === 'consumer') {
      await first.dispose()
      assert.equal(ctx.get('opsKernel'), client)
      assert.equal(client.available, true)
      assert.equal(tools.get('ops_stat', agents[0]), undefined)
      await nativeStat(ctx, agents[1])
      assert.equal(host.workerStarts().length, 1)
    } else {
      for (const agent of agents) steps.push(await prepareStep(ctx, agent))
      await provider.dispose()
      assert.equal(client.available, false)
      assert.equal(ctx.get('opsKernel'), undefined)
      assert.equal(await host.workerStarts()[0].handle.waitForExit(AbortSignal.timeout(5000)), true)
      for (const [index, agent] of agents.entries()) {
        assert.equal(tools.executable('ops_stat', agent, steps[index].toolSet), undefined, 'provider disposal withdraws both captured admissions')
        const result = await fileCall(ctx, WORKER, 'stat', { path: 'note.txt' }, { agent }, new AbortController().signal)
        assert.equal(result.error.code, 'EXECUTOR_UNAVAILABLE', JSON.stringify(result))
        assert.equal(result.error.effectState, 'none')
        assert.ok((await diagnose(ctx, agent)).issues.some(issue => issue.code === 'RUNTIME_UNAVAILABLE'))
      }
      assert.equal(host.workerStarts().length, 1, 'retained callers cannot fall back to one-shot workers')
    }
  } finally { steps.forEach(step => step.dispose()); await shutdown(ctx) }
}))

await test('the shipped root starts one kernel and official Native/PTC file calls reuse it', () => withTempDir('resident-root', async root => {
  fs.writeFileSync(path.join(root, 'note.txt'), 'root resident\n')
  const host = await realHost(root, { ptc: true })
  const { ctx } = host
  try {
    const owner = await ctx.plugin(Bundle, { ...quietRoot, presets: {
      native: nativeOptions,
      typed: { profile: 'ptc', binaryPath: WORKER, required: true, discovery: false,
        allowedTools: ['stat'], alwaysLoaded: ['stat'], promptPolicy: false },
    } })
    const client = ctx.get('opsKernel'), pid = client.pid
    assert.equal(client.available, true)
    assert.deepEqual(host.workerStarts().map(start => start.argv), [[WORKER, '--serve']])
    const native = await host.mint('native'), typed = await host.mint('typed', 'ptc')
    for (let index = 0; index < 3; ++index) {
      await nativeStat(ctx, native)
      const result = await executeCall(ctx, { agent: typed, name: 'run_code', callId: `resident-code-${++sequence}`,
        arguments: { description: 'Read file metadata through the shared kernel', code: "return await tools.ops_stat({path:'note.txt'});" } })
      assert.equal(result.isError, false, JSON.stringify(result))
      assert.equal(result.value.result.status, 'completed', JSON.stringify(result))
      assert.equal(result.value.result.data.exists, true, JSON.stringify(result))
    }
    assert.equal(ctx.get('opsKernel'), client)
    assert.equal(client.pid, pid)
    // Node PTC owns its code-runner subprocesses. Count only OPS worker launches.
    assert.deepEqual(host.workerStarts().map(start => start.argv), [[WORKER, '--serve']], 'file calls must not spawn local one-shot OPS workers')
    await owner.dispose()
    assert.equal(client.available, false)
    assert.equal(await host.workerStarts()[0].handle.waitForExit(AbortSignal.timeout(5000)), true)
  } finally { await shutdown(ctx) }
}))

report('resident-composition')
