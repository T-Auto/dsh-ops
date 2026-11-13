import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { bashToolDefinition } from '../lib/shells.js'
import { hostBashDefinition } from '../lib/shells/host-tool.js'
import { startSessionBash } from '../lib/shells/session-execution.js'
import { startBashJob, waitOnBashJob } from '../lib/shells/jobs.js'
import { sessionWorkdir } from '../lib/session-shells.js'
import { hostForeground } from '../lib/shells/host-contract.js'
import { assert, report, test, TEST_HOME } from './lib/harness.mjs'
import { BASH_PARSE_CONTRACT } from '../lib/shells/prompt.js'

function fixture({ mode = 'danger-full-access', jobs, approval, settle = true, exitCode = 0, stderr = 'warning', file = process.execPath } = {}) {
  const calls = [], pending = Promise.withResolvers()
  const agent = { id: 'shell-host', session: { id: 'shell-host', header: { cwd: TEST_HOME } } }
  const services = { jobs, approval, sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: TEST_HOME }) },
    shellEnv: { collect: () => ({ DSH_TEST_FACT: 'current' }) },
    subprocess: { spawn(spec) {
      calls.push(spec)
      const stream = text => ({ readFrom: offset => ({ text: text.slice(offset), nextOffset: text.length, lossy: false }) })
      if (settle) pending.resolve({ exitCode, signal: null })
      else spec.signal.addEventListener('abort', () => pending.resolve({ exitCode: null, signal: 'SIGTERM' }))
      return { done: pending.promise, collected: { stdout: stream('ok'), stderr: stream(stderr) } }
    } },
  }
  // A tracked Cordis service hands out a fresh traceable proxy on every read, so the definition
  // must never consult `ctx.get('jobs')` again: jobs are bound explicitly, exactly as the component
  // binds them through `ctx.inject(['jobs'], …)`. Throwing here keeps a regression loud.
  const ctx = { get: name => {
    if (name === 'jobs') throw new Error('the bash definition must not re-read the jobs service')
    return services[name]
  }, logger: { warn() {} } }
  const bash = { file, source: 'config' }
  const base = bashToolDefinition({ ...bash, subprocess: services.subprocess })
  const definition = hostBashDefinition(ctx, base, (args, exec, standing, policy, env, options) =>
    startSessionBash({ ctx, bash, active: () => true }, args, exec, standing, policy, env, options), sessionWorkdir, jobs)
  const exec = { agent, callId: 'shell-call', signal: new AbortController().signal }
  return { definition, exec, services, calls, pending, setMode: next => { mode = next } }
}

function jobRegistry({ promote = false, refuse = false } = {}) {
  let hooks, declaration, state = 'running', outcome, removed = false
  const offsets = { stdout: 0, stderr: 0 }
  return {
    start(spec) {
      if (refuse) throw new Error('owner job limit')
      declaration = spec
      assert.equal(spec.owner, 'shell-host')
      assert.deepEqual(spec.output.map(source => source.channel), ['stdout', 'stderr'])
      hooks = spec.run({ id: 'bash-1' })
      hooks.done.then(value => { outcome = value; state = value.status })
      return 'bash-1'
    },
    async wait(id, _timeout, owner) {
      assert.equal(id, 'bash-1'); assert.equal(owner, 'shell-host')
      if (promote && state === 'running') { await new Promise(resolve => setImmediate(resolve)); return { status: state } }
      await hooks.done
      return { status: state, detail: outcome.detail }
    },
    read(id, owner) {
      assert.equal(id, 'bash-1'); assert.equal(owner, 'shell-host')
      return { chunks: declaration.output.map(source => {
        const read = source.read(offsets[source.channel]); offsets[source.channel] = read.nextOffset
        return { channel: source.channel, text: read.text }
      }), lossy: false, job: { output: { spillPaths: [] } } }
    },
    kill(_id, _owner, reason) { state = 'stopping'; hooks.cancel(reason) },
    remove() { removed = true },
    get declaration() { return declaration }, get hooks() { return hooks }, get removed() { return removed }, get outcome() { return outcome },
  }
}

await test('host foreground calls validate and render the host result contract', async () => {
  const f = fixture()
  assertSupportedJsonSchema(f.definition.output.schema)
  const value = await f.definition.execute({ command: 'echo ok', description: 'Print a short test result' }, f.exec)
  assert.equal(value.kind, 'foreground'); assert.equal(value.exitCode, 0); assert.equal(value.signal, null)
  assert.equal(value.aborted, false); assert.equal(value.status, 'completed'); assert.equal(value.timeoutMs, 120000)
  assert.deepEqual(validateJsonSchemaValue(f.definition.output.schema, value, 'value'), [])
  assert.match(f.definition.output.render({}, value)[0].text, /\[stderr\]\nwarning\n\[exit code: 0\]$/)
  assert.equal(f.calls[0].argv[0], process.execPath)
  assert.equal(f.calls[0].env.DSH_TEST_FACT, 'current')
})

await test('host descriptions are required and timeout overrides cap at ten minutes', async () => {
  const f = fixture()
  for (const args of [{ command: 'true' }, { command: 'true', description: '' },
    { command: 'true', description: '   ' }, { command: 'true', description: 'x', timeoutMs: NaN }]) {
    const invalid = await f.definition.execute(args, f.exec)
    assert.equal(invalid.status, 'failed'); assert.equal(invalid.failure.code, 'INVALID_BASH_ARGUMENT')
    assert.equal(invalid.failure.effectState, 'none'); assert.equal(invalid.failure.retry, 'after-input-change')
    assert.deepEqual(validateJsonSchemaValue(f.definition.output.schema, invalid, 'value'), [])
    assert.match(f.definition.output.render({}, invalid)[0].text, /invalid (description|timeoutMs)/)
  }
  assert.equal(f.calls.length, 0)
  const value = await f.definition.execute({ command: 'true', description: 'Cap the command timeout', timeoutMs: 900000 }, f.exec)
  assert.equal(value.timeoutMs, 600000)
})

await test('approval rejection and missing approval never execute or create jobs', async () => {
  for (const result of ['rejected', 'cancelled', 'unavailable', 'unexpected']) {
    const f = fixture({ mode: 'read-only', approval: { async request(req) {
      assert.equal(req.toolName, 'ops_bash'); assert.equal(req.callId, 'shell-call'); return result
    } } })
    const value = await f.definition.execute({ command: 'true', description: 'Check explicit wider access', sandbox_permissions: 'danger-full-access', justification: 'Need the requested command access.' }, f.exec)
    assert.match(value.error, /APPROVAL_/); assert.equal(f.calls.length, 0)
    assert.equal(value.failure.effectState, 'none'); assert.equal(value.failure.retry, 'never')
  }
  const f = fixture({ mode: 'read-only' })
  const value = await f.definition.execute({ command: 'true', description: 'Check missing approval service', sandbox_permissions: 'danger-full-access', justification: 'Need wider access.' }, f.exec)
  assert.match(value.error, /APPROVAL_UNAVAILABLE/); assert.equal(f.calls.length, 0)
})

await test('an allowed-once grant widens only one call and keeps the current environment', async () => {
  let asks = 0
  const f = fixture({ mode: 'read-only', approval: { async request() { asks++; return 'allowed-once' } } })
  const args = { command: 'true', description: 'Run one approved command', sandbox_permissions: 'danger-full-access', justification: 'This command needs wider access.' }
  const first = await f.definition.execute(args, f.exec)
  assert.equal(first.status, 'completed'); assert.equal(first.sandbox.mode, 'danger-full-access')
  const second = await f.definition.execute(args, f.exec)
  assert.equal(second.status, 'completed'); assert.equal(asks, 2)
  assert.equal(f.services.sandboxPolicy.resolve().mode, 'read-only')
})

await test('a session policy change during approval refuses the approved command', async () => {
  const f = fixture({ mode: 'read-only' })
  f.services.approval = { async request() { f.setMode('workspace-write'); return 'allowed-once' } }
  const value = await f.definition.execute({ command: 'true', description: 'Check a racing authority change', sandbox_permissions: 'danger-full-access', justification: 'Need wider access.' }, f.exec)
  assert.match(value.error, /AUTHORITY_CHANGED/); assert.equal(f.calls.length, 0)
})

await test('escalation argument failures precede approval and execution', async () => {
  let asks = 0
  const f = fixture({ approval: { async request() { asks++; return 'allowed-once' } } })
  for (const args of [{ justification: 'orphan' }, { sandbox_permissions: 'workspace-write', justification: 'narrow' }, { sandbox_permissions: 'unknown' }]) {
    const value = await f.definition.execute({ command: 'true', description: 'Validate escalation fields', ...args }, f.exec)
    assert.equal(value.failure.code, 'INVALID_BASH_ARGUMENT'); assert.match(value.error, /invalid/)
    assert.equal(value.failure.effectState, 'none')
  }
  assert.equal(asks, 0); assert.equal(f.calls.length, 0)
})

await test('completed foreground jobs leave the registry with their result', async () => {
  const jobs = jobRegistry(), f = fixture({ jobs })
  assert.match(f.definition.description, /long-running processes and daemons with run_in_background; job_kill terminates the job's entire process tree/)
  const value = await f.definition.execute({ command: 'true', description: 'Run a foreground host job' }, f.exec)
  assert.equal(value.kind, 'foreground'); assert.equal(jobs.removed, true)
  assert.equal(jobs.outcome.detail, 'exit code: 0')
})

await test('the host projection carries the shared Bash parse contract with and without jobs', () => {
  for (const options of [{}, { jobs: jobRegistry() }]) {
    const { definition } = fixture(options)
    assert.equal(definition.description.includes(BASH_PARSE_CONTRACT), true,
      options.jobs === undefined ? 'foreground-only' : 'with jobs')
  }
})

await test('timeout promotion returns the same job and consumes output exactly once', async () => {
  const jobs = jobRegistry({ promote: true }), f = fixture({ jobs, settle: false })
  const value = await f.definition.execute({ command: 'true', description: 'Promote a long running command', timeoutMs: 1 }, f.exec)
  assert.equal(value.kind, 'promoted'); assert.equal(value.jobId, 'bash-1')
  assert.equal(jobs.declaration.label, 'Promote a long running command')
  assert.equal(value.label, jobs.declaration.label)
  assert.deepEqual(validateJsonSchemaValue(f.definition.output.schema, value, 'value'), [])
  assert.ok(f.definition.output.render({}, value)[0].text.includes(JSON.stringify(value.label)))
  assert.equal(value.output, 'ok\n[stderr]\nwarning')
  assert.equal(jobs.read('bash-1', f.exec.agent.id).chunks.every(chunk => chunk.text === ''), true)
  jobs.kill('bash-1', f.exec.agent.id, 'stop test')
  await jobs.hooks.done
  assert.equal(jobs.outcome.status, 'killed')
})

await test('background returns a host job id and cancellation stops work', async () => {
  const jobs = jobRegistry(), f = fixture({ jobs, settle: false })
  const description = 'Run "quoted" tests\n验证后台任务'
  const value = await f.definition.execute({ command: 'true', description, run_in_background: true }, f.exec)
  assert.equal(value.kind, 'background')
  assert.equal(jobs.declaration.label, description)
  assert.equal(value.label, description)
  assert.deepEqual(validateJsonSchemaValue(f.definition.output.schema, value, 'value'), [])
  const rendered = f.definition.output.render({}, value)[0].text
  assert.ok(rendered.includes(JSON.stringify(description)))
  assert.equal(rendered.split('\n').length, 1, 'a multiline label stays quoted on one result line')
  jobs.kill(value.jobId, f.exec.agent.id, 'stop test')
  await jobs.hooks.done
  assert.equal(jobs.outcome.status, 'killed')
})

await test('the bound registry serves background work even when a re-read would not be identity-equal', async () => {
  // This is the regression that made `ops_bash` refuse background work in the real host: the
  // registry is a tracked service, so `ctx.get('jobs')` returns a new proxy each call. The fixture
  // throws on that read, so only a definition that uses the bound registry can pass.
  const jobs = jobRegistry(), f = fixture({ jobs, settle: false })
  const value = await f.definition.execute({ command: 'true', description: 'Use the bound job registry', run_in_background: true }, f.exec)
  assert.equal(value.kind, 'background'); assert.equal(value.jobId, 'bash-1')
  jobs.kill(value.jobId, f.exec.agent.id, 'stop test')
  await jobs.hooks.done
  assert.equal(jobs.outcome.status, 'killed')
})

await test('job admission refusal falls back only for foreground and no hidden work starts', async () => {
  const jobs = jobRegistry({ refuse: true }), f = fixture({ jobs })
  const foreground = await f.definition.execute({ command: 'true', description: 'Use foreground when admission refuses' }, f.exec)
  assert.equal(foreground.kind, 'foreground'); assert.equal(f.calls.length, 1)
  const background = await f.definition.execute({ command: 'true', description: 'Refuse unavailable background admission', run_in_background: true }, f.exec)
  assert.match(background.error, /owner job limit/); assert.equal(f.calls.length, 1)
})


await test('same-mode requests do not prompt and cancellation while approving prevents execution', async () => {
  const f = fixture({ approval: { request() { throw new Error('must not ask') } } })
  const same = await f.definition.execute({ command: 'true', description: 'Retain the current permission mode', sandbox_permissions: 'danger-full-access', justification: '' }, f.exec)
  assert.equal(same.status, 'completed')
  const controller = new AbortController(), approved = Promise.withResolvers()
  const pending = fixture({ mode: 'read-only', approval: { request: () => approved.promise } })
  const call = pending.definition.execute({ command: 'true', description: 'Cancel an approval pending command', sandbox_permissions: 'danger-full-access', justification: 'Request wider access.' }, { ...pending.exec, signal: controller.signal })
  controller.abort(new Error('approval was cancelled')); approved.resolve('allowed-once')
  const value = await call
  assert.equal(value.status, 'failed'); assert.equal(value.aborted, true); assert.match(value.error, /approval was cancelled/)
  assert.equal(pending.calls.length, 0)
  assert.equal(value.failure.code, 'CANCELLED'); assert.equal(value.failure.effectState, 'none')
})

await test('without jobs the foreground deadline stops execution and background arguments fail', async () => {
  const f = fixture({ settle: false })
  const invalid = await f.definition.execute({ command: 'true', description: 'Reject unavailable background work', run_in_background: true }, f.exec)
  assert.equal(invalid.failure.code, 'INVALID_BASH_ARGUMENT'); assert.match(invalid.error, /unknown key/)
  assert.equal(f.calls.length, 0)
  // Keep this test alive while the executor's deliberately unref'ed deadline runs.
  const hold = setTimeout(() => {}, 2000)
  try {
    const value = await f.definition.execute({ command: 'true', description: 'Stop the command at expiry', timeoutMs: 5 }, f.exec)
    assert.equal(value.kind, 'foreground'); assert.equal(value.timedOut, true)
    assert.equal(value.status, 'failed'); assert.equal(f.calls[0].signal.aborted, true)
    assert.equal(value.failure.effectState, 'unknown'); assert.equal(value.failure.retry, 'never')
    assert.match(f.definition.output.render({}, value)[0].text, /Inspect its effects with a read-only operation first/)
  } finally { clearTimeout(hold) }
})

await test('nonzero exit completes the host job but preserves the failed command status', async () => {
  const jobs = jobRegistry(), f = fixture({ jobs, exitCode: 7 })
  const value = await f.definition.execute({ command: 'exit 7', description: 'Report a nonzero command exit' }, f.exec)
  assert.equal(jobs.outcome.status, 'completed'); assert.equal(jobs.outcome.detail, 'exit code: 7')
  assert.equal(value.exitCode, 7); assert.equal(value.status, 'failed')
  assert.equal(value.failure.effectState, 'unknown'); assert.equal(value.failure.retry, 'after-input-change')
  assert.equal(value.failure.code, 'EXIT_CODE')
  const text = f.definition.output.render({}, value)[0].text
  assert.match(text, /correct the command or its inputs before retrying/)
  assert.match(text, /Prior side effects may remain/)
  assert.doesNotMatch(text, /Do not repeat the command/)
  assert.deepEqual(validateJsonSchemaValue(f.definition.output.schema, value, 'value'), [])
})

await test('only an ordinary nonzero exit permits a corrected command after input changes', () => {
  const base = { exitCode: 2, signal: null, timedOut: false, timeoutMs: 1000,
    stdout: { text: '', truncated: false }, stderr: { text: 'usage error', truncated: false } }
  for (const extra of [{ timedOut: true }, { cancelled: true }, { signal: 'SIGTERM' },
    { error: 'SPAWN_FAILED: unavailable' }, { restriction: { code: 'POLICY_DENIED', message: 'denied' } },
    { permission: { code: 'PERMISSION_DENIED', message: 'denied' } }, { exitCode: null }]) {
    const value = hostForeground({ ...base, ...extra })
    assert.notEqual(value.failure.code, 'EXIT_CODE', JSON.stringify(extra))
    assert.equal(value.failure.retry, 'never', JSON.stringify(extra))
    assert.equal(value.failure.effectState, 'unknown')
  }
  assert.equal(hostForeground({ ...base, exitCode: 0 }).failure, undefined)
  const normal = hostForeground(base)
  assert.equal(normal.failure.code, 'EXIT_CODE')
  assert.equal(normal.failure.retry, 'after-input-change')
  assert.equal(normal.failure.effectState, 'unknown')
})

await test('job cancellation before asynchronous preparation prevents the starter from running', async () => {
  const jobs = jobRegistry(), f = fixture()
  let starts = 0
  const attached = startBashJob(jobs, { command: 'true' }, f.exec, () => { starts++; throw new Error('must not start') })
  assert.deepEqual(jobs.declaration.output[0].read(19), { text: '', nextOffset: 19, lossy: false })
  jobs.kill(attached.id, f.exec.agent.id, 'cancel before preparation')
  await jobs.hooks.done
  assert.equal(starts, 0); assert.equal(jobs.outcome.status, 'killed')
})

await test('job labels retain command, script and generic fallbacks without a description', async () => {
  for (const [args, expected] of [[{ command: 'echo fallback' }, 'echo fallback'],
    [{ script_path: 'fallback.sh' }, 'fallback.sh'], [{}, 'Bash']]) {
    const jobs = jobRegistry(), f = fixture()
    const attached = startBashJob(jobs, args, f.exec, () => { throw new Error('must not start') })
    jobs.kill(attached.id, f.exec.agent.id, 'cancel before preparation')
    await jobs.hooks.done
    assert.equal(jobs.declaration.label, expected)
  }
})

await test('an expiring pending preparation is stopped and never promoted', async () => {
  const jobs = jobRegistry({ promote: true }), f = fixture()
  const pending = Promise.withResolvers(); let killed = false
  const attached = startBashJob(jobs, { command: 'true' }, f.exec, () => ({
    started: false, observed: { stdout: { readFrom() {} }, stderr: { readFrom() {} } },
    result: () => pending.promise, kill() { killed = true; pending.resolve({ cancelled: true }) },
  }))
  const value = await waitOnBashJob(jobs, attached, f.exec, 1)
  assert.equal(value.kind, 'foreground'); assert.equal(value.timedOut, true)
  assert.equal(killed, true); assert.equal(jobs.removed, true)
  assert.equal(value.failure.effectState, 'none'); assert.equal(value.failure.code, 'TIMEOUT')
})

await test('an unresolved executable is refused before the host can search PATH', async () => {
  const f = fixture({ file: 'bash' })
  const value = await f.definition.execute({ command: 'true', description: 'Reject an unresolved executable path' }, f.exec)
  assert.match(value.error, /resolved absolute executable path/); assert.equal(f.calls.length, 0)
})

await test('a session executor without an authoritative agent refuses before consulting services', () => {
  const ctx = { get() { throw new Error('unexpected service lookup') } }
  const policy = { mode: 'danger-full-access', workspaceRoot: TEST_HOME }
  assert.throws(() => startSessionBash({ ctx, bash: { file: process.execPath, source: 'config' }, active: () => true },
    { command: 'true' }, {}, policy, policy, {}, {}), /EXECUTOR_UNAVAILABLE: an authoritative session is required/)
})

await test('post-run admission failure cancels queued work and never retries foreground', async () => {
  let hooks
  const jobs = { start(spec) { hooks = spec.run(); throw new Error('admission failed after run hook') } }
  const f = fixture({ jobs })
  const value = await f.definition.execute({ command: 'true', description: 'Refuse partially accepted job admission' }, f.exec)
  await hooks.done
  assert.equal(value.status, 'failed'); assert.match(value.error, /admission failed after run hook/)
  assert.equal(value.failure.effectState, 'none'); assert.equal(value.failure.retry, 'never')
  assert.equal(f.calls.length, 0, 'neither queued job nor foreground retry can start')
})

await test('starter/result errors distinguish pre-execution evidence from uncertain command effects', async () => {
  const f = fixture(), base = bashToolDefinition({ file: process.execPath, source: 'config', subprocess: f.services.subprocess })
  const args = { command: 'true', description: 'Classify execution uncertainty without repeating' }
  for (const started of [false, true, undefined]) {
    let starts = 0
    const custom = hostBashDefinition({ get: name => f.services[name] }, base, () => {
      starts++
      if (started === undefined) throw new Error('starter failed without a handle')
      return { started, result() { throw new Error('result read failed') } }
    }, sessionWorkdir)
    const value = await custom.execute(args, f.exec)
    assert.equal(starts, 1); assert.equal(value.status, 'failed')
    assert.equal(value.failure.effectState, started === true ? 'unknown' : 'none')
    assert.equal(value.failure.retry, 'never')
    assert.deepEqual(validateJsonSchemaValue(custom.output.schema, value, 'value'), [])
  }
  const invalidStarter = hostBashDefinition({ get: name => f.services[name] }, base, () => {
    throw new Error('INVALID_BASH_ARGUMENT: invalid staging input')
  }, sessionWorkdir)
  const invalid = await invalidStarter.execute(args, f.exec)
  assert.equal(invalid.failure.code, 'INVALID_BASH_ARGUMENT')
  assert.equal(invalid.failure.effectState, 'none')
  assert.equal(invalid.failure.retry, 'after-input-change')
  f.services.shellEnv.collect = () => { throw new Error('environment collection failed') }
  const value = await f.definition.execute(args, f.exec)
  assert.equal(value.failure.effectState, 'none'); assert.equal(f.calls.length, 0)
})

await test('job preparation failure has no command effects and keeps its failure classification', async () => {
  const jobs = jobRegistry(), f = fixture({ jobs })
  const base = bashToolDefinition({ file: process.execPath, source: 'config', subprocess: f.services.subprocess })
  const custom = hostBashDefinition({ get: name => f.services[name] }, base, () => {
    throw new Error('STAGING_FAILED: preparation stopped before spawn')
  }, sessionWorkdir, jobs)
  const value = await custom.execute({ command: 'true', description: 'Fail before starting the process' }, f.exec)
  assert.equal(value.failure.code, 'STAGING_FAILED')
  assert.equal(value.failure.effectState, 'none')
  assert.equal(value.failure.retry, 'never')
  assert.equal(f.calls.length, 0)
  assert.equal(jobs.removed, true)
})

await test('timeout cannot claim no effects while an invoked asynchronous starter has no handle', async () => {
  const jobs = jobRegistry({ promote: true }), f = fixture()
  const pending = Promise.withResolvers(); let stopped = false
  const wait = jobs.wait.bind(jobs); let waits = 0
  // The real registry's second bounded wait may still report cancellation in progress.
  jobs.wait = (...args) => ++waits === 2 ? Promise.resolve({ status: 'stopping' }) : wait(...args)
  const attached = startBashJob(jobs, { command: 'true' }, f.exec, () => pending.promise)
  const value = await waitOnBashJob(jobs, attached, f.exec, 1)
  assert.equal(value.timedOut, true); assert.equal(value.failure.effectState, 'unknown')
  assert.equal(value.failure.retry, 'never'); assert.equal(jobs.removed, false)
  pending.resolve({ started: false, kill() { stopped = true },
    result: async () => ({ cancelled: true, timedOut: false, timeoutMs: 1,
      stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }) })
  await jobs.hooks.done
  assert.equal(stopped, true); assert.equal(jobs.outcome.status, 'killed')
})

await test('successful command diagnostics never impersonate a sandbox startup failure', async () => {
  for (const stderr of ['sandbox_unavailable', "couldn't create signal pipe", 'fatal error: win32 error 5']) {
    const f = fixture({ stderr })
    const value = await f.definition.execute({ command: 'echo diagnostic >&2', description: 'Preserve successful diagnostic command output' }, f.exec)
    assert.equal(value.exitCode, 0); assert.equal(value.status, 'completed')
    assert.equal(value.error, undefined); assert.equal(value.failure, undefined)
    assert.equal(value.stderr.text, stderr); assert.equal(value.sandbox.runnerFailed, undefined)
  }
})

await test('nonzero command diagnostics preserve command failure and uncertain effects', async () => {
  for (const stderr of ['sandbox_unavailable', "couldn't create signal pipe", 'fatal error: win32 error 5']) {
    const f = fixture({ exitCode: 7, stderr })
    const value = await f.definition.execute({ command: 'exit 7', description: 'Preserve ordinary diagnostic command failure' }, f.exec)
    assert.equal(value.exitCode, 7); assert.equal(value.status, 'failed')
    assert.equal(value.error, undefined); assert.equal(value.failure.code, 'EXIT_CODE')
    assert.equal(value.failure.effectState, 'unknown'); assert.equal(value.stderr.text, stderr)
    assert.equal(value.sandbox.runnerFailed, undefined)
  }
})

await test('background successful diagnostics retain the completed job outcome', async () => {
  const jobs = jobRegistry(), f = fixture({ jobs, stderr: 'sandbox_unavailable' })
  const value = await f.definition.execute({ command: 'echo diagnostic >&2', description: 'Preserve background diagnostic command output', run_in_background: true }, f.exec)
  assert.equal(value.kind, 'background')
  await jobs.hooks.done
  assert.equal(jobs.outcome.status, 'completed'); assert.equal(jobs.outcome.detail, 'exit code: 0')
})

await test('host confinement diagnostics still distinguish runner failure, denial and preparation refusal', async () => {
  // Exercise the borrowed host contract without staging a real Windows runtime or changing ACLs.
  // The suite runs serially; the platform descriptor is restored even when an assertion fails.
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  try {
    for (const sample of [
      { exitCode: 0, stderr: 'sandbox_unavailable', status: 'completed' },
      { exitCode: 7, stderr: 'sandbox_unavailable', code: 'EXIT_CODE' },
      { exitCode: 125, stderr: 'trusted runner fatal', code: 'EXECUTOR_UNAVAILABLE', runner: true },
      { exitCode: 7, stderr: 'trusted runner fatal', code: 'EXIT_CODE' },
      { exitCode: 125, stderr: 'runner information: trusted runner fatal', code: 'EXIT_CODE' },
      { exitCode: 1, stderr: 'host file access denied', denied: true },
    ]) {
      const f = fixture({ mode: 'read-only', exitCode: sample.exitCode, stderr: sample.stderr })
      f.services.sandbox = { async confine(argv) { return { argv, enforcement: 'full',
        runnerFailureRules: [{ allowedExitCodes: [125], fatalSignatures: ['trusted runner fatal'], informationalLines: ['runner information: trusted runner fatal'] }],
        denialSignatures: ['host file access denied'] } } }
      const value = await f.definition.execute({ command: 'true', description: 'Verify borrowed host diagnostic contracts' }, f.exec)
      assert.equal(f.calls.length, 1); assert.equal(value.exitCode, sample.exitCode)
      assert.equal(value.status, sample.status ?? 'failed')
      if (sample.code) assert.equal(value.failure.code, sample.code)
      assert.equal(value.sandbox.runnerFailed, sample.runner)
      assert.equal(value.sandbox.denied, sample.denied === true)
      if (sample.denied) assert.ok(value.restriction)
    }
    for (const sandbox of [undefined,
      { async confine() { throw new Error('SANDBOX_UNAVAILABLE: test provider failed') } },
      { async confine() { throw new Error('provider unavailable without a magic keyword') } },
      { async confine() { return { argv: [], enforcement: 'none' } } },
    ]) {
      const unavailable = fixture({ mode: 'read-only' })
      unavailable.services.sandbox = sandbox
      const value = await unavailable.definition.execute({ command: 'true', description: 'Refuse failed host confinement preparation' }, unavailable.exec)
      assert.equal(unavailable.calls.length, 0); assert.equal(value.status, 'failed')
      assert.match(value.error, /^EXECUTOR_UNAVAILABLE:/)
      assert.equal(value.failure.code, 'EXECUTOR_UNAVAILABLE')
      assert.equal(value.failure.effectState, 'none')
      assert.equal(value.sandbox.runnerFailed, true); assert.equal(value.sandbox.denied, false)
    }
    const changed = fixture({ mode: 'read-only' })
    changed.services.sandbox = { async confine(argv) { changed.setMode('workspace-write'); return { argv, enforcement: 'full' } } }
    const authority = await changed.definition.execute({ command: 'true', description: 'Preserve changed authority before command spawn' }, changed.exec)
    assert.match(authority.error, /AUTHORITY_CHANGED/); assert.equal(changed.calls.length, 0)
    assert.equal(authority.sandbox.runnerFailed, undefined)
    const cancelled = fixture({ mode: 'read-only' }), controller = new AbortController()
    cancelled.services.sandbox = { async confine() {
      controller.abort(new Error('cancel confinement preparation'))
      throw new Error('SANDBOX_UNAVAILABLE: interrupted provider')
    } }
    const aborted = await cancelled.definition.execute({ command: 'true', description: 'Preserve cancellation during confinement preparation' }, { ...cancelled.exec, signal: controller.signal })
    assert.equal(aborted.failure.code, 'CANCELLED'); assert.equal(aborted.failure.effectState, 'none')
    assert.equal(cancelled.calls.length, 0); assert.equal(aborted.sandbox.runnerFailed, undefined)
  } finally { Object.defineProperty(process, 'platform', platform) }
})

report('shells-host')
