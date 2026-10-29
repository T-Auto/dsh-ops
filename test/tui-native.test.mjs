/** Real worker -> OPS bridges -> DSH AgentLoop -> committed Session -> admitted TUI.
 * The model and policy selection are fixtures; no network model or OS confinement claim.
 * Explicit source-worker registration does NOT widen the production platform resolver.
 */
import { existsSync, mkdirSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { Writable, PassThrough } from 'node:stream'
import { assert, test, report, skipSuite, TEST_HOME, PACKAGE_ROOT, waitFor, tick } from './lib/harness.mjs'
import { installPresentationCompat } from './lib/tools-presentation.mjs'
import { NativeFileTools } from '../lib/file/runtime.js'
import { createActivityStore } from '../lib/tui/activity.js'

if (!process.env.DSH_OPS_TUI_ROOT || !process.env.DSH_OPS_TUI_WORKER) {
  const reason = 'set DSH_OPS_TUI_ROOT and DSH_OPS_TUI_WORKER (an explicitly source-built native worker)'
  if (process.env.DSH_OPS_REQUIRE_NATIVE_TUI === '1') throw new Error(reason)
  skipSuite('native TUI', reason)
}
const worker = resolve(process.env.DSH_OPS_TUI_WORKER)
assert.ok(existsSync(worker), 'Explicit worker must exist; no download or build during tests.')
const version = spawnSync(worker, ['--version'], { encoding: 'utf8', timeout: 10000 })
assert.equal(version.status, 0, version.stderr)
const packageVersion = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version
assert.equal(version.stdout.trim(), 'dsh-ops-worker ' + packageVersion)
const { Context, Loader, React, Terminal, hostRow, TuiPanelRuntime, armAdmissionLoader,
  panelStore, PanelHost, ui, runtimeModule, unregister, createInputRuntime } = await import('./lib/tui-host.mjs')
const [Agents, Sessions, Projections, Prompt, Tools, Loop] = await Promise.all([
  'dsh-agent', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent-loop',
].map(name => runtimeModule('@deepseek-ai/' + name).then(module => module.default)))
const { createUserMessage } = await runtimeModule('@deepseek-ai/dsh-llm')
// This existing OPS dev dependency is a real provider, not a child_process mock.
const { default: Subprocess } = await import('@deepseek-ai/dsh-subprocess-local')
const root = new Context(); root.logger.level = 0
const workspace = join(TEST_HOME, 'workspace'), composition = join(TEST_HOME, 'composition')
mkdirSync(workspace); mkdirSync(join(composition, 'node_modules'), { recursive: true })
symlinkSync(PACKAGE_ROOT, join(composition, 'node_modules', 'dsh-ops'), process.platform === 'win32' ? 'junction' : 'dir')
writeFileSync(join(workspace, 'PRIVATE_FILE.txt'), 'PRIVATE_BODY\nsecond line\nthird line\n')
writeFileSync(join(workspace, 'other.txt'), 'PRIVATE_OTHER\n')
const id = 'dsh-ops-tui:overview', observed = createActivityStore()
const scripts = new Map(), events = [], failures = [], modes = new Map()
let modelCalls = 0, native, app, term, sessionId = 'native-fixture', showPanel = true
const channel = () => ({ sessionId, version: events.length, cwd: workspace, working: false, spinnerMode: 'idle',
  todos: [], subagents: [], backgroundJobs: [], rows: [], notify() {}, subscribe() { return () => {} } })
const runtime = createInputRuntime()
const controller = { enabledPanelIds: [id], activePanelId: id, focus: 'chat', zoom: false, runtime }
const tree = () => React.createElement(ui.ThemeProvider, { theme: 'dark' }, React.createElement(ui.Box, null,
  React.createElement(ui.Box, { width: 10 }, React.createElement(ui.Text, null, 'chat-ok')),
  showPanel ? React.createElement(PanelHost, { controller, channel: channel(), width: 38, height: 22 }) : null))
const screen = () => Array.from({ length: 24 }, (_, y) => term.buffer.active.getLine(term.buffer.active.baseY + y)?.translateToString(true) ?? '').join('\n')
const run = async (agent, name, args, mode = 'danger-full-access') => {
  const callId = 'worker-' + events.length
  modes.set(agent.id, mode)
  scripts.set(agent.id, [[{ id: callId, name, args }], []])
  const before = modelCalls
  // DSH 0.2.1 loops classify queued input by source; a user turn must say it is one.
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run the scripted fixture.' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  assert.deepEqual(failures, [])
  assert.equal(modelCalls, before + 2, 'one scripted tool response and one final response')
  assert.equal(scripts.get(agent.id).length, 0)
  const result = events.find(event => event.type === 'tool/result' && event.data.message.source.callId === callId)
  assert.ok(result, 'the real loop must commit a tool result')
  // Native text is for the model; the panel reads the replayable presentation facts instead.
  assert.equal(result.data.message.content[0].text.startsWith('{'), false)
  return result.data.meta.opsOutcome
}
try {
  await root.plugin(Loader, { baseUrl: pathToFileURL(join(composition, 'cordis.yml')).href })
  await root.plugin({ name: hostRow.name, apply: hostRow.apply }); await root.plugin(TuiPanelRuntime)
  armAdmissionLoader(root)
  await root.loader.create({ id: 'ops-sidebar', name: 'dsh-ops/tui', config: { recentLimit: 3 } })
  await root.loader.await()
  await waitFor(() => panelStore.get(id) !== undefined, { what: 'admitted native-test sidebar' })
  await root.plugin(Agents); await root.plugin(Sessions); await root.plugin(Projections)
  await root.plugin(Prompt, {}); await root.plugin(Subprocess)
  // 0.2.2 drives presentation through executor plugins; the rc2 line uses `mode` config.
  if (await installPresentationCompat(await import('@deepseek-ai/dsh-tools'))) {
    await root.plugin(Tools, {})
    await root.plugin(await import('@deepseek-ai/dsh-tool-executor-native'))
  } else {
    await root.plugin(Tools, { mode: 'native' })
  }
  await root.plugin(ctx => {
    ctx.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: modes.get(session.id) ?? 'danger-full-access', workspaceRoot: workspace }) })
    ctx.provide('llm', { async prepareCall(config) { return { config, adapterDefaults: {}, stream: async function* (request) {
      const queue = scripts.get(request.sessionId)
      assert.ok(queue?.length, 'unscripted model request is forbidden'); modelCalls++
      const calls = queue.shift()
      for (const [index, call] of calls.entries()) yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: JSON.stringify(call.args) }
      if (!calls.length) yield { type: 'text-delta', index: 0, text: 'Fixture settled.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } } } })
    ctx.on('agent/error', ({ error }) => failures.push(String(error?.stack ?? error)))
    ctx.on('session/event', (session, event) => {
      assert.ok(session.seq > event.seq, 'notification is post-commit, not optimistic')
      assert.ok(Object.isFrozen(event))
      events.push(event); observed.observe(session.id, event)
    })
  })
  await root.plugin({ inject: ['tools'], async apply(ctx) {
    native = new NativeFileTools({ ctx, config: { workerPath: worker, required: true } })
    await native.start(); ctx.effect(() => () => native.stop())
  } })
  await root.plugin(Loop, { agents: [], maxParallelToolCalls: 2 })
  const handle = await root.agents.create({ sessionId, meta: { cwd: workspace }, agentOptions: { provider: 'fixture', model: 'scripted' } })
  const agent = handle.agent
  term = new Terminal({ cols: 50, rows: 24, scrollback: 100, allowProposedApi: true })
  class Output extends Writable { columns = 50; rows = 24; isTTY = true; _write(chunk, _encoding, done) { term.write(String(chunk), done) } }
  class Input extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }
  app = await ui.render(tree(), { stdout: new Output(), stdin: new Input(), stderr: new Writable({ write(_chunk, _encoding, done) { done() } }), patchConsole: false, exitOnCtrlC: false })

  await test('real worker file result passes through the real loop and committed events into the panel', async () => {
    const value = await run(agent, 'ops_inspect_local_file', { path: 'PRIVATE_FILE.txt', limit: 1 })
    assert.equal(value.status, 'completed'); assert.equal(value.complete, false)
    const snapshot = observed.snapshot(agent.id)
    assert.equal(snapshot.total, 1); assert.equal(snapshot.business.completed, 1)
    assert.equal(snapshot.recent[0].complete, false)
    await waitFor(() => screen().includes('Returned 1') && screen().includes('ops_inspect_local_file'), { what: 'real file result frame' })
    for (const secret of ['PRIVATE_BODY', 'PRIVATE_FILE', workspace]) assert.equal(screen().includes(secret), false)
  })
  await test('read-only refusal remains a business rejection, not a transport error or mutation', async () => {
    const before = readFileSync(join(workspace, 'PRIVATE_FILE.txt'), 'utf8')
    const value = await run(agent, 'ops_replace', { path: 'PRIVATE_FILE.txt', pattern: 'PRIVATE_BODY', replacement: 'CHANGED' }, 'read-only')
    assert.equal(value.error.code, 'POLICY_DENIED'); assert.equal(readFileSync(join(workspace, 'PRIVATE_FILE.txt'), 'utf8'), before)
    const snapshot = observed.snapshot(agent.id)
    assert.equal(snapshot.returned, 2); assert.equal(snapshot.errors, 0); assert.equal(snapshot.business.rejected, 1)
    await waitFor(() => screen().includes('POLICY_DENIED'), { what: 'refusal code in actual panel' })
  })
  await test('real native business errors are not upgraded to successful returns', async () => {
    const value = await run(agent, 'ops_inspect_local_file', { path: 'PRIVATE_MISSING.txt' })
    assert.equal(value.status, 'error')
    assert.equal(observed.snapshot(agent.id).business.error, 1)
    await waitFor(() => screen().includes(value.error.code), { what: 'real worker error frame' })
    assert.equal(screen().includes('PRIVATE_MISSING'), false)
  })
  await test('real bounded file pages and dry-run replacement remain observations, not additional work', async () => {
    const page = await run(agent, 'ops_glob', { pattern: ['*.txt'], limit: 1 })
    assert.equal(page.status, 'completed'); assert.equal(page.complete, false)
    assert.equal(observed.snapshot(agent.id).recent[0].complete, false)
    const before = readFileSync(join(workspace, 'PRIVATE_FILE.txt'), 'utf8')
    const value = await run(agent, 'ops_replace', { path: 'PRIVATE_FILE.txt', pattern: 'PRIVATE_BODY', replacement: 'CHANGED', dryRun: true })
    assert.equal(value.status, 'completed'); assert.equal(value.dryRun, true)
    assert.equal(readFileSync(join(workspace, 'PRIVATE_FILE.txt'), 'utf8'), before)
    assert.equal(observed.snapshot(agent.id).recent[0].outcome, 'planned')
    await waitFor(() => screen().includes('Returned 5') && screen().includes('preview/plan'), { what: 'real dry-run facts' })
  })

  await test('session switches, hidden observation and rerenders add no tool calls or model requests', async () => {
    const count = events.length, requests = modelCalls, returned = observed.snapshot(agent.id).returned
    sessionId = 'other'; app.rerender(tree())
    await waitFor(() => screen().includes('Calls 0'), { what: 'empty different session' })
    sessionId = agent.id; app.rerender(tree())
    await waitFor(() => screen().includes('Returned ' + returned), { what: 'native session restored' })
    showPanel = false; app.rerender(tree()); await waitFor(() => !screen().includes('Calls'), { what: 'native panel hidden' })
    await run(agent, 'ops_glob', { pattern: ['*.txt'], limit: 1 })
    showPanel = true; app.rerender(tree())
    await waitFor(() => screen().includes('Returned ' + (returned + 1)), { what: 'real call while panel unmounted' })
    const settled = events.length
    controller.focus = 'panel'; app.rerender(tree())
    await waitFor(() => runtime.isEnabled(id), { what: 'real-worker panel navigation focus' })
    runtime.dispatchKey(id, 'f')
    await waitFor(() => screen().includes('Running · 1/1 · kept 0'), { what: 'real-worker running filter' })
    runtime.dispatchKey(id, 'f')
    await waitFor(() => screen().includes('Anomalies · 1/1 · kept 0'), { what: 'real-worker retained anomaly filter' })
    runtime.dispatchKey(id, 'n'); runtime.dispatchKey(id, 'p')
    app.rerender(tree()); await tick()
    assert.ok(settled > count); assert.equal(events.length, settled); assert.equal(modelCalls, requests + 2)
    assert.equal(JSON.stringify(observed.snapshot(agent.id)).includes('PRIVATE_'), false)
  })
  await handle.dispose()
} finally {
  await app?.unmount(); term?.dispose(); await root.fiber.dispose(); observed.dispose(); unregister?.()
}
report('native worker / loop / TUI')
