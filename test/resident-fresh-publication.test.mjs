/** Real scoped publication with a scripted kernel boundary, not a process/spill proof. */
import { mountSessionBash } from '../lib/session-shells.js'
import { residentFreshTasks, supportsFreshTasks } from '../lib/execution/resident/fresh-provider.js'
import { renderHostBash } from '../lib/shells/host-contract.js'
import { createResidentTaskJobs } from './lib/resident-task-jobs.mjs'
import { completedTask, taskTransport, turn } from './lib/resident-task-transport.mjs'
import { assert, test, report, waitFor, TEST_HOME } from './lib/harness.mjs'

async function setup({ capabilities = ['task-v1'], environment = true, firstOnly = false } = {}) {
  const f = await createResidentTaskJobs({ cwd: TEST_HOME }), wire = taskTransport()
  wire.transport.capabilities = capabilities
  let oldSpawns = 0
  const kernel = { task: wire.transport, available: true }
  await f.ctx.plugin(ctx => {
    ctx.provide('opsKernel', kernel)
    ctx.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: 'danger-full-access', workspaceRoot: TEST_HOME, sessionId: session.id }) })
    ctx.provide('subprocess', { spawn() {
      ++oldSpawns
      return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: {} }
    } })
  })
  if (environment) await f.ctx.plugin(ctx => ctx.provide('shellEnv', { collect: () => ({}) }))
  const provider = f.ctx.plugin(residentFreshTasks())
  if (environment) await provider
  const row = await f.ctx.plugin(ctx => mountSessionBash(ctx, { publishBashTool: true },
    { bash: { available: true, file: process.execPath, source: 'config' } }, { allows: agent => !firstOnly || agent === f.agent }))
  wire.onFrame(value => {
    if (value.type === 'task.execute') queueMicrotask(() => wire.emit({ type: 'task.admit', requestId: value.requestId }))
    if (value.type === 'task.admission') queueMicrotask(() => {
      if (value.decision === 'launch') wire.emit({ type: 'task.started', requestId: value.requestId })
      wire.emit(completedTask(value.requestId, value.decision === 'reject'
        ? { status: 'rejected', exitCode: null, effectState: 'none', error: value.error } : {}))
    })
    if (value.type === 'task.closeOwner') queueMicrotask(() => wire.emit({ type: 'task.ownerClosed', requestId: value.requestId, cleanupConfirmed: true }))
  })
  const tool = () => f.ctx.get('tools').get('ops_bash', f.agent)
  return { ...f, wire, kernel, provider, row, tool, oldSpawns: () => oldSpawns,
    async close() { await row.dispose(); await provider.dispose(); await f.dispose() } }
}
const command = { command: 'fixture', description: 'Exercise the selected fresh task backend' }

await test('both exact capabilities are required; the tail-only kernel leaves fresh publication unchanged', async () => {
  for (const capabilities of [[], ['task-v1'], ['task-spill-v1'], ['task-v1', 'task-spill-v0']]) assert.equal(supportsFreshTasks(capabilities), false)
  assert.equal(supportsFreshTasks(['task-v1', 'task-spill-v1']), true)
  const f = await setup()
  try {
    await waitFor(() => f.tool())
    assert.equal(f.ctx.get('opsFreshTasks'), undefined)
    const value = await f.tool().execute(command, { agent: f.agent })
    assert.equal(value.status, 'completed', JSON.stringify(value))
    assert.equal(f.oldSpawns(), 1)
    assert.equal(f.wire.frames.length, 0, 'the capability gate does not enqueue native tasks')
    assert.equal(f.tool().parameters.properties.execution, undefined, 'fresh argument schema is unchanged')
  } finally { await f.close() }
})

await test('complete-capability publication waits for its authority owner; no fallback runs while pending', async () => {
  const f = await setup({ capabilities: ['task-v1', 'task-spill-v1'], environment: false })
  try {
    await turn(); await turn()
    assert.equal(f.tool(), undefined)
    assert.equal(f.oldSpawns(), 0)
    assert.equal(f.ctx.get('opsFreshTasks'), undefined)
    await f.ctx.plugin(ctx => ctx.provide('shellEnv', { collect: () => ({}) }))
    await waitFor(() => f.ctx.get('opsFreshTasks')?.available === true, { timeoutMs: 2000, what: 'dependency-ready authority' })
    await waitFor(() => f.tool())
    assert.equal(f.ctx.get('opsFreshTasks').available, true)
    const result = await f.execute('ops_bash', command)
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.equal(result.value.kind, 'foreground'); assert.equal(result.value.status, 'completed')
    assert.equal(f.wire.frames.filter(value => value.type === 'task.execute').length, 1)
    assert.equal(f.oldSpawns(), 0)
  } finally { await f.close() }
})

await test('one shared provider serves siblings; withdrawing it revokes retained callbacks without old-runner replay', async () => {
  const f = await setup({ capabilities: ['task-v1', 'task-spill-v1'] })
  try {
    await waitFor(() => f.ctx.get('opsFreshTasks')?.available === true, { timeoutMs: 2000, what: 'complete authority provider' })
    await waitFor(() => f.tool())
    await assert.rejects(async () => await f.ctx.plugin(residentFreshTasks()), /already belongs|already registered|already been registered/i)
    const sibling = await f.createAgent()
    await waitFor(() => f.ctx.get('tools').get('ops_bash', sibling.agent))
    const retained = f.tool()
    for (const agent of [f.agent, sibling.agent]) {
      const value = await f.ctx.get('tools').get('ops_bash', agent).execute(command, { agent })
      assert.equal(value.status, 'completed', JSON.stringify(value))
    }
    const owners = f.wire.frames.filter(value => value.type === 'task.execute').map(value => value.ownerKey)
    assert.equal(new Set(owners).size, 2)
    await f.provider.dispose()
    await waitFor(() => !f.tool() && !f.ctx.get('tools').get('ops_bash', sibling.agent))
    const refused = await retained.execute(command, { agent: f.agent })
    assert.equal(refused.status, 'failed'); assert.equal(refused.failure.effectState, 'none')
    assert.equal(f.oldSpawns(), 0)
    assert.equal(f.wire.frames.filter(value => value.type === 'task.execute').length, 2)
    assert.equal(f.wire.frames.filter(value => value.type === 'task.closeOwner').length, 2)
  } finally { await f.close() }
})

await test('an incomplete denial observation is visible without turning missing diagnostics into a denial', () => {
  const text = renderHostBash({ kind: 'foreground', status: 'completed', exitCode: 0, signal: null, aborted: false,
    timedOut: false, timeoutMs: 1, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: true },
    sandbox: { mode: 'workspace-write', denied: false, enforcement: 'partial', denialObservation: 'incomplete' } })
  assert.match(text, /retained output cannot exclude a denial/)
  assert.doesNotMatch(text, /file access denied under/)
})

await test('a retained publication cannot admit a different actual Agent excluded by its row gate', async () => {
  const f = await setup({ capabilities: ['task-v1', 'task-spill-v1'], firstOnly: true })
  try {
    await waitFor(() => f.tool())
    const excluded = await f.createAgent()
    await turn(); await turn()
    assert.equal(f.ctx.get('tools').get('ops_bash', excluded.agent), undefined)
    const value = await f.tool().execute(command, { agent: excluded.agent })
    assert.equal(value.status, 'failed'); assert.equal(value.failure.effectState, 'none')
    assert.equal(f.wire.frames.filter(frame => frame.type === 'task.execute').length, 0)
    assert.equal(f.oldSpawns(), 0)
  } finally { await f.close() }
})

report('resident-fresh-publication')
