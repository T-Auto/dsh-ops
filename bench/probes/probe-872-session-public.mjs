/** Qualified runtime through normal root/public Native/PTC publication; no injected admission seam. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const args = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [process.argv[2 + i * 2].replace(/^--/, ''), process.argv[3 + i * 2]]))
for (const key of ['worker', 'bash', 'shell-env', 'controller', 'report']) assert.ok(args[key], `--${key} required`)
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
assert.equal(process.platform, 'win32')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-public-home-'))
process.env.DSH_HOME = home
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-public-work-'))
fs.mkdirSync(path.join(workspace, 'child'))
const names = ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-sandbox-policy', '@deepseek-ai/dsh-subprocess-local', '@deepseek-ai/dsh-sandbox-local',
  '@deepseek-ai/dsh-fs-local', '@deepseek-ai/dsh-working-directory', '@deepseek-ai/dsh-ptc-runtime-node']
const [Agents, Sessions, Projections, Llm, Loop, Policy, Subprocess, Sandbox, FileSystem, Directory, NodePtc] = await Promise.all(names.map(name => import(name)))
const [Jobs, ToolJobs, ShellEnv] = await Promise.all([import('@deepseek-ai/dsh-jobs-local'),
  import(pathToFileURL(path.resolve(args.controller)).href), import(pathToFileURL(path.resolve(args['shell-env'])).href)])
const { bootHost } = await import('../../test/lib/host.mjs')
const { executeCall, selectExecutor } = await import('../../test/lib/executor.mjs')
const rootModule = await import('../../lib/index.js')
const { NIUBASH_PIN, NIUBASH_MANIFEST_SHA256, verifyNiubashTree } = await import('../../lib/cli/niubash-payload.js')
verifyNiubashTree(path.dirname(args.bash))
const { publicToolName } = await import('../../lib/policy.js')
const { ctx } = await bootHost({ withWorkingDirectory: false })
const report = { kind: 'qualified-runtime-root-public-session-proof', started: new Date().toISOString(), home, workspace,
  worker: args.worker, workerSha256: hash(args.worker), bash: args.bash, bashSha256: hash(args.bash),
  manifestSha256: NIUBASH_MANIFEST_SHA256, archiveSha256: NIUBASH_PIN.archiveSha256,
  limitations: ['Normal compiled runtime eligibility and complete payload verification are required; no admission factory or runtime override is injected.',
    'Functional qualification only, not archive publication, performance or full feature acceptance.'], checks: [], calls: [] }
let rootFiber, kernel, sequence = 0
const owners = []
const quote = text => `'${text.replaceAll("'", "'\\''")}'`
async function until(predicate, label) {
  const end = Date.now() + 20000
  for (;;) { if (predicate()) return; if (Date.now() > end) throw Error(`${label} timed out`); await delay(10) }
}
async function check(name, fn) {
  const started = Date.now()
  try { const detail = await fn(); report.checks.push({ name, passed: true, elapsedMs: Date.now() - started, detail }); console.log(`ok ${name}`) }
  catch (error) { report.checks.push({ name, passed: false, elapsedMs: Date.now() - started, error: String(error.stack ?? error) }); console.error(`FAIL ${name}: ${error.stack ?? error}`) }
}
async function run(agent, presentation, input) {
  const result = await executeCall(ctx, { agent, callId: `public-${++sequence}`, signal: AbortSignal.timeout(20000),
    ...(presentation === 'native' ? { name: publicToolName('bash'), arguments: input }
      : { name: 'run_code', arguments: { description: 'Exercise the shared persistent shell gateway', code: `return await tools.${publicToolName('bash')}(${JSON.stringify(input)});` } }) })
  assert.notEqual(result.isError, true, JSON.stringify(result))
  const value = presentation === 'native' ? result.value : result.value.result
  report.calls.push({ presentation, execution: input.execution ?? 'fresh', status: value.status, shellState: value.shellState,
    stateLost: value.stateLost, failure: value.failure, stdout: value.stdout?.text, stderr: value.stderr?.text, cleanupConfirmed: value.cleanupConfirmed })
  return value
}
const sessionArgs = command => ({ execution: 'session', command, description: 'Exercise this persistent shell command', timeoutMs: 10000 })
const okay = value => { assert.equal(value.status, 'completed', JSON.stringify(value)); assert.equal(value.exitCode, 0); return value }
try {
  for (const plugin of [Agents, Sessions, Projections, Llm, Subprocess, Sandbox, FileSystem, NodePtc]) await ctx.plugin(plugin.default, {})
  await ctx.plugin(Policy.default, { mode: 'workspace-write', workspaceRoot: workspace })
  await ctx.plugin(Directory.default, { defaultDirectory: workspace })
  await ctx.plugin(ShellEnv, { dshHome: home })
  await ctx.plugin(Jobs.default, { pumpPollMs: 10 })
  await ctx.plugin(ToolJobs.default ?? ToolJobs, { completionDelivery: 'quiet', inlineOutputBytes: 0 })
  await ctx.plugin(inner => {
    inner.on('llm/stream', () => { throw Error('No model requests are permitted') })
  })
  await ctx.plugin(Loop.default, { agents: [] })
  const config = {
    global: { bash: true, hidePwsh: false, hideOfficialTools: false, dynamicTools: false, forceDefaultOpsPtc: false },
    minimal: { enabled: false }, ptc: { enabled: false }, 'ops-ptc': { enabled: false }, cordis: { enabled: false },
    discovery: { enabled: false }, resultCache: { enabled: false }, panel: { enabled: false }, tui: { enabled: false }, disk: { enabled: false },
    standard: { binaryPath: args.worker, bashPath: args.bash, bash: true,
      residentTools: false, dynamicTools: false, hideOfficialTools: false, hidePwsh: false },
  }
  rootFiber = await ctx.plugin({ name: 'public-candidate-root', async apply(inner) {
    await rootModule.apply(inner, config)
    kernel = inner.get('opsKernel')
    assert.ok(kernel?.available)
    assert.ok(kernel.shell.capabilities.includes('shell-spill-v1'))
    assert.ok(inner.get('opsShellAdmission', false), 'Qualified package root must own session admission')
    assert.ok(inner.get('opsFreshTasks', false)?.available, 'Fresh calls must use the same kernel')
  } })
  report.kernelPid = kernel.pid
  for (let index = 0; index < 2; index++) owners.push(await ctx.agents.create({ sessionId: `public-session-${index}`,
    meta: { cwd: workspace }, agentOptions: { provider: 'fixture', model: 'unused' } }))
  const first = owners[0].agent, sibling = owners[1].agent
  await until(() => owners.every(({ agent }) => ctx.tools.get(publicToolName('bash'), agent)?.parameters.properties.execution), 'session tool publication')
  await check('actual root publishes one shared session definition for Native and PTC', async () => {
    const initial = okay(await run(first, 'native', sessionArgs("export OPS_SESSION_PROBE=remembered; probe_label() { printf '%s' \"$OPS_SESSION_PROBE\"; }; set -f; printf native")))
    assert.equal(initial.stdout.text, 'native')
    await first.ctx.plugin(inner => selectExecutor(inner, 'ptc'))
    const retained = okay(await run(first, 'ptc', sessionArgs('probe_label; printf ":%s" "$-"')))
    assert.match(retained.stdout.text, /^remembered:.*f/)
    assert.equal(retained.shellState, 'preserved')
    return { kernelPid: kernel.pid, retained: retained.stdout.text }
  })
  await check('actual sibling Agent does not inherit persistent shell state', async () => {
    const value = okay(await run(sibling, 'native', sessionArgs('printf "%s" "${OPS_SESSION_PROBE-unset}"; type probe_label >/dev/null 2>&1 || printf :no-function')))
    assert.equal(value.stdout.text, 'unset:no-function')
  })
  await check('explicit workdir changes persistent cwd and omission preserves it through PTC', async () => {
    okay(await run(first, 'ptc', { ...sessionArgs('pwd'), workdir: 'child' }))
    const value = okay(await run(first, 'ptc', sessionArgs('printf "%s" "${PWD##*/}"')))
    assert.equal(value.stdout.text, 'child')
  })
  await check('explicit fresh retains independent execution and leaves persistent state intact', async () => {
    const value = okay(await run(first, 'ptc', { ...sessionArgs('printf "%s" "${OPS_SESSION_PROBE-unset}"'), execution: 'fresh' }))
    assert.equal(value.stdout.text, 'unset')
    assert.equal(value.execution, undefined)
    assert.equal(okay(await run(first, 'ptc', sessionArgs('probe_label'))).stdout.text, 'remembered')
  })
  await check('session argument refusal is explicit and keeps existing state unchanged', async () => {
    const value = await run(first, 'ptc', { ...sessionArgs('printf forbidden'), run_in_background: true })
    assert.equal(value.status, 'failed'); assert.equal(value.failure.effectState, 'none')
    assert.equal(value.shellState, 'unchanged'); assert.match(value.error, /fresh/)
    assert.equal(okay(await run(first, 'ptc', sessionArgs('probe_label'))).stdout.text, 'remembered')
  })
  await check('shell exit reports reset without fallback or silent state recovery', async () => {
    const value = await run(first, 'ptc', sessionArgs('exit 23'))
    assert.equal(value.status, 'failed'); assert.equal(value.shellState, 'reset'); assert.equal(value.cleanupConfirmed, true)
    const next = okay(await run(first, 'ptc', sessionArgs('printf "%s" "${OPS_SESSION_PROBE-unset}"')))
    assert.equal(next.stdout.text, 'unset')
    assert.equal(okay(await run(sibling, 'native', sessionArgs('printf sibling-alive'))).stdout.text, 'sibling-alive')
  })
  for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) await check(`${mode} public session captures waited background output with complete recovery`, async () => {
    const owner = await ctx.agents.create({ sessionId: `public-spill-${mode}`, meta: { cwd: workspace }, agentOptions: { provider: 'fixture', model: 'unused' } })
    owners.push(owner); Policy.setSandboxMode(owner.agent.session, mode)
    await until(() => ctx.tools.get(publicToolName('bash'), owner.agent)?.parameters.properties.execution, 'qualified mode publication')
    const code = "const fs=require('fs');fs.writeSync(1,'PUBLIC_STDOUT\\n'+'x'.repeat(160000));fs.writeSync(2,'PUBLIC_STDERR\\n'+'y'.repeat(170000))"
    const command = `${quote(process.execPath)} -e ${quote(code)} & wait`
    const value = okay(await run(owner.agent, 'native', sessionArgs(command)))
    assert.equal(value.sandbox.mode, mode)
    for (const [stream, prefix, letter, count] of [['stdout','PUBLIC_STDOUT\n','x',160000], ['stderr','PUBLIC_STDERR\n','y',170000]]) {
      assert.equal(value[stream].truncated, true); assert.ok(value[stream].spillPath)
      assert.equal(fs.readFileSync(value[stream].spillPath, 'utf8'), prefix + letter.repeat(count))
      assert.equal(value[stream].bytesTotal, Buffer.byteLength(prefix) + count)
    }
    await owner.agent.ctx.plugin(inner => selectExecutor(inner, 'ptc'))
    const typed = okay(await run(owner.agent, 'ptc', sessionArgs('export PUBLIC_KEEP=kept; printf "%s" "$PUBLIC_KEEP"')))
    assert.equal(typed.stdout.text, 'kept'); assert.equal(typed.shellState, 'preserved')
    return { mode, enforcement: value.sandbox.enforcement, stdout: value.stdout.spillPath, stderr: value.stderr.spillPath }
  })
} catch (error) {
  report.fatal = String(error.stack ?? error); process.exitCode = 1
} finally {
  const errors = []
  for (const owner of owners) try { await owner.dispose() } catch (error) { errors.push(String(error)) }
  try { await rootFiber?.dispose() } catch (error) { errors.push(String(error)) }
  try { await ctx.fiber.dispose() } catch (error) { errors.push(String(error)) }
  if (kernel?.pid) {
    try { process.kill(kernel.pid, 0); errors.push(`Kernel PID ${kernel.pid} remains observable after teardown`) }
    catch (error) { if (error.code !== 'ESRCH') errors.push(String(error)) }
  }
  report.cleanup = { confirmed: errors.length === 0, errors }
  report.status = !report.fatal && !errors.length && report.checks.every(check => check.passed) ? 'passed' : 'failed'
  report.finished = new Date().toISOString()
  fs.writeFileSync(args.report, JSON.stringify(report, null, 2))
  console.log(`report ${args.report}`)
  if (errors.length || report.checks.some(check => !check.passed)) process.exitCode = 1
}
