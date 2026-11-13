/** Local candidate proof only: real host authority and kernel scheduling, no model calls or shipped pin change. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const args = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [process.argv[2 + i * 2].replace(/^--/, ''), process.argv[3 + i * 2]]))
for (const key of ['worker', 'bash', 'payload', 'sha256', 'report']) assert.ok(args[key], `--${key} required`)
assert.equal(process.platform, 'win32', 'C2 process ownership is Windows-only')
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
assert.equal(hash(args.bash), args.sha256, 'candidate hash must match the explicit local proof input')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-c2-host-home-'))
process.env.DSH_HOME = home
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-c2-host-work-'))
const modules = await Promise.all(['@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-sandbox-policy',
  '@deepseek-ai/dsh-subprocess-local', '@deepseek-ai/dsh-sandbox-local', '@deepseek-ai/dsh-fs-local',
  '@deepseek-ai/dsh-working-directory'].map(name => import(name)))
const [{ Context }, Agents, Sessions, Projections, Prompt, Tools, Llm, Loop, Policy, Subprocess, Sandbox, FileSystem, Directory] = modules
const { startResident } = await import('../../lib/execution/resident/client.js')
const { workerEnvelope } = await import('../../lib/execution/protocol.js')
const { residentShellAdmission } = await import('../../lib/execution/resident/shell-owner.js')
const { prepareNiubash } = await import('../../lib/niubash/runtime.js')
const ctx = new Context(); ctx.logger.level = 0
const report = { kind: 'local-candidate-real-host-C2-proof', started: new Date().toISOString(),
  worker: args.worker, workerSha256: hash(args.worker), bash: args.bash, bashSha256: args.sha256,
  home, workspace, limitations: ['No model-facing publication, persistent Jobs, performance claim or shipped pin change.',
    'Actual Cordis/Agent/Session/policy/directory/subprocess/sandbox; approval and explicit shellEnv are instrumented public service shapes.'],
  checks: [], events: [] }
let client, host, ownerFiber, kernelFiber, next = 0
const handles = [], calls = new Map(), approvals = []
let approve = async () => 'allowed-once'
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
const node = quote(process.execPath.replaceAll('\\', '/'))
const sleep = ms => `${node} -e ${quote(`setTimeout(()=>{},${ms})`)}`
const event = (type, id) => report.events.find(value => value.type === type && value.requestId === id)
async function until(predicate, label, ms = 15_000) {
  const deadline = Date.now() + ms
  for (;;) { const value = predicate(); if (value) return value; if (Date.now() >= deadline) throw new Error(`${label} timed out`); await delay(10) }
}
async function within(work, label, ms = 15_000) {
  let timer
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms) })]) }
  finally { clearTimeout(timer) }
}
async function check(name, run) {
  const started = Date.now()
  try { const detail = await run(); report.checks.push({ name, status: 'passed', ms: Date.now() - started, detail }); console.log(`ok ${name}`) }
  catch (error) { report.checks.push({ name, status: 'failed', ms: Date.now() - started, error: String(error.stack ?? error) }); console.error(`FAIL ${name}: ${error.stack ?? error}`) }
}
async function agent(mode = 'danger-full-access') {
  const handle = await ctx.get('agents').create({ sessionId: `c2-host-${++next}`, meta: { cwd: workspace }, agentOptions: { provider: 'fixture', model: 'never-called' } })
  handles.push(handle); Policy.setSandboxMode(handle.agent.session, mode)
  return handle
}
function call(handle, command, args = {}, signal) {
  const callId = `c2-call-${++next}`, previous = report.events.length
  const result = host.execute({ command, timeoutMs: 10_000, ...args }, { agent: handle.agent, callId, signal })
  const queued = report.events.slice(previous).find(value => value.type === 'shell.execute')
  assert.ok(queued, 'valid call must enqueue in native')
  calls.set(queued.requestId, result)
  return { id: queued.requestId, result, callId }
}
function okay(value) { assert.equal(value.status, 'completed', JSON.stringify(value)); assert.equal(value.cleanupConfirmed, true); return value }
try {
  for (const plugin of [Agents, Sessions, Projections, Prompt, Tools, Llm]) await ctx.plugin(plugin.default, {})
  await ctx.plugin(Policy.default, { mode: 'danger-full-access', workspaceRoot: workspace })
  await ctx.plugin(Subprocess.default); await ctx.plugin(Sandbox.default); await ctx.plugin(FileSystem.default, { cwd: workspace })
  await ctx.plugin(Directory.default, { defaultDirectory: workspace })
  await ctx.plugin(inner => {
    inner.provide('shellEnv', { collect: () => ({}) })
    inner.provide('approval', { async request(input) { approvals.push(input); return approve(input) } })
    inner.on('llm/stream', () => { throw new Error('No model request is permitted in this proof') })
  })
  await ctx.plugin(Loop.default, { agents: [] })
  kernelFiber = await ctx.plugin({ name: 'proof-kernel', inject: ['subprocess'], async apply(inner) { client = await startResident(inner, args.worker, workspace) } })
  report.kernelPid = client.pid
  const transport = {
    get available() { return client.shell.available }, get capabilities() { return client.shell.capabilities },
    send(message) {
      report.events.push({ type: message.type, requestId: message.requestId, sessionKey: message.sessionKey, decision: message.decision,
        closeAfter: message.closeAfter, at: Date.now() })
      return client.shell.send(message)
    },
    subscribe(listener) { return client.shell.subscribe(message => {
      report.events.push({ type: message.type, requestId: message.requestId, status: message.status, shellState: message.shellState,
        cleanupConfirmed: message.cleanupConfirmed, hasShell: message.hasShell, at: Date.now(), error: message.error })
      listener(message)
    }) },
    read: (...values) => client.shell.read(...values), abort: error => client.shell.abort(error),
  }
  ownerFiber = await ctx.plugin(residentShellAdmission({ transport, bash: { file: args.bash, source: 'explicit-local-backport-candidate' },
    async runtime(_bash, env, policy, signal) {
      const runtime = await prepareNiubash(path.join(args.payload, 'niu.exe'), env.PATH ?? env.Path, signal, { workspaceRoot: policy.workspaceRoot })
      return { ...runtime, file: args.bash }
    } }))
  host = ctx.get('opsShellAdmission'); assert.ok(host, 'injected admission owner must be ready')

  await check('actual host preserves cwd/env/functions and explicit persistent workdir', async () => {
    const handle = await agent(), child = path.join(workspace, 'child'), explicit = path.join(workspace, 'explicit')
    fs.mkdirSync(child); fs.mkdirSync(explicit)
    okay(await call(handle, "cd child\nexport KEEP='中文 value'\nkept() { printf '%s' \"$KEEP\"; }\nset -f\nprintf first").result)
    const second = okay(await call(handle, "pwd; kept; printf '\\nflags:%s\\n' \"$-\"").result)
    assert.match(second.stdout.text, /\/child\r?\n中文 value\r?\nflags:.*f/)
    okay(await call(handle, 'printf changed', { workdir: explicit }).result)
    const third = okay(await call(handle, 'pwd; kept').result)
    assert.match(third.stdout.text, /\/explicit\r?\n中文 value/)
    return { session: handle.agent.id, tail: third.stdout.text }
  })
  await check('native FIFO serializes one session while a sibling overlaps', async () => {
    const first = await agent(), sibling = await agent()
    okay(await call(first, 'printf warm').result); okay(await call(sibling, 'printf warm').result)
    const slow = call(first, `${sleep(650)}; printf slow`)
    await until(() => event('shell.started', slow.id), 'slow start')
    const queued = call(first, 'printf queued'), other = call(sibling, 'printf sibling')
    const file = path.join(workspace, 'while-shell.txt'); fs.writeFileSync(file, 'same kernel file traffic')
    const exchange = await client.invoke(workerEnvelope('file', { root: workspace, scope: 'c2-file', tool: 'inspect_local_file', read_only: true,
      deny_roots: [], deny_credential_names: false, args: { path: file, view: 'text' } }))
    assert.equal(exchange.value?.status, 'completed', JSON.stringify(exchange))
    okay(await other.result)
    assert.equal(event('shell.started', queued.id), undefined)
    assert.equal(event('shell.completed', slow.id), undefined)
    okay(await slow.result); okay(await queued.result)
    assert.ok(event('shell.started', queued.id).at >= event('shell.completed', slow.id).at)
  })
  await check('queued native timeout and pending approval cancellation have no effects', async () => {
    const handle = await agent('read-only')
    okay(await call(handle, 'printf warm').result)
    const slow = call(handle, `${sleep(600)}; printf slow`)
    await until(() => event('shell.started', slow.id), 'blocking start')
    const queued = call(handle, 'printf MUST_NOT_RUN', { timeoutMs: 100 })
    const expired = await queued.result
    assert.equal(expired.effectState, 'none'); assert.notEqual(expired.status, 'completed')
    assert.equal(event('shell.started', queued.id), undefined); assert.equal(event('shell.completed', slow.id), undefined)
    okay(await slow.result)
    const granted = Promise.withResolvers(); approve = () => granted.promise
    const controller = new AbortController(), before = approvals.length
    const pending = call(handle, 'printf MUST_NOT_RUN', { sandbox_permissions: 'danger-full-access', justification: 'Fixture one-call proof.' }, controller.signal)
    await until(() => approvals.length > before, 'approval request')
    controller.abort(); const cancelled = await pending.result
    assert.equal(cancelled.effectState, 'none'); assert.equal(event('shell.started', pending.id), undefined)
    granted.resolve('allowed-once'); approve = async () => 'allowed-once'
    okay(await call(handle, 'printf after-cancel').result)
    const late = Promise.withResolvers(); approve = () => late.promise
    const approvalCount = approvals.length
    const expires = call(handle, 'printf MUST_NOT_RUN', { timeoutMs: 500, sandbox_permissions: 'danger-full-access', justification: 'Approval deadline fixture.' })
    await until(() => approvals.length > approvalCount, 'deadline approval request')
    const timedOut = await expires.result
    assert.equal(timedOut.effectState, 'none'); assert.notEqual(timedOut.status, 'completed')
    assert.equal(event('shell.started', expires.id), undefined)
    late.resolve('allowed-once'); approve = async () => 'allowed-once'
    okay(await call(handle, 'printf after-approval-timeout').result)
  })
  await check('admission retirement keeps the granted head and closeAfter prevents reuse', async () => {
    const handle = await agent('read-only')
    okay(await call(handle, 'export STANDING=old; printf warm').result)
    const before = approvals.length
    const widened = call(handle, 'export WIDE=one; printf widened', { sandbox_permissions: 'danger-full-access', justification: 'One exact fixture command.' })
    const value = okay(await widened.result)
    assert.equal(value.shellState, 'reset'); assert.equal(approvals.length, before + 1)
    const decisions = report.events.filter(value => value.requestId === widened.id && value.type === 'shell.admission')
    assert.deepEqual(decisions.map(value => value.decision), ['retire', 'launch'])
    assert.equal(decisions.at(-1).closeAfter, true)
    const next = okay(await call(handle, "printf '%s/%s' \"${STANDING-unset}\" \"${WIDE-unset}\"").result)
    assert.equal(next.stdout.text, 'unset/unset')
  })
  await check('policy control retirement cancels current head but re-admits queued follower', async () => {
    const handle = await agent('danger-full-access')
    okay(await call(handle, 'printf warm').result)
    const active = call(handle, `${sleep(2000)}; printf MUST_NOT_FINISH`)
    await until(() => event('shell.started', active.id), 'active head')
    const queued = call(handle, 'printf reread-policy')
    Policy.setSandboxMode(handle.agent.session, 'read-only')
    const stopped = await active.result; assert.notEqual(stopped.status, 'completed'); assert.equal(stopped.shellState, 'reset')
    assert.equal(okay(await queued.result).stdout.text, 'reread-policy')
    assert.ok(report.events.some(value => value.type === 'shell.retire'))
  })
  await check('bounded distinct output is copied through EOF then released', async () => {
    const handle = await agent()
    const source = "process.stdout.write('A'.repeat(200000)+'TAIL');process.stderr.write('ERR-END')"
    const request = call(handle, `${node} -e ${quote(source)}`)
    const value = okay(await request.result)
    assert.equal(value.stdout.bytesTotal, 200004); assert.equal(value.stdout.lossy, true)
    // C2's internal window explicitly retains a prefix, not the old tool's spill contract.
    assert.equal(value.stdout.text, 'A'.repeat(131072)); assert.equal(value.stdout.text.includes('TAIL'), false)
    assert.equal(value.stderr.text, 'ERR-END'); assert.equal(value.stderr.lossy, false)
    assert.ok(event('shell.release', request.id)); assert.equal(client.available, true)
    const tail = "process.stdout.write('NEXT-HEAD');setTimeout(()=>{process.stdout.write('-TAIL');process.stderr.write('ERR-TAIL')},100)"
    const next = okay(await call(handle, `${node} -e ${quote(tail)}`).result)
    assert.equal(next.stdout.text, 'NEXT-HEAD-TAIL'); assert.equal(next.stderr.text, 'ERR-TAIL')
    assert.equal(next.stdout.lossy, false); assert.equal(next.stderr.lossy, false)
  })
  await check('actual Agent disposal joins its active shell and leaves sibling usable', async () => {
    const handle = await agent(), sibling = await agent()
    okay(await call(sibling, 'printf warm').result)
    const active = call(handle, sleep(2000)); await until(() => event('shell.started', active.id), 'disposed active head')
    await handle.dispose()
    const value = await active.result
    assert.equal(value.cleanupConfirmed, true); assert.notEqual(value.status, 'completed')
    assert.equal(okay(await call(sibling, 'printf survives').result).stdout.text, 'survives')
  })
} catch (error) {
  report.fatal = String(error.stack ?? error)
  console.error(report.fatal)
} finally {
  try {
    await ownerFiber?.dispose()
    report.settledCalls = (await within(Promise.allSettled([...calls.values()]), 'all admitted calls settle')).length
    for (const handle of handles) await handle.dispose()
    await kernelFiber?.dispose()
    await ctx.fiber.dispose()
    if (client) assert.throws(() => process.kill(client.pid, 0), error => error?.code === 'ESRCH', 'kernel PID must be gone after owned teardown')
    report.kernelGone = true
    report.cleanupConfirmed = true
  } catch (error) { report.cleanupConfirmed = false; report.cleanupError = String(error.stack ?? error) }
  report.finished = new Date().toISOString()
  report.status = !report.fatal && report.cleanupConfirmed && report.checks.every(value => value.status === 'passed') ? 'passed' : 'failed'
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, passed: report.checks.filter(value => value.status === 'passed').length, report: args.report }))
  if (report.status !== 'passed') process.exitCode = 1
}
