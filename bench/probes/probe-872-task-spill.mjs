/** Real task-v1 capture, public Jobs API and the existing file/retention path. No model call. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import { residentKernel } from '../../lib/execution/resident/provider.js'
import { createTaskExecutionHost } from '../../lib/execution/resident/task-owner.js'
import { runTaskJob } from '../../lib/execution/resident/task-jobs.js'
import { loadScrubbedParentEnv } from '../../lib/adapter/dsh/host.js'
import { mergeShellEnvironment } from '../../lib/execution/resident/shell-launch.js'
import { invoke as fileCall } from '../../lib/execution/files.js'
import { getSpillLedger } from '../../lib/shells/spill-ledger.js'
import { sweepSpills } from '../../lib/shells/spill-retention.js'
import { prepareWorkspace } from '../../lib/workspace-preparation.js'

assert.equal(process.platform, 'win32')
const worker = path.resolve(process.argv[2]), output = path.resolve(process.argv[3])
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-task-spill-')))
process.env.DSH_HOME = path.join(workspace, 'home'); fs.mkdirSync(process.env.DSH_HOME)
const { createResidentTaskJobs } = await import('../../test/lib/resident-task-jobs.mjs')
const report = { kind: 'internal-native-task-spill', worker,
  workerSha256: createHash('sha256').update(fs.readFileSync(worker)).digest('hex'), workspace,
  checks: [], confinement: [], limitations: ['Public Jobs registry API; official controller tools have separate coverage.',
    'Explicit internal task factory, not production fresh approval or persistent-shell activation.'] }
let host, tasks, client
const executions = [], sealed = new Set(), observed = new Set()
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
async function until(predicate, label, milliseconds = 15000) {
  const deadline = Date.now() + milliseconds
  for (;;) { const value = await predicate(); if (value) return value; if (Date.now() > deadline) throw Error(`${label} timed out`); await delay(10) }
}
async function within(promise, label, milliseconds = 15000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} timed out`)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
async function check(name, run) {
  const detail = await run(); report.checks.push({ name, status: 'passed', detail }); console.log(`ok ${name}`)
}
try {
  host = await createResidentTaskJobs({ cwd: workspace, jobsConfig: { pumpPollMs: 10 }, initialAgents: 2 })
  const { ctx, agent } = host
  await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: workspace })
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox, {}); await ctx.plugin(FileSystem, { cwd: workspace })
  await ctx.plugin(residentKernel({ binaryPath: worker }))
  client = ctx.get('opsKernel'); observed.add(client.pid); report.kernelPid = client.pid
  assert.ok(client.task.capabilities.includes('task-spill-v1'))
  await ctx.plugin({ inject: ['agents'], apply(inner) { tasks = createTaskExecutionHost(inner, client.task) } })
  const env = mergeShellEnvironment(await loadScrubbedParentEnv())
  function start(code, call = { agent }, lifetime = 'foreground', onExpiry) {
    const execution = tasks.start(call, { lifetime, source: 'confined-task-spill-fixture',
      spec: { command: 'fixture argv', workdir: workspace, timeoutMs: 20000, graceMs: 1.5, includeDiagnostics: true, onExpiry },
      async admit(signal) {
        const policy = ctx.sandboxPolicy.resolve({ session: call.agent.session })
        await prepareWorkspace(policy)
        const confined = await ctx.sandbox.confine([process.execPath, '-e', code], policy, signal)
        signal.throwIfAborted(); report.confinement.push({ mode: policy.mode, enforcement: confined.enforcement })
        return { argv: confined.argv, cwd: workspace, env }
      } })
    executions.push(execution); return execution
  }
  async function background(code) {
    const before = executions.length
    const result = await runTaskJob(ctx.jobs, { label: 'spill fixture', background: true, timeoutMs: 1000 }, { agent },
      (call, lifetime) => start(code, call, lifetime, 'none'))
    assert.equal(result.kind, 'background')
    await until(() => executions.length > before && executions.at(-1)?.started, 'background physical start')
    return { jobId: result.jobId, execution: executions.at(-1) }
  }
  const ledger = getSpillLedger()
  await check('exact memory boundary remains memory-only', async () => {
    const value = await within(start("require('fs').writeSync(1,Buffer.alloc(64000,120))").result(), 'memory boundary')
    assert.equal(value.error, undefined); assert.equal(value.stdout.bytesTotal, 64000)
    assert.equal(value.stdout.truncated, false); assert.equal(value.stdout.spillPath, undefined)
    assert.equal(ledger.entries().length, 0)
  })
  await check('two sealed complete streams enter the shared ledger and recover through file authority', async () => {
    const stdout = 'HEADER_RECOVERY\n' + 'x'.repeat(150000) + '\nTAIL', stderr = 'ERROR_HEADER\n' + 'y'.repeat(90000)
    const execution = start("const fs=require('fs');fs.writeSync(1,'HEADER_RECOVERY\\n'+'x'.repeat(150000)+'\\nTAIL');fs.writeSync(2,'ERROR_HEADER\\n'+'y'.repeat(90000))")
    const value = await within(execution.result(), 'sealed output')
    assert.equal(value.error, undefined)
    for (const [stream, expected] of [['stdout', stdout], ['stderr', stderr]]) {
      const file = value[stream].spillPath; assert.ok(file); sealed.add(file)
      assert.equal(fs.readFileSync(file, 'utf8'), expected)
      assert.equal(value[stream].bytesTotal, Buffer.byteLength(expected)); assert.equal(value[stream].truncated, true)
      const entry = ledger.entries().find(entry => entry.path === file)
      assert.equal(entry.origin, 'ops-native-v1'); assert.equal(entry.pid, client.pid)
      assert.equal(entry.sessionId, agent.session.id); assert.equal(entry.bytes, Buffer.byteLength(expected))
    }
    const call = { agent, signal: AbortSignal.timeout(15000) }
    const read = await fileCall(ctx, worker, 'inspect_local_file', { path: value.stdout.spillPath }, call, call.signal)
    assert.equal(read.status, 'completed', JSON.stringify(read)); assert.ok(JSON.stringify(read).includes('HEADER_RECOVERY'))
    const write = await fileCall(ctx, worker, 'write_file', { path: value.stdout.spillPath, content: 'forbidden' }, call, call.signal)
    assert.equal(write.status, 'rejected'); assert.equal(fs.readFileSync(value.stdout.spillPath, 'utf8'), stdout)
    return { stdout: value.stdout.spillPath, stderr: value.stderr.spillPath }
  })
  await check('live Jobs output exposes a complete prefix but only terminal sealing records ownership', async () => {
    const gate = path.join(workspace, 'finish-live'), expected = 'LIVE_HEADER\n' + 'v'.repeat(70000)
    const { jobId, execution } = await background(`const fs=require('fs');fs.writeSync(1,'LIVE_HEADER\\n'+'v'.repeat(70000));const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(t);fs.writeSync(1,'END')}},5)`)
    const file = await until(() => execution.observed.stdout.spillPath, 'live spill')
    assert.equal(execution.observed.stdout.spillSealed, false); assert.equal(execution.observed.stdout.eof, false)
    assert.equal(fs.readFileSync(file, 'utf8'), expected); assert.equal(ledger.entries().some(entry => entry.path === file), false)
    await until(() => ctx.jobs.get(jobId, agent.id).output.spillPaths?.includes(file), 'public Jobs spill metadata')
    fs.writeFileSync(gate, '')
    const terminal = await within(ctx.jobs.wait(jobId, 15000, agent.id), 'live job completion')
    assert.equal(terminal.status, 'completed'); assert.equal(fs.readFileSync(file, 'utf8'), expected + 'END')
    assert.equal(ledger.entries().find(entry => entry.path === file)?.bytes, Buffer.byteLength(expected) + 3)
    sealed.add(file); return { jobId, file }
  })
  await check('overflow withdraws the complete file while the 64000-byte tail drains', async () => {
    const execution = start("const fs=require('fs'),b=Buffer.alloc(65536,120);for(let i=0;i<1024;i++)fs.writeSync(1,b);fs.writeSync(1,'!')")
    const value = await within(execution.result(), 'spill cap', 25000)
    assert.equal(value.error, undefined); assert.equal(value.stdout.bytesTotal, 64 * 1024 * 1024 + 1)
    assert.equal(value.stdout.spillPath, undefined); assert.equal(value.stdout.text, 'x'.repeat(63999) + '!')
    assert.match(execution.observed.stdout.spillError, /cap exceeded/)
  })
  await check('cancelled job seals its already complete stream and keeps exact native ledger origin', async () => {
    const { jobId, execution } = await background("const fs=require('fs');fs.writeSync(2,'CANCEL_HEADER'+'c'.repeat(70000));setInterval(()=>{},1000)")
    const file = await until(() => execution.observed.stderr.spillPath, 'cancel spill')
    ctx.jobs.kill(jobId, agent.id, 'fixture cancel'); const terminal = await within(ctx.jobs.wait(jobId, 15000, agent.id), 'cancelled job')
    assert.equal(terminal.status, 'killed'); assert.equal(execution.cleanupConfirmed, true)
    assert.equal(ledger.entries().find(entry => entry.path === file)?.origin, 'ops-native-v1'); sealed.add(file)
  })
  await check('shared retention removes only sealed recorded files', async () => {
    const swept = sweepSpills({ ledger, now: Date.now() + 40 * 86400000 })
    assert.deepEqual(new Set(swept.deleted), sealed)
    for (const file of sealed) assert.equal(fs.existsSync(file), false)
    return { deleted: swept.deleted.length }
  })
  await check('kernel crash removes live raw file and settles the public job without replay', async () => {
    const { jobId, execution } = await background("const fs=require('fs');fs.writeSync(1,'PID='+process.pid+'\\n'+'z'.repeat(70000));setInterval(()=>{},1000)")
    const file = await until(() => execution.observed.stdout.spillPath, 'crash spill')
    const match = /^PID=(\d+)/.exec(fs.readFileSync(file, 'utf8')); assert.ok(match); observed.add(Number(match[1]))
    process.kill(client.pid, 'SIGKILL')
    await within(execution.done, 'crashed task cleanup'); await within(ctx.jobs.wait(jobId, 15000, agent.id), 'crashed job')
    assert.equal(execution.effectState, 'unknown'); assert.equal(execution.cleanupConfirmed, true)
    assert.equal(fs.existsSync(file), false); assert.equal(client.available, false)
    assert.deepEqual([...observed].filter(alive), [])
  })
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.error = String(error.stack ?? error); process.exitCode = 1 }
finally {
  report.survivorsBeforeEmergencyCleanup = [...observed].filter(alive)
  try { await tasks?.dispose(); await host?.dispose(); report.cleanupConfirmed = true }
  catch (error) { report.cleanupConfirmed = false; report.cleanupError = String(error.stack ?? error); process.exitCode = 1 }
  report.survivorsAfterCleanup = [...observed].filter(alive)
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report))
}
