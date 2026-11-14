/** Public execution selector over the existing Bash definition; no native queue is simulated here. */
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { isQualifiedSessionRuntime } from '../lib/niubash/session-runtime.js'
import { NIUBASH_MANIFEST_SHA256, NIUBASH_PIN } from '../lib/cli/niubash-payload.js'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { bashToolDefinition } from '../lib/shells/tool.js'
import { hostBashDefinition } from '../lib/shells/host-tool.js'
import { hostForeground } from '../lib/shells/host-contract.js'
import { withSessionExecution } from '../lib/shells/persistent-tool.js'
import { mountSessionBash } from '../lib/session-shells.js'
import { residentSessionShells } from '../lib/session-shell-provider.js'
import { resolveModeConfig } from '../lib/presets/config.js'
import { joinMode } from '../lib/presets/registry.js'
import { resolveShells } from '../lib/shells/resolve.js'
import { fixture as admissionFixture, turn } from './lib/resident-shell-admission.mjs'
import { executeCall } from './lib/executor.mjs'
import { assert, test, report, waitFor } from './lib/harness.mjs'

const description = 'Print a short persistent shell result'
const args = extra => ({ command: 'printf session-result', description, execution: 'session', ...extra })
async function bounded(promise, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle`)), 5000)
    })])
  } finally { clearTimeout(timer) }
}
function terminal(extra = {}) {
  return { type: 'shell.completed', requestId: 'fixture-request', status: 'completed', exitCode: 0,
    effectState: 'unknown', shellState: 'preserved', cleanupConfirmed: true, stdoutTotal: 14, stderrTotal: 0,
    stdout: { text: 'session-result', bytesTotal: 14, lossy: false },
    stderr: { text: '', bytesTotal: 0, lossy: false }, ...extra }
}
function fixture() {
  const freshCalls = [], sessionCalls = []
  const state = { active: true, result: terminal(), handler: undefined,
    freshResult: hostForeground({ exitCode: 0, timedOut: false, timeoutMs: 900000,
      stdout: { text: 'fresh-output', truncated: true, spillPath: 'C:/fixture/host-spill.txt' },
      stderr: { text: '', truncated: false } }) }
  const forbidden = label => () => { throw new Error(`Unexpected fresh ${label} during session dispatch`) }
  const base = bashToolDefinition({ file: process.execPath, source: 'fixture' })
  const host = hostBashDefinition({ get: forbidden('service lookup') }, base,
    forbidden('execution'), forbidden('cwd resolution'), { start: forbidden('job admission') })
  const fresh = { ...host, async execute(input, call) {
    freshCalls.push({ input, call })
    return state.freshResult
  } }
  const admission = { async execute(input, call, active) {
    sessionCalls.push({ input, call, active })
    return state.handler ? state.handler(input, call, active) : state.result
  } }
  const active = () => state.active
  const definition = withSessionExecution(fresh, admission, active)
  const call = { callId: 'public-shell-call', signal: new AbortController().signal }
  return { state, fresh, freshCalls, sessionCalls, active, definition, call }
}
function validOutput(definition, value) {
  assert.deepEqual(validateJsonSchemaValue(definition.output.schema, value, 'value'), [], JSON.stringify(value))
}
function rendered(definition, input, value) {
  return definition.output.render(input, value).filter(block => block.type === 'text').map(block => block.text).join('\n')
}
function refused(f, value) {
  assert.equal(value.kind, 'foreground')
  assert.equal(value.status, 'failed')
  assert.equal(value.failure.effectState, 'none')
  assert.equal(value.shellState, 'unchanged')
  assert.equal(value.cleanupConfirmed, true)
  assert.equal(f.freshCalls.length, 0)
  assert.equal(f.sessionCalls.length, 0)
  validOutput(f.definition, value)
}

await test('the shared public schema adds an optional execution selector without changing the fresh definition', () => {
  const f = fixture()
  assert.equal(f.definition.name, f.fresh.name)
  assert.equal(f.fresh.parameters.properties.execution, undefined)
  assert.deepEqual(f.definition.parameters.properties.execution.enum, ['fresh', 'session'])
  assert.equal(f.definition.parameters.required.includes('execution'), false)
  assertSupportedJsonSchema(f.definition.parameters)
  assertSupportedJsonSchema(f.definition.output.schema)
  assert.deepEqual(validateJsonSchemaValue(f.definition.parameters, args(), 'args'), [])
  assert.deepEqual(validateJsonSchemaValue(f.definition.parameters,
    { command: 'printf fresh', description, execution: 'fresh' }, 'args'), [])
})

await test('omitted or explicit fresh forwards the original options and result without session execution', async () => {
  for (const execution of [undefined, 'fresh']) {
    const f = fixture()
    const local = { script_path: 'script with spaces.sh', description, workdir: '../fresh-directory',
      timeoutMs: 900000, graceMs: 17, includeDiagnostics: true, run_in_background: true,
      sandbox_permissions: 'danger-full-access', justification: 'Run the existing fresh path.' }
    const input = Object.freeze({ ...local, ...(execution ? { execution } : {}) })
    const value = await f.definition.execute(input, f.call)
    assert.equal(value, f.state.freshResult)
    assert.deepEqual(f.freshCalls[0].input, local)
    assert.equal(f.freshCalls[0].call, f.call)
    assert.equal(f.sessionCalls.length, 0)
    assert.equal(value.execution, undefined)
    assert.equal(value.stdout.spillPath, 'C:/fixture/host-spill.txt')
    assert.equal(rendered(f.definition, input, value), rendered(f.fresh, local, value))
    validOutput(f.definition, value)
  }
  for (const freshResult of [
    { kind: 'background', jobId: 'original-background', label: 'Original background command' },
    { kind: 'promoted', jobId: 'original-promoted', label: 'Original promoted command', timeoutMs: 10, output: 'retained' },
  ]) {
    const f = fixture(); f.state.freshResult = freshResult
    assert.equal(await f.definition.execute({ command: 'fresh', description }, f.call), freshResult)
    validOutput(f.definition, freshResult)
  }
})

await test('session dispatch preserves omitted cwd and delegates authority with the original execution context', async () => {
  const f = fixture()
  const value = await f.definition.execute(args({ run_in_background: false, graceMs: 3000,
    sandbox_permissions: 'workspace-write', justification: 'Use this admitted workspace.' }), f.call)
  assert.equal(f.freshCalls.length, 0)
  assert.equal(f.sessionCalls.length, 1)
  const forwarded = f.sessionCalls[0]
  assert.equal(forwarded.call, f.call)
  assert.equal(typeof forwarded.active, 'function')
  assert.equal(forwarded.active(), true)
  assert.equal(forwarded.input.command, 'printf session-result')
  assert.equal(forwarded.input.workdir, undefined)
  assert.equal(forwarded.input.timeoutMs, 120000)
  assert.equal(forwarded.input.run_in_background, undefined)
  assert.equal(forwarded.input.execution, undefined)
  assert.equal(forwarded.input.graceMs, undefined)
  assert.equal(forwarded.input.sandbox_permissions, 'workspace-write')
  assert.equal(forwarded.input.justification, 'Use this admitted workspace.')
  assert.equal(value.execution, 'session')
  assert.equal(value.kind, 'foreground')
  assert.equal(value.status, 'completed')
  assert.equal(value.shellState, 'preserved')
  assert.equal(value.cleanupConfirmed, true)
  assert.equal(value.retention, 'prefix')
  assert.equal(value.resolvedFrom, undefined, 'An omitted persistent cwd has not been resolved by the fresh wrapper')
  assert.equal(value.type, undefined)
  assert.equal(value.requestId, undefined)
  assert.equal(value.jobId, undefined)
  validOutput(f.definition, value)
  await f.definition.execute(args({ workdir: '../explicit-session-directory', timeoutMs: 900000 }), f.call)
  assert.equal(f.sessionCalls[1].input.workdir, '../explicit-session-directory')
  assert.equal(f.sessionCalls[1].input.timeoutMs, 600000)
})

await test('unsupported session combinations reject before dispatch and direct the caller to fresh execution', async () => {
  for (const extra of [{ script_path: 'existing.sh' }, { script_path: '' },
    { run_in_background: true }, { graceMs: 1 }, { includeDiagnostics: true }]) {
    const f = fixture(), value = await f.definition.execute(args(extra), f.call)
    refused(f, value)
    assert.match(`${value.error}\n${value.failure.message}`, /fresh/i)
  }
  const f = fixture()
  const { run_in_background: _background, ...properties } = f.fresh.parameters.properties
  const noJobs = withSessionExecution({ ...f.fresh, parameters: { ...f.fresh.parameters, properties } },
    { execute() { throw Error('Must not dispatch session background') } }, f.active)
  const value = await noJobs.execute(args({ run_in_background: true }), f.call)
  assert.match(value.error, /fresh.*host job registry/)
  assert.equal(value.failure.effectState, 'none')
  validOutput(noJobs, value)
})

await test('invalid session arguments and selectors never reach either executor', async () => {
  const invalid = [
    { unexpected: true }, { description: undefined }, { description: '' }, { description: '   ' }, { description: 3 },
    { command: undefined }, { command: '' }, { command: '   ' }, { command: 3 },
    { workdir: 3 }, { workdir: null }, { workdir: 'bad\0directory' },
    { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: 0.5 }, { timeoutMs: NaN }, { timeoutMs: Infinity },
    { run_in_background: 'false' }, { execution: '' }, { execution: 'persistent' }, { execution: null }, { execution: 1 },
  ]
  for (const extra of invalid) {
    const f = fixture(), value = await f.definition.execute(args(extra), f.call)
    refused(f, value)
  }
})

await test('session output preserves the admitted full spill path without exposing native retention metadata', async () => {
  const f = fixture(), spillPath = 'C:/fixture/native-output.log'
  f.state.result = terminal({ stdout: { text: 'retained prefix', bytesTotal: 90000, lossy: true,
    spillPath, spillOrigin: 'ops-native-v1', spillPid: 4321, spillSealed: true } })
  const value = await f.definition.execute(args(), f.call)
  assert.deepEqual(value.stdout, { text: 'retained prefix', bytesTotal: 90000, truncated: true, spillPath })
  assert.equal(value.stderr.spillPath, undefined)
  validOutput(f.definition, value)
  const output = rendered(f.definition, args(), value)
  assert.ok(output.includes(spillPath), output)
  assert.doesNotMatch(output, /ops-native-v1|spillPid|spillSealed|no spill recovery/)
})

await test('session output copies distinct bounded streams and reports reset without fabricating a spill or digest', async () => {
  const f = fixture(), text = '{"state":"保持"}\n'
  f.state.result = terminal({ shellState: 'reset', stdoutTotal: 200000, stderrTotal: 4,
    stdout: { text, bytesTotal: 200000, lossy: true }, stderr: { text: 'warn', bytesTotal: 4, lossy: false } })
  const input = args(), value = await f.definition.execute(input, f.call)
  assert.equal(value.status, 'completed')
  assert.equal(value.shellState, 'reset')
  assert.deepEqual(value.stdout, { text, truncated: true, bytesTotal: 200000 })
  assert.deepEqual(value.stderr, { text: 'warn', truncated: false, bytesTotal: 4 })
  assert.equal(value.stdout.bytes, undefined, 'Decoded UTF-8 length is not an exact retained raw-byte count')
  assert.equal(value.stdout.spillPath, undefined)
  assert.equal(value.stderr.spillPath, undefined)
  const output = rendered(f.definition, input, value)
  assert.match(output, /reset/i)
  assert.match(output, /prefix/i)
  assert.match(output, /truncat|loss/i)
  assert.ok(output.includes(text))
  assert.doesNotMatch(output, /JSON summary|host-spill\.txt/)
  assert.equal(f.freshCalls.length, 0)
  validOutput(f.definition, value)
})

await test('a successful preserved shell still reports state lost before its latest command', async () => {
  const f = fixture(), input = args()
  f.state.result = terminal({ shellState: 'preserved', stateLost: 'environment-changed' })
  const value = await f.definition.execute(input, f.call)
  assert.equal(value.status, 'completed')
  assert.equal(value.shellState, 'preserved')
  assert.equal(value.stateLost, 'environment-changed')
  assert.equal(value.cleanupConfirmed, true)
  assert.match(rendered(f.definition, input, value), /environment-changed/)
  validOutput(f.definition, value)
})

await test('native terminal failures preserve their exact code and effect facts without fresh fallback', async () => {
  for (const item of [
    { status: 'rejected', code: 'POLICY_DENIED', effectState: 'none', cleanupConfirmed: true },
    { status: 'cancelled', code: 'CANCELLED', effectState: 'none', cleanupConfirmed: true },
    { status: 'cancelled', code: 'TIMEOUT', effectState: 'unknown', cleanupConfirmed: true },
    { status: 'failed', code: 'EXECUTOR_UNAVAILABLE', effectState: 'unknown', cleanupConfirmed: false },
  ]) {
    const f = fixture(), message = `Exact native ${item.code} message`
    f.state.result = terminal({ status: item.status, effectState: item.effectState, cleanupConfirmed: item.cleanupConfirmed,
      exitCode: null, shellState: 'reset', error: { code: item.code, message } })
    const value = await f.definition.execute(args(), f.call)
    assert.equal(value.kind, 'foreground')
    assert.equal(value.status, 'failed')
    assert.equal(value.failure.code, item.code)
    assert.equal(value.failure.effectState, item.effectState)
    assert.ok(value.failure.message.includes(message))
    assert.equal(value.cleanupConfirmed, item.cleanupConfirmed)
    assert.equal(value.shellState, 'reset')
    assert.equal(f.freshCalls.length, 0)
    assert.equal(f.sessionCalls.length, 1)
    validOutput(f.definition, value)
  }
})

await test('capture failure and nonzero exit remain failures even when other terminal facts look successful', async () => {
  const f = fixture()
  f.state.result = terminal({ status: 'failed', error: { code: 'OUTPUT_INCOMPLETE', message: 'stdout capture failed' },
    stdout: { text: 'partial', bytesTotal: 14, lossy: true, error: { code: 'OUTPUT_INCOMPLETE', message: 'stdout capture failed' } } })
  const capture = await f.definition.execute(args(), f.call)
  assert.equal(capture.exitCode, 0)
  assert.equal(capture.status, 'failed')
  assert.equal(capture.failure.code, 'OUTPUT_INCOMPLETE')
  assert.equal(capture.failure.effectState, 'unknown')
  assert.equal(capture.stdout.text, 'partial')
  assert.equal(capture.stdout.truncated, true)
  validOutput(f.definition, capture)
  f.state.result = terminal({ exitCode: 7 })
  const nonzero = await f.definition.execute(args(), f.call)
  assert.equal(nonzero.status, 'failed')
  assert.equal(nonzero.exitCode, 7)
  assert.equal(nonzero.failure.effectState, 'unknown')
  validOutput(f.definition, nonzero)
})

await test('retained callbacks reject a withdrawn publication and pass a live guard into queued admission', async () => {
  const f = fixture()
  f.state.active = false
  refused(f, await f.definition.execute(args(), f.call))
  f.state.active = true
  const waiting = Promise.withResolvers(), arrived = Promise.withResolvers()
  f.state.handler = async (_input, _call, active) => {
    arrived.resolve(active)
    await waiting.promise
    assert.equal(active(), false)
    return terminal({ status: 'rejected', exitCode: null, effectState: 'none', shellState: 'reset',
      error: { code: 'OWNER_DISPOSED', message: 'Publication was withdrawn before admission.' } })
  }
  const pending = f.definition.execute(args(), f.call)
  try {
    const guard = await bounded(arrived.promise, 'queued admission callback')
    assert.equal(guard(), true)
    f.state.active = false
  } finally { waiting.resolve() }
  const value = await bounded(pending, 'withdrawn publication result')
  assert.equal(value.status, 'failed')
  assert.equal(value.failure.code, 'OWNER_DISPOSED')
  assert.equal(value.failure.effectState, 'none')
  assert.equal(f.freshCalls.length, 0)
  validOutput(f.definition, value)
})

await test('an admission rejection is returned as a failure and never retried through the fresh executor', async () => {
  const f = fixture()
  f.state.handler = async () => { throw new Error('EXECUTOR_UNAVAILABLE: fixture resident transport was withdrawn') }
  const value = await f.definition.execute(args(), f.call)
  assert.equal(value.status, 'failed')
  assert.equal(value.failure.code, 'EXECUTOR_UNAVAILABLE')
  assert.equal(value.failure.effectState, 'unknown')
  assert.equal(value.shellState, 'unknown')
  assert.equal(value.cleanupConfirmed, false)
  assert.equal(f.freshCalls.length, 0)
  assert.equal(f.sessionCalls.length, 1)
  validOutput(f.definition, value)
})

async function publicSessionCall(f, handle, label) {
  const start = f.frames.length
  const result = executeCall(f.ctx, { agent: handle.agent, name: 'ops_bash', callId: label, arguments: args() })
  void result.catch(() => {})
  const request = await bounded(f.message('shell.execute', start), 'public session dispatch')
  return { request, result }
}
async function mountPublication(f, shells, config = { publishBashTool: true }) {
  const calls = []
  await f.ctx.plugin(inner => inner.provide('subprocess', { spawn(spec) {
    calls.push(spec)
    throw new Error('This scripted admission fixture must not run the fresh executor')
  } }))
  const row = await f.ctx.plugin(inner => mountSessionBash(inner, config, shells))
  return { row, calls }
}
async function published(f, handle, session = true) {
  await waitFor(() => {
    const tool = f.ctx.get('tools').get('ops_bash', handle.agent)
    return tool && Boolean(tool.parameters.properties.execution) === session
  }, { what: session ? 'session Bash publication' : 'fresh-only Bash publication' })
  return f.ctx.get('tools').get('ops_bash', handle.agent)
}

await test('actual Agent publication shares the admission owner and awaits targeted Agent and provider cleanup', async () => {
  await admissionFixture(async f => {
    const publication = await mountPublication(f, { bash: { available: true, file: process.execPath, source: 'fixture' } })
    const first = await f.agent(), sibling = await f.agent()
    const retainedFirst = await published(f, first), retainedSibling = await published(f, sibling)
    assert.ok(f.ctx.get('opsShellAdmission'))
    const beforeWrongOwner = f.frames.length
    const wrongOwner = await bounded(retainedFirst.execute(args(), { agent: sibling.agent, callId: 'retained-wrong-agent' }), 'wrong Agent refusal')
    assert.equal(wrongOwner.failure.effectState, 'none')
    assert.equal(wrongOwner.shellState, 'unchanged')
    assert.equal(f.frames.length, beforeWrongOwner, 'a retained publication cannot enqueue for a sibling Agent')
    const one = await publicSessionCall(f, first, 'published-first')
    assert.equal((await f.admit(one)).decision, 'launch')
    const result = await f.finish(one)
    assert.notEqual(result.isError, true, JSON.stringify(result))
    assert.equal(result.value.execution, 'session')
    assert.equal(result.value.status, 'completed')
    const two = await publicSessionCall(f, sibling, 'published-sibling')
    assert.notEqual(one.request.sessionKey, two.request.sessionKey)
    assert.equal((await f.admit(two)).decision, 'launch')
    assert.equal((await f.finish(two)).value.status, 'completed')
    let agentDisposed = false
    const beforeAgent = f.frames.length
    const agentDisposal = first.dispose().then(() => { agentDisposed = true })
    const firstClose = await f.message('shell.close', beforeAgent, frame => frame.sessionKey === one.request.sessionKey)
    await turn()
    assert.equal(agentDisposed, false)
    assert.equal(f.frames.slice(beforeAgent).some(frame => frame.type === 'shell.close' && frame.sessionKey === two.request.sessionKey), false)
    f.acknowledge(firstClose)
    await bounded(agentDisposal, 'published Agent disposal')
    const rejectedFirst = await retainedFirst.execute(args(), { agent: first.agent, callId: 'retained-disposed-agent' })
    assert.equal(rejectedFirst.failure.effectState, 'none')
    const next = await publicSessionCall(f, sibling, 'published-sibling-reuse')
    assert.equal(next.request.sessionKey, two.request.sessionKey)
    assert.equal((await f.admit(next, true)).decision, 'reuse')
    assert.equal((await f.finish(next)).value.status, 'completed')
    let providerDisposed = false
    const beforeProvider = f.frames.length
    const providerDisposal = f.owner.dispose().then(() => { providerDisposed = true })
    const siblingClose = await f.message('shell.close', beforeProvider, frame => frame.sessionKey === two.request.sessionKey)
    await turn()
    assert.equal(providerDisposed, false)
    f.acknowledge(siblingClose)
    await bounded(providerDisposal, 'published admission provider disposal')
    const fresh = await published(f, sibling, false)
    assert.equal(fresh.parameters.properties.execution, undefined)
    const beforeStale = f.frames.length
    const stale = await retainedSibling.execute(args(), { agent: sibling.agent, callId: 'retained-provider-loss' })
    assert.equal(stale.status, 'failed')
    assert.equal(stale.failure.effectState, 'none')
    assert.equal(stale.shellState, 'unchanged')
    assert.equal(f.frames.length, beforeStale)
    assert.equal(publication.calls.length, 0)
  }, { providerOwned: true })
})

await test('the qualified candidate inventory does not activate or replace the published stock runtime', () => {
  const candidate = JSON.parse(fs.readFileSync(new URL('./fixtures/niubash-session-candidate-manifest.json', import.meta.url), 'utf8'))
  const inventoryDigest = manifest => createHash('sha256').update(JSON.stringify({
    directories: manifest.directories, files: manifest.files, sizes: manifest.sizes,
  })).digest('hex')
  assert.equal(isQualifiedSessionRuntime(inventoryDigest(candidate)), true)
  assert.equal(isQualifiedSessionRuntime(NIUBASH_MANIFEST_SHA256), false)
  assert.equal(NIUBASH_PIN.archiveSha256, 'da28cdc4e2e87f777ee0eae71386276f9c6a0ed135c1e2baad943acd8d349b87')
  assert.equal(NIUBASH_PIN.url, 'https://github.com/unixwin/niubash/releases/download/v1.5.0/niubash-v1.5.0-win-x64.tar.gz')
  assert.equal(Object.hasOwn(candidate, 'url'), false, 'unpublished inventory does not provide an active download URL')
  candidate.files['niu.exe'] = '0'.repeat(64)
  assert.equal(isQualifiedSessionRuntime(inventoryDigest(candidate)), false)
})

await test('the production runtime package gate keeps session publication disabled without a user bypass', async () => {
  await admissionFixture(async f => {
    await f.owner.dispose()
    const kernel = await f.ctx.plugin(inner => inner.provide('opsKernel', {
      file: process.execPath, pid: process.pid, available: true, shell: f.transport, task: { capabilities: [] },
      invoke() { throw new Error('No file request belongs to this fixture') },
    }))
    await f.ctx.plugin(residentSessionShells())
    assert.equal(f.ctx.get('opsShellAdmission', false), undefined)
    const config = resolveModeConfig({ bashPath: process.execPath, bash: true, publishBashTool: true }, 'standard')
    f.ctx.effect(() => joinMode(f.ctx, 'standard', config))
    const publication = await mountPublication(f, resolveShells(config), config)
    const handle = await f.agent(), definition = await published(f, handle, false)
    const before = f.frames.length
    const refused = await definition.execute(args(), { agent: handle.agent, callId: 'unaccepted-runtime' })
    assert.equal(refused.status, 'failed')
    assert.equal(refused.failure.code, 'INVALID_BASH_ARGUMENT')
    assert.equal(f.frames.length, before)
    assert.equal(publication.calls.length, 0)
    await kernel.dispose()
    assert.equal(f.ctx.get('opsShellAdmission', false), undefined)
  }, { providerOwned: true })
})

await test('caller cancellation defers one reset fact only after the joined receipt', async () => {
  const f = fixture(), controller = new AbortController(), entered = Promise.withResolvers(), joined = Promise.withResolvers()
  const contexts = [], call = { ...f.call, signal: controller.signal, deferContext: value => contexts.push(value) }
  f.state.handler = async () => { entered.resolve(); return joined.promise }
  const work = f.definition.execute(args({ command: 'sensitive-command-not-in-notice' }), call)
  await entered.promise
  controller.abort()
  await turn()
  assert.deepEqual(contexts, [], 'pending cancellation is not a confirmed reset')
  joined.resolve(terminal({ status: 'cancelled', shellState: 'reset', cleanupConfirmed: true, exitCode: null,
    error: { code: 'CANCELLED', message: 'joined' } }))
  const result = await work
  assert.equal(result.status, 'failed')
  assert.equal(result.shellState, 'reset')
  assert.equal(contexts.length, 1)
  assert.equal(contexts[0].source.kind, 'dsh-ops:shell-reset')
  assert.equal(contexts[0].source.callId, call.callId)
  assert.match(JSON.stringify(contexts[0].content), /reset.*cleanup confirmed/i)
  assert.match(JSON.stringify(contexts[0].content), /effect state: unknown/i)
  assert.doesNotMatch(JSON.stringify(contexts[0]), /sensitive-command|session-result/)
  validOutput(f.definition, result)
})

await test('unchanged, unknown, unconfirmed and fresh outcomes never claim a confirmed cancelled reset', async () => {
  for (const extra of [{ shellState: 'preserved' }, { shellState: 'unchanged' }, { shellState: 'unknown' },
    { cleanupConfirmed: false }]) {
    const f = fixture(), contexts = [], controller = new AbortController()
    f.state.handler = async () => { controller.abort(); return terminal({ status: 'cancelled', shellState: 'reset', ...extra }) }
    await f.definition.execute(args(), { ...f.call, signal: controller.signal, deferContext: value => contexts.push(value) })
    assert.deepEqual(contexts, [], JSON.stringify(extra))
  }
  const f = fixture(), contexts = [], call = { ...f.call, deferContext: value => contexts.push(value) }
  f.state.result = terminal({ shellState: 'reset' })
  await f.definition.execute(args(), call)
  await f.definition.execute(args({ execution: 'fresh' }), { ...call, signal: AbortSignal.abort() })
  assert.deepEqual(contexts, [], 'visible typed resets and fresh calls keep existing behavior')
})

report('persistent-mode')
