/** Actual internal task/session kernel, public confinement, and the existing recovery ledger. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Policy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import { residentKernel } from '../../lib/execution/resident/provider.js'
import { residentShellAdmission } from '../../lib/execution/resident/shell-owner.js'
import { createTaskExecutionHost } from '../../lib/execution/resident/task-owner.js'
import { prepareNiubash } from '../../lib/niubash/runtime.js'
import { loadScrubbedParentEnv } from '../../lib/adapter/dsh/host.js'
import { mergeShellEnvironment } from '../../lib/execution/resident/shell-launch.js'
import { getSpillLedger, SpillLedger } from '../../lib/shells/spill-ledger.js'
import { sweepSpills } from '../../lib/shells/spill-retention.js'
import { invoke as fileCall } from '../../lib/execution/files.js'

assert.equal(process.platform, 'win32', 'session process ownership is Windows-only')
const [worker, shell, support, output] = process.argv.slice(2, 6).map(value => path.resolve(value))
const stock = process.argv.includes('--stock-foreground')
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
if (stock) assert.equal(hash(shell), hash(support))
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-session-spill-')))
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-session-spill-home-'))
fs.mkdirSync(path.join(workspace, 'child'))
const { createResidentTaskJobs } = await import('../../test/lib/resident-task-jobs.mjs')
const report = { kind: stock ? 'stock-foreground-session-spill-only' : 'candidate-session-spill',
  worker, workerSha256: hash(worker), shell, shellSha256: hash(shell), workspace, checks: [],
  limitations: ['Internal adapters; no model publication or shipped runtime change.',
    stock ? 'Stock foreground proof does not qualify stock asynchronous IO for persistent sessions.' : 'Explicit local backport candidate, not a published runtime.'] }
let host, tasks, admission, client, lastRequest
const sealed = new Set(), observed = new Set(), calls = []
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
const node = quote(process.execPath.replaceAll('\\', '/'))
const external = code => `${node} -e ${quote(code)}`
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
async function until(predicate, label, ms = 15000) {
  const deadline = Date.now() + ms
  for (;;) { const value = await predicate(); if (value) return value; if (Date.now() > deadline) throw Error(`${label} timed out`); await delay(10) }
}
async function within(promise, label, ms = 25000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} timed out`)), ms) })]) }
  finally { clearTimeout(timer) }
}
async function check(name, run) {
  const detail = await run(); report.checks.push({ name, status: 'passed', detail }); console.log(`ok ${name}`)
}
function okay(value) { assert.equal(value.status, 'completed', JSON.stringify(value)); assert.equal(value.cleanupConfirmed, true); return value }
try {
  host = await createResidentTaskJobs({ cwd: workspace, initialAgents: 3 })
  const { ctx, agents } = host
  await ctx.plugin(Policy, { mode: 'danger-full-access', workspaceRoot: workspace })
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox, {}); await ctx.plugin(FileSystem, { cwd: workspace })
  await ctx.plugin(inner => inner.provide('shellEnv', { collect: () => ({}) }))
  await ctx.plugin(residentKernel({ binaryPath: worker }))
  client = ctx.get('opsKernel'); observed.add(client.pid); report.kernelPid = client.pid
  assert.ok(client.shell.capabilities.includes('shell-spill-v1'))
  assert.ok(client.task.capabilities.includes('task-spill-v1'))
  const transport = {
    get available() { return client.shell.available }, get capabilities() { return client.shell.capabilities },
    send(message) { if (message.type === 'shell.execute') lastRequest = message.requestId; return client.shell.send(message) },
    read: (...args) => client.shell.read(...args), subscribe: listener => client.shell.subscribe(listener), abort: error => client.shell.abort(error),
  }
  await ctx.plugin(residentShellAdmission({ transport, bash: { file: shell, source: report.kind },
    async runtime(_bash, env, policy, signal) {
      const prepared = await prepareNiubash(support, env.PATH ?? env.Path, signal, { workspaceRoot: policy.workspaceRoot })
      return { ...prepared, file: shell }
    } }))
  admission = ctx.get('opsShellAdmission')
  await ctx.plugin({ inject: ['agents'], apply(inner) { tasks = createTaskExecutionHost(inner, client.task) } })
  const ledger = getSpillLedger(), env = mergeShellEnvironment(await loadScrubbedParentEnv())
  function call(agent, command, signal) {
    const result = admission.execute({ command, timeoutMs: 20000 }, { agent, signal })
    calls.push(result); return within(result, 'session call')
  }
  function recover(stream, expected, agent) {
    assert.equal(stream.bytesTotal, expected.length); assert.equal(stream.lossy, true)
    assert.equal(stream.spillOrigin, 'ops-native-v1'); assert.equal(stream.spillPid, client.pid); assert.equal(stream.spillSealed, true)
    assert.deepEqual(fs.readFileSync(stream.spillPath), expected)
    const entry = ledger.entries().find(entry => entry.path === stream.spillPath)
    assert.ok(entry); assert.equal(entry.sessionId, agent.session.id); assert.equal(entry.bytes, expected.length)
    assert.equal(entry.pid, client.pid); assert.equal(entry.origin, 'ops-native-v1'); sealed.add(stream.spillPath)
  }
  await check('exact memory boundary remains memory only', async () => {
    const value = okay(await call(agents[0], external("require('fs').writeSync(1,Buffer.alloc(131072,120))")))
    assert.equal(value.stdout.bytesTotal, 131072); assert.equal(value.stdout.spillPath, undefined)
    assert.equal(value.stdout.lossy, false); assert.equal(ledger.entries().length, 0)
  })
  const modes = ['danger-full-access', 'read-only', 'workspace-write']
  for (const [index, mode] of modes.entries()) await check(`${mode}: retained state and exact binary recovery after release`, async () => {
    const agent = agents[index]; setSandboxMode(agent.session, mode)
    const state = okay(await call(agent, "cd child; export KEEP_SESSION=state; kept_fn(){ printf function; }; set -f; printf '%s' \"$$\""))
    observed.add(Number(state.stdout.text))
    const length = 1024 * 1024, expected = Buffer.alloc(length)
    for (let i = 0; i < length; i++) expected[i] = i % 251
    const code = `const fs=require('fs'),b=Buffer.alloc(${length});for(let i=0;i<b.length;i++)b[i]=i%251;fs.writeSync(1,b);fs.writeSync(2,b)`
    const result = okay(await call(agent, external(code) + (stock ? '' : ' & wait')))
    recover(result.stdout, expected, agent); recover(result.stderr, expected, agent)
    assert.equal(result.stdout.text, expected.subarray(0, 131072).toString('utf8'))
    const preserved = okay(await call(agent, 'printf "%s:%s:" "${PWD##*/}" "$KEEP_SESSION"; kept_fn; printf ":%s" "$-"'))
    assert.match(preserved.stdout.text, /^child:state:function:.*f/)
    return { stdout: result.stdout.spillPath, stderr: result.stderr.spillPath, sessionId: agent.session.id }
  })
  await check('fresh task and all session channels use one kernel store and ledger', async () => {
    const execution = tasks.start({ agent: agents[0] }, { lifetime: 'foreground', source: 'shared-store-fixture',
      spec: { command: 'fixed fixture', workdir: workspace, timeoutMs: 20000, graceMs: 1, includeDiagnostics: true },
      async admit() { return { argv: [process.execPath, '-e', "require('fs').writeSync(1,'TASK_HEADER'+'t'.repeat(70000))"], cwd: workspace, env } } })
    const value = await within(execution.result(), 'shared task')
    assert.equal(value.error, undefined); sealed.add(value.stdout.spillPath)
    assert.equal(fs.readFileSync(value.stdout.spillPath, 'utf8'), 'TASK_HEADER' + 't'.repeat(70000))
    assert.equal(new Set([...sealed].map(file => path.dirname(file))).size, 1)
    const reloaded = new SpillLedger(ledger.file)
    assert.equal(reloaded.entries().filter(entry => sealed.has(entry.path)).length, sealed.size)
    return { directory: path.dirname(value.stdout.spillPath), files: sealed.size }
  })
  await check('existing file authority recovers a session spill and rejects writes outside the workspace', async () => {
    const agent = agents[1], result = okay(await call(agent, external("require('fs').writeSync(1,'SESSION_RECOVERY_HEADER\\n'+'r'.repeat(150000))")))
    const file = result.stdout.spillPath; sealed.add(file)
    const fileContext = { agent, signal: AbortSignal.timeout(15000) }
    const read = await fileCall(ctx, worker, 'inspect_local_file', { path: file }, fileContext, fileContext.signal)
    assert.equal(read.status, 'completed', JSON.stringify(read)); assert.ok(JSON.stringify(read).includes('SESSION_RECOVERY_HEADER'))
    const write = await fileCall(ctx, worker, 'write_file', { path: file, content: 'forbidden' }, fileContext, fileContext.signal)
    assert.equal(write.status, 'rejected'); assert.ok(fs.readFileSync(file, 'utf8').startsWith('SESSION_RECOVERY_HEADER'))
  })
  await check('complete-file cap withdraws recovery while bounded memory still drains', async () => {
    const value = okay(await call(agents[0], external("const fs=require('fs'),b=Buffer.alloc(65536,120);for(let i=0;i<1024;i++)fs.writeSync(1,b);fs.writeSync(1,'!')")))
    assert.equal(value.stdout.bytesTotal, 64 * 1024 * 1024 + 1); assert.equal(value.stdout.text, 'x'.repeat(131072))
    assert.equal(value.stdout.spillPath, undefined); assert.match(value.stdout.spillError, /cap exceeded/)
  })
  await check('retention removes only sealed files recorded by both adapters', async () => {
    const swept = sweepSpills({ ledger, now: Date.now() + 40 * 86400000 })
    assert.deepEqual(new Set(swept.deleted), sealed)
    for (const file of sealed) assert.equal(fs.existsSync(file), false)
    assert.equal(okay(await call(agents[2], 'printf sibling')).stdout.text, 'sibling')
    return { deleted: swept.deleted.length }
  })
  await check('kernel loss withdraws unsealed live output and never records a recovery claim', async () => {
    const result = call(agents[0], external("const fs=require('fs');fs.writeSync(1,'LIVE_PID='+process.pid+'\\n'+'z'.repeat(150000));setInterval(()=>{},1000)"))
    const id = lastRequest
    const live = await until(async () => {
      const value = await client.shell.read(id, 'stdout', 0, 65536)
      return value.spillPath ? value : undefined
    }, 'live session spill')
    assert.equal(live.spillSealed, false); assert.equal(live.eof, false)
    assert.equal(ledger.entries().some(entry => entry.path === live.spillPath), false)
    const pid = /^LIVE_PID=(\d+)/.exec(fs.readFileSync(live.spillPath, 'utf8')); assert.ok(pid); observed.add(Number(pid[1]))
    process.kill(client.pid, 'SIGKILL')
    const lost = await result
    assert.equal(lost.effectState, 'unknown'); assert.equal(lost.cleanupConfirmed, true)
    assert.equal(lost.stdout.spillPath, undefined); assert.equal(fs.existsSync(live.spillPath), false)
    assert.equal(ledger.entries().some(entry => entry.path === live.spillPath), false)
    assert.deepEqual([...observed].filter(alive), [])
  })
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.error = String(error.stack ?? error); process.exitCode = 1 }
finally {
  try { await tasks?.dispose(); await admission?.dispose(); await host?.dispose(); await Promise.allSettled(calls); report.cleanupConfirmed = true }
  catch (error) { report.cleanupConfirmed = false; report.cleanupError = String(error.stack ?? error); process.exitCode = 1 }
  report.survivorsAfterCleanup = [...observed].filter(alive)
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report))
}
