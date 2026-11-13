/** Internal task-v1 vertical: real public confinement/Jobs, no fresh-tool activation or model API. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
const args = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [process.argv[2 + i * 2].replace(/^--/, ''), process.argv[3 + i * 2]]))
for (const key of ['worker', 'controller', 'report']) assert.ok(args[key], `--${key} required`)
assert.equal(process.platform, 'win32')
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-task-host-home-')), workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-task-host-work-'))
process.env.DSH_HOME = home
const names = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-sandbox-policy', '@deepseek-ai/dsh-subprocess-local', '@deepseek-ai/dsh-sandbox-local',
  '@deepseek-ai/dsh-fs-local', '@deepseek-ai/dsh-working-directory', '@deepseek-ai/dsh-jobs-local', '@deepseek-ai/dsh-tool-executor-native']
const [{ Context }, Agents, Sessions, Projections, Prompt, Tools, Llm, Loop, Policy, Subprocess, Sandbox, FileSystem, Directory, Jobs, Native] = await Promise.all(names.map(name => import(name)))
const ToolJobs = await import(pathToFileURL(path.resolve(args.controller)).href)
const { startResident } = await import('../../lib/execution/resident/client.js')
const { createTaskExecutionHost } = await import('../../lib/execution/resident/task-owner.js')
const { runTaskJob } = await import('../../lib/execution/resident/task-jobs.js')
const { loadScrubbedParentEnv } = await import('../../lib/adapter/dsh/host.js')
const { mergeShellEnvironment, prepareShellRuntime } = await import('../../lib/execution/resident/shell-launch.js')
const { prepareWorkspace } = await import('../../lib/workspace-preparation.js')
const { executeCall } = await import('../../test/lib/executor.mjs')
const ctx = new Context(); ctx.logger.level = 0
const report = { kind: 'internal-task-v1-real-public-host', started: new Date().toISOString(), workspace, home,
  worker: args.worker, workerSha256: hash(args.worker), checks: [], events: [],
  limitations: ['No public fresh/default switch, persistent-shell claim, model request, performance or full output-spill parity claim.',
    'Fixture argv is prepared through the actual public sandbox; production fresh approval/runtime/script bridge remains pending.'] }
let client, tasks, kernelFiber, taskFiber, controllerFiber, observerFiber, next = 0
const handles = [], executions = [], parentEnv = mergeShellEnvironment(await loadScrubbedParentEnv())
async function until(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  for (;;) { const value = predicate(); if (value) return value; if (Date.now() >= deadline) throw new Error(`${label} timed out`); await delay(10) }
}
async function within(promise, label, timeout = 15000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeout) })]) }
  finally { clearTimeout(timer) }
}
async function check(name, run) {
  try { const detail = await run(); report.checks.push({ name, status: 'passed', detail }); console.log(`ok ${name}`) }
  catch (error) { report.checks.push({ name, status: 'failed', error: String(error.stack ?? error) }); console.error(`FAIL ${name}: ${error.stack ?? error}`) }
}
async function agent() {
  const handle = await ctx.agents.create({ sessionId: `task-probe-${++next}`, meta: { cwd: workspace }, agentOptions: { provider: 'fixture', model: 'never' } })
  handles.push(handle); return handle
}
function start(handle, argv, { signal, lifetime = 'foreground', timeoutMs = 10000, onExpiry, admitGate } = {}) {
  const execution = tasks.start({ agent: handle.agent, signal }, { lifetime, source: 'public-confined-fixture',
    spec: { command: 'fixture argv', workdir: workspace, timeoutMs, graceMs: 1.5, includeDiagnostics: true, onExpiry },
    async admit(admissionSignal) {
      await admitGate
      admissionSignal.throwIfAborted()
      const policy = ctx.sandboxPolicy.resolve({ session: handle.agent.session })
      const runtime = args.bash && argv[0] === args.bash
        ? await prepareShellRuntime({ file: args.bash, source: 'explicit-fresh-runtime-fixture' }, parentEnv, policy, admissionSignal) : undefined
      await prepareWorkspace(policy)
      const confined = await ctx.sandbox.confine(runtime ? [runtime.file, ...argv.slice(1)] : argv, policy, admissionSignal)
      admissionSignal.throwIfAborted()
      report.events.push({ type: 'public-confine', mode: policy.mode, enforcement: confined.enforcement, executable: confined.argv[0] })
      return { argv: confined.argv, cwd: workspace, env: mergeShellEnvironment(parentEnv, runtime?.env ?? {}) }
    } })
  executions.push(execution); return execution
}
const node = code => [process.execPath, '-e', code]
function job(handle, code, { background = true, timeoutMs = 1000, signal, admitGate } = {}) {
  return runTaskJob(ctx.jobs, { label: 'task fixture', background, timeoutMs }, { agent: handle.agent, signal },
    (call, lifetime) => start(handle, node(code), { signal: call.signal, lifetime, timeoutMs, onExpiry: 'none', admitGate }))
}
async function control(handle, name, values) {
  return executeCall(ctx, { agent: handle.agent, name, arguments: values, callId: `task-control-${++next}` })
}
try {
  for (const plugin of [Agents, Sessions, Projections, Prompt, Tools, Llm, Native]) await ctx.plugin(plugin.default ?? plugin, {})
  await ctx.plugin(Policy.default, { mode: 'workspace-write', workspaceRoot: workspace })
  await ctx.plugin(Subprocess.default); await ctx.plugin(Sandbox.default); await ctx.plugin(FileSystem.default, { cwd: workspace })
  await ctx.plugin(Directory.default, { defaultDirectory: workspace })
  await ctx.plugin(inner => inner.on('llm/stream', () => { throw new Error('No model API permitted') }))
  await ctx.plugin(Loop.default, { agents: [] }); await ctx.plugin(Jobs.default, { pumpPollMs: 10 })
  controllerFiber = await ctx.plugin(ToolJobs.default ?? ToolJobs, { completionDelivery: 'quiet', inlineOutputBytes: 0 })
  kernelFiber = await ctx.plugin({ name: 'task-probe-kernel', inject: ['subprocess'], async apply(inner) { client = await startResident(inner, args.worker, workspace) } })
  assert.ok(client.task.capabilities.includes('task-v1')); report.kernelPid = client.pid
  const transport = { get available() { return client.task.available }, get capabilities() { return client.task.capabilities },
    read: (...values) => client.task.read(...values), abort: error => client.task.abort(error),
    send(message) { report.events.push({ type: message.type, requestId: message.requestId, ownerKey: message.ownerKey, lifetime: message.lifetime }); return client.task.send(message) },
    subscribe(listener) { return client.task.subscribe(message => { report.events.push({ type: message.type, requestId: message.requestId,
      status: message.status, effectState: message.effectState, cleanupConfirmed: message.cleanupConfirmed, accepted: message.accepted }); listener(message) }) } }
  taskFiber = await ctx.plugin({ name: 'task-probe-owner', inject: ['agents'], apply(inner) { tasks = createTaskExecutionHost(inner, transport) } })

  await check('public-confined fresh task joins both terminal tails and closed stdin', async () => {
    const handle = await agent(), execution = start(handle, node("process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('EOF-HEAD');setTimeout(()=>{process.stdout.write('-TAIL');process.stderr.write('ERR-TAIL')},60)})"))
    const value = await within(execution.result(), 'fresh terminal')
    assert.equal(value.error, undefined); assert.equal(value.stdout.text, 'EOF-HEAD-TAIL'); assert.equal(value.stderr.text, 'ERR-TAIL')
    assert.equal(execution.started, true); assert.equal(execution.cleanupConfirmed, true)
    return { stdout: value.stdout.text, stderr: value.stderr.text }
  })
  await check('explicit background handoff survives caller abort and official controls fence owners', async () => {
    const handle = await agent(), sibling = await agent(), cancellation = new AbortController()
    const value = await job(handle, "console.log('PID='+process.pid);setInterval(()=>{},1000)", { signal: cancellation.signal })
    assert.equal(value.kind, 'background'); cancellation.abort()
    await until(() => ctx.jobs.readAt(value.jobId, 0, handle.agent.id).chunks.some(chunk => chunk.text.includes('PID=')), 'live job output')
    assert.throws(() => ctx.jobs.get(value.jobId, sibling.agent.id))
    assert.match(JSON.stringify(await control(handle, 'job_list', {})), new RegExp(value.jobId))
    const observed = ctx.jobs.readAt(value.jobId, 0, handle.agent.id)
    assert.deepEqual(ctx.jobs.readAt(value.jobId, 0, handle.agent.id), observed)
    assert.match(JSON.stringify(await control(handle, 'job_output', { job_id: value.jobId })), /PID=/)
    await control(handle, 'job_kill', { job_id: value.jobId })
    const terminal = await within(ctx.jobs.wait(value.jobId, 10000, handle.agent.id), 'killed job')
    assert.equal(terminal.status, 'killed')
    assert.equal(executions.at(-1).cleanupConfirmed, true)
    return { jobId: value.jobId, status: terminal.status }
  })
  await check('foreground expiry promotes the original physical task and existing job record', async () => {
    const handle = await agent(), before = report.events.length
    const value = await job(handle, "console.log('START');setInterval(()=>{},1000)", { background: false, timeoutMs: 1500 })
    assert.equal(value.kind, 'promoted', JSON.stringify(value))
    const frames = report.events.slice(before)
    assert.equal(frames.filter(event => event.type === 'task.execute').length, 1)
    assert.equal(frames.filter(event => event.type === 'task.promoted' && event.accepted).length, 1)
    ctx.jobs.kill(value.jobId, handle.agent.id, 'fixture finished')
    await within(ctx.jobs.wait(value.jobId, 10000, handle.agent.id), 'promoted cleanup')
    assert.equal(executions.at(-1).cleanupConfirmed, true)
    return { jobId: value.jobId }
  })
  await check('cancel during native head preparation joins without physical effects or late launch', async () => {
    const handle = await agent(), gate = Promise.withResolvers(), cancellation = new AbortController(), before = report.events.length
    const execution = start(handle, node("throw Error('MUST_NOT_RUN')"), { signal: cancellation.signal, admitGate: gate.promise })
    await until(() => report.events.slice(before).some(event => event.type === 'task.admit'), 'native admit')
    cancellation.abort(); const value = await within(execution.result(), 'head cancellation')
    assert.equal(execution.effectState, 'none'); assert.equal(execution.started, false); assert.equal(execution.cleanupConfirmed, true)
    gate.resolve(); await delay(20)
    assert.equal(report.events.slice(before).some(event => event.type === 'task.admission'), false)
    assert.equal(value.cancelled, true)
  })
  await check('real Agent disposal joins its background task while sibling remains controllable', async () => {
    const first = await agent(), second = await agent()
    const left = await job(first, "console.log('LEFT');setInterval(()=>{},1000)"), right = await job(second, "console.log('RIGHT');setInterval(()=>{},1000)")
    await until(() => ctx.jobs.readAt(left.jobId, 0, first.agent.id).chunks.length && ctx.jobs.readAt(right.jobId, 0, second.agent.id).chunks.length, 'both owners live')
    await within(first.dispose(), 'Agent cleanup')
    assert.equal(ctx.jobs.get(right.jobId, second.agent.id).status, 'running')
    ctx.jobs.kill(right.jobId, second.agent.id, 'fixture finished'); await ctx.jobs.wait(right.jobId, 10000, second.agent.id)
    assert.ok(executions.slice(-2).every(execution => execution.cleanupConfirmed))
  })
  await check('tail budget keeps latest bytes on both streams before terminal settlement', async () => {
    const handle = await agent(), execution = start(handle, node("process.stdout.write('A'.repeat(200000)+'TAIL');process.stderr.write('B'.repeat(180000)+'END')"))
    const value = await within(execution.result(), 'bounded tail')
    assert.equal(value.error, undefined); assert.equal(value.stdout.bytesTotal, 200004); assert.equal(value.stderr.bytesTotal, 180003)
    assert.equal(value.stdout.text, 'A'.repeat(63996) + 'TAIL'); assert.equal(value.stderr.text, 'B'.repeat(63997) + 'END')
    assert.equal(value.stdout.truncated, true); assert.equal(value.stderr.truncated, true)
    return { stdoutTotal: value.stdout.bytesTotal, stderrTotal: value.stderr.bytesTotal, spillObserved: !!value.stdout.spillPath }
  })
  if (args.bash) await check('explicit fresh Bash runtime executes command and spaced Unicode script argv', async () => {
    report.bash = args.bash; report.bashSha256 = hash(args.bash)
    const handle = await agent(), script = path.join(workspace, 'script 中文 with spaces.sh')
    fs.writeFileSync(script, "printf 'script-value:%s' \"$1\"\nprintf 'script-err' >&2\n")
    const first = await start(handle, [args.bash, '-c', "printf command-ok; read value; printf ':stdin=%s' \"$?\""]).result()
    assert.equal(first.error, undefined); assert.equal(first.stdout.text, 'command-ok:stdin=1')
    const second = await start(handle, [args.bash, script, 'spaced value']).result()
    assert.equal(second.error, undefined); assert.equal(second.stdout.text, 'script-value:spaced value'); assert.equal(second.stderr.text, 'script-err')
    return { runtime: args.bash, sha256: report.bashSha256 }
  })
} catch (error) { report.fatal = String(error.stack ?? error); console.error(report.fatal) }
finally {
  try {
    await tasks?.dispose(); await taskFiber?.dispose()
    await within(Promise.all(executions.map(execution => execution.done)), 'all task cleanup')
    await Promise.all(handles.map(handle => handle.dispose()))
    await observerFiber?.dispose(); await controllerFiber?.dispose(); await kernelFiber?.dispose(); await ctx.fiber.dispose()
    if (client) assert.throws(() => process.kill(client.pid, 0), error => error?.code === 'ESRCH')
    report.kernelGone = true; report.cleanupConfirmed = true
  } catch (error) { report.cleanupConfirmed = false; report.cleanupError = String(error.stack ?? error) }
  report.finished = new Date().toISOString(); report.status = !report.fatal && report.cleanupConfirmed && report.checks.every(value => value.status === 'passed') ? 'passed' : 'failed'
  fs.writeFileSync(args.report, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, passed: report.checks.filter(value => value.status === 'passed').length, report: args.report }))
  if (report.status !== 'passed') process.exitCode = 1
}
