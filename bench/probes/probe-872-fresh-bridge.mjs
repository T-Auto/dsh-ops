/** Production root fresh activation: real Native/PTC, public confinement, spill and Jobs; no model API. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
const args = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [process.argv[2 + i * 2].replace(/^--/, ''), process.argv[3 + i * 2]]))
for (const key of ['worker', 'controller', 'shell-env', 'bash', 'report']) assert.ok(args[key], `--${key} required`)
assert.equal(process.platform, 'win32')
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-fresh-bridge-home-')), workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-fresh-bridge-work-'))
process.env.DSH_HOME = home
const names = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-sandbox-policy', '@deepseek-ai/dsh-subprocess-local', '@deepseek-ai/dsh-sandbox-local',
  '@deepseek-ai/dsh-fs-local', '@deepseek-ai/dsh-working-directory', '@deepseek-ai/dsh-jobs-local',
  '@deepseek-ai/dsh-tool-executor-native', '@deepseek-ai/dsh-ptc-runtime-node']
const [{ Context }, Agents, Sessions, Projections, Prompt, Tools, Llm, Loop, Policy, Subprocess, Sandbox, FileSystem, Directory, Jobs, Native, NodePtc] = await Promise.all(names.map(name => import(name)))
const [ToolJobs, ShellEnv] = await Promise.all(['controller', 'shell-env'].map(key => import(pathToFileURL(path.resolve(args[key])).href)))
const Bundle = await import('../../lib/index.js')
const { getSpillLedger } = await import('../../lib/shells/spill-ledger.js')
const { executeCall, selectExecutor } = await import('../../test/lib/executor.mjs')
const ctx = new Context(); ctx.logger.level = 0
const report = { kind: 'production-root-fresh-policy-bridge-real-public-host', started: new Date().toISOString(), workspace, home,
  worker: args.worker, workerSha256: hash(args.worker), bash: args.bash, bashSha256: hash(args.bash), checks: [], events: [], spawns: [],
  limitations: ['Actual package-root activation with explicit verified worker and stock fresh Bash paths; no authority-service injection.',
    'Windows workspace-write confinement reports partial enforcement. No persistent session, performance or model-API claim.'] }
let client, row, next = 0
const handles = []
class ObservedSubprocess extends Subprocess.default {
  spawn(spec) { report.spawns.push({ argv: [...spec.argv] }); return super.spawn(spec) }
}
class ObservedSandbox extends Sandbox.default {
  async confine(...values) { const result = await super.confine(...values); report.events.push({ type: 'public-confine', mode: values[1].mode,
    enforcement: result.enforcement, executable: result.argv[0] }); return result }
}
async function until(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  for (;;) { const value = predicate(); if (value) return value; if (Date.now() >= deadline) throw new Error(`${label} timed out`); await delay(10) }
}
async function within(promise, label, timeout = 20000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeout) })]) }
  finally { clearTimeout(timer) }
}
async function check(name, run) {
  try { const detail = await run(); report.checks.push({ name, status: 'passed', detail }); console.log(`ok ${name}`) }
  catch (error) { report.checks.push({ name, status: 'failed', error: String(error.stack ?? error) }); console.error(`FAIL ${name}: ${error.stack ?? error}`) }
}
async function agent(mode = 'native') {
  const handle = await ctx.agents.create({ sessionId: `fresh-bridge-${++next}`, meta: { cwd: workspace, agentPreset: `fresh-${mode}` }, agentOptions: { provider: 'fixture', model: 'never' } })
  handles.push(handle)
  await handle.agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, mode) } })
  await until(() => ctx.tools.get('ops_bash', handle.agent), 'Bash publication')
  return handle
}
async function call(handle, name, values, signal) {
  const result = await within(executeCall(ctx, { agent: handle.agent, name, arguments: values, signal, callId: `fresh-bridge-${++next}` }), name)
  assert.equal(result.isError, false, JSON.stringify(result)); return result.value
}
const bashCall = (handle, values, signal) => call(handle, 'ops_bash', { description: 'Exercise the native fresh policy bridge', ...values }, signal)
const taskCount = () => report.events.filter(event => event.type === 'task.execute').length
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`
const longCommand = `${shellQuote(process.execPath)} -e ${shellQuote("console.log('READY');setInterval(()=>{},1000)")}`
try {
  for (const plugin of [Agents, Sessions, Projections, Prompt, Tools, Llm, Native]) await ctx.plugin(plugin.default ?? plugin, {})
  await ctx.plugin(Policy.default, { mode: 'workspace-write', workspaceRoot: workspace })
  await ctx.plugin(ObservedSubprocess); await ctx.plugin(ObservedSandbox); await ctx.plugin(FileSystem.default, { cwd: workspace })
  await ctx.plugin(Directory.default, { defaultDirectory: workspace }); await ctx.plugin(ShellEnv, { dshHome: home })
  await ctx.plugin(inner => inner.on('llm/stream', () => { throw new Error('No model API permitted') }))
  await ctx.plugin(Loop.default, { agents: [] }); await ctx.plugin(Jobs.default, { pumpPollMs: 10 })
  await ctx.plugin(ToolJobs.default ?? ToolJobs, { completionDelivery: 'quiet', inlineOutputBytes: 0 })
  await ctx.plugin(NodePtc.default, { executionMode: 'per-call' })
  const options = { shell: true, binaryPath: path.resolve(args.worker), bashPath: path.resolve(args.bash), required: true,
    discovery: false, promptPolicy: false, allowedTools: [], alwaysLoaded: [] }
  row = await ctx.plugin(Bundle, {
    ...Object.fromEntries(['minimal', 'standard', 'ptc', 'ops-ptc', 'cordis', 'discovery',
      'download-guard', 'resultCache', 'panel', 'tui', 'disk'].map(name => [name, { enabled: false }])),
    global: { bash: true, hidePwsh: false, hideOfficialTools: false, forceDefaultOpsPtc: false },
    other: { pwsh7Link: false }, presets: {
      'fresh-native': { ...options, profile: 'native', residentNames: ['inspect_local_file'] },
      'fresh-ptc': { ...options, profile: 'ptc' },
    },
  })
  client = ctx.get('opsKernel'); report.kernelPid = client.pid; report.capabilities = [...client.task.capabilities]
  assert.ok(report.capabilities.includes('task-v1') && report.capabilities.includes('task-spill-v1'))
  assert.ok(ctx.get('opsFreshTasks')?.available, 'normal package-root activation must own the fresh authority')
  // Observe the existing channel without replacing its provider, transport or single subscriber.
  const send = client.task.send.bind(client.task), receive = client.task.receive.bind(client.task)
  client.task.send = message => { report.events.push({ type: message.type, requestId: message.requestId, lifetime: message.lifetime }); return send(message) }
  client.task.receive = message => { if (message.type.startsWith('task.')) report.events.push({ type: message.type,
    requestId: message.requestId, status: message.status, effectState: message.effectState,
    cleanupConfirmed: message.cleanupConfirmed, accepted: message.accepted }); return receive(message) }
  const native = await agent(), typed = await agent('ptc')
  await check('invalid arguments and missing wider approval enqueue no native task or Jobs record', async () => {
    const count = taskCount(), jobs = ctx.jobs.list(native.agent.id).length
    const invalid = await bashCall(native, { command: 'true', script_path: 'other.sh', run_in_background: true })
    assert.equal(invalid.failure.code, 'INVALID_BASH_ARGUMENT'); assert.equal(invalid.failure.effectState, 'none')
    const rejected = await bashCall(native, { command: 'true', sandbox_permissions: 'danger-full-access', justification: 'Exercise unavailable approval.' })
    assert.equal(rejected.failure.code, 'APPROVAL_UNAVAILABLE'); assert.equal(taskCount(), count)
    assert.equal(ctx.jobs.list(native.agent.id).length, jobs)
  })
  await check('Native fresh command retains cwd, managed env, closed stdin and both terminal streams', async () => {
    const value = await bashCall(native, { command: 'printf "managed:%s" "$DSH_SESSION_ID"; read value; printf ":stdin=%s" "$?"; printf ERR-TAIL >&2', includeDiagnostics: true })
    assert.equal(value.status, 'completed', JSON.stringify(value)); assert.equal(value.stdout.text, `managed:${native.agent.session.id}:stdin=1`)
    assert.equal(value.stderr.text, 'ERR-TAIL'); assert.equal(value.resolvedFrom.toLowerCase(), workspace.toLowerCase())
    assert.equal(value.sandbox.enforcement, 'partial'); assert.equal(value.diagnostics.executor.kind, 'resident-task')
    return { sandbox: value.sandbox, stdout: value.stdout.text, stderr: value.stderr.text }
  })
  await check('PTC uses the same fresh bridge for a relative spaced Unicode script operand', async () => {
    const script = 'script 中文 with spaces.sh'; fs.writeFileSync(path.join(workspace, script), "printf SCRIPT-TAIL; printf SCRIPT-ERR >&2\n")
    const value = await call(typed, 'run_code', { description: 'Execute an existing script through typed tools',
      code: `return await tools.ops_bash(${JSON.stringify({ description: 'Run the existing script file', script_path: script })});` })
    assert.equal(value.result.status, 'completed', JSON.stringify(value)); assert.equal(value.result.stdout.text, 'SCRIPT-TAIL')
    assert.equal(value.result.stderr.text, 'SCRIPT-ERR'); return value.result.sandbox
  })
  await check('Native and PTC expose complete spill files through the existing file recovery contract', async () => {
    const recovered = []
    for (const handle of [native, typed]) {
      const expected = `RECOVER-${handle.agent.session.id}\n` + 'x'.repeat(100000) + '\nEND'
      const command = `${shellQuote(process.execPath)} -e ${shellQuote(`require('fs').writeSync(1,${JSON.stringify(`RECOVER-${handle.agent.session.id}\n`)}+'x'.repeat(100000)+'\\nEND')`)}`
      const value = handle === native ? await bashCall(handle, { command, includeDiagnostics: true })
        : (await call(handle, 'run_code', { description: 'Collect a complete raw spill', code: `return await tools.ops_bash(${JSON.stringify({ description: 'Produce recoverable output', command, includeDiagnostics: true })});` })).result
      assert.equal(value.status, 'completed', JSON.stringify(value)); assert.equal(value.stdout.truncated, true)
      assert.equal(value.stdout.bytesTotal, Buffer.byteLength(expected)); assert.ok(value.stdout.spillPath)
      assert.equal(fs.readFileSync(value.stdout.spillPath, 'utf8'), expected)
      const entry = getSpillLedger().entries().find(entry => entry.path === value.stdout.spillPath)
      assert.equal(entry.origin, 'ops-native-v1'); assert.equal(entry.pid, client.pid)
      assert.equal(entry.sessionId, handle.agent.session.id); assert.equal(entry.bytes, Buffer.byteLength(expected))
      const input = { path: value.stdout.spillPath, offset: 1, limit: 1 }
      const read = handle === native ? await call(handle, 'ops_inspect_local_file', input)
        : (await call(handle, 'run_code', { description: 'Recover the first output line', code: `return await tools.ops_inspect_local_file(${JSON.stringify(input)});` })).result
      assert.equal(read.status, 'partial', JSON.stringify(read)); assert.ok(read.continuation)
      assert.ok(JSON.stringify(read).includes(`RECOVER-${handle.agent.session.id}`))
      recovered.push({ sessionId: entry.sessionId, bytes: entry.bytes, path: entry.path })
    }
    return recovered
  })
  await check('explicit background survives caller abort and remains owned by official Jobs controls', async () => {
    const cancellation = new AbortController(), before = taskCount()
    const value = await bashCall(native, { command: longCommand, run_in_background: true }, cancellation.signal)
    assert.equal(value.kind, 'background'); cancellation.abort()
    await until(() => ctx.jobs.readAt(value.jobId, 0, native.agent.id).chunks.some(chunk => chunk.text.includes('READY')), 'background output')
    assert.equal(taskCount(), before + 1)
    assert.throws(() => ctx.jobs.get(value.jobId, typed.agent.id))
    assert.match(JSON.stringify(await call(native, 'job_output', { job_id: value.jobId })), /READY/)
    await call(native, 'job_kill', { job_id: value.jobId })
    assert.equal((await ctx.jobs.wait(value.jobId, 10000, native.agent.id)).status, 'killed')
  })
  await check('foreground timeout promotes exactly one native task and the same public job', async () => {
    const before = taskCount(), value = await bashCall(native, { command: longCommand, timeoutMs: 1500.5, graceMs: 1.5 })
    assert.equal(value.kind, 'promoted', JSON.stringify(value)); assert.equal(taskCount(), before + 1)
    assert.equal(report.events.filter(event => event.type === 'task.promoted' && event.accepted).length, 1)
    await call(native, 'job_kill', { job_id: value.jobId }); await ctx.jobs.wait(value.jobId, 10000, native.agent.id)
  })
  await check('provider withdrawal removes both projections and refuses a retained callback without replay', async () => {
    const retained = ctx.tools.get('ops_bash', native.agent), before = taskCount()
    await row.dispose()
    await until(() => !ctx.tools.get('ops_bash', native.agent) && !ctx.tools.get('ops_bash', typed.agent), 'projection withdrawal')
    const value = await retained.execute({ command: 'true', description: 'Refuse a retired publication' }, { agent: native.agent })
    assert.equal(value.status, 'failed'); assert.equal(value.failure.effectState, 'none'); assert.equal(taskCount(), before)
    const shellStarts = report.spawns.filter(value => path.resolve(value.argv[0]).toLowerCase() === path.resolve(args.bash).toLowerCase())
    assert.equal(shellStarts.length, 0, 'the public host never spawns a per-call Bash')
    assert.equal(report.spawns.filter(value => path.resolve(value.argv[0]).toLowerCase() === path.resolve(args.worker).toLowerCase()).length, 1)
  })
} catch (error) { report.fatal = String(error.stack ?? error); console.error(report.fatal) }
finally {
  try {
    await row?.dispose()
    const settled = await Promise.allSettled(handles.map(handle => handle.dispose()))
    const failed = settled.find(value => value.status === 'rejected'); if (failed) throw failed.reason
    await ctx.fiber.dispose()
    if (client) assert.throws(() => process.kill(client.pid, 0), error => error?.code === 'ESRCH')
    report.kernelGone = true; report.cleanupConfirmed = true
  } catch (error) { report.cleanupConfirmed = false; report.cleanupError = String(error.stack ?? error) }
  report.finished = new Date().toISOString(); report.status = !report.fatal && report.cleanupConfirmed && report.checks.every(value => value.status === 'passed') ? 'passed' : 'failed'
  fs.writeFileSync(args.report, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, passed: report.checks.filter(value => value.status === 'passed').length, report: args.report }))
  if (report.status !== 'passed') process.exitCode = 1
}
