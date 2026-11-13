/** Caller cancellation disclosure through a qualified production root; no injected admission seam. */
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
const report = { kind: 'qualified-runtime-root-public-reset-proof', started: new Date().toISOString(), home, workspace,
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

  for (const presentation of ['native', 'ptc']) await check(`${presentation} cancelled shell publishes one joined reset fact`, async () => {
    await first.ctx.plugin(inner => selectExecutor(inner, presentation))
    const initial = okay(await run(first, presentation, sessionArgs('export OPS_RESET_KEEP=remembered; printf "%s" "$$"')))
    const pid = Number(initial.stdout.text)
    assert.ok(Number.isSafeInteger(pid) && pid > 0)
    okay(await run(sibling, 'native', sessionArgs('export OPS_RESET_SIBLING=unchanged; printf sibling')))
    const marker = path.join(workspace, `${presentation}-entered`)
    const controller = new AbortController(), callId = `cancel-${presentation}`
    const input = sessionArgs(`printf entered > ${quote(marker.split(path.sep).join('/'))}; sleep 30`)
    let settled = false
    const work = executeCall(ctx, { agent: first, callId, signal: controller.signal,
      ...(presentation === 'native' ? { name: publicToolName('bash'), arguments: input }
        : { name: 'run_code', arguments: { description: 'Cancel a real persistent shell',
          code: `return await tools.${publicToolName('bash')}(${JSON.stringify(input)});` } }) })
      .finally(() => { settled = true })
    const watchdog = setTimeout(() => controller.abort(new Error('probe watchdog')), 20000)
    let result
    try {
      await until(() => fs.existsSync(marker), 'actual shell command start')
      assert.equal(settled, false)
      process.kill(pid, 0)
      controller.abort(new Error('probe caller cancelled'))
      result = await work
    } finally { clearTimeout(watchdog); controller.abort(); await work.catch(() => {}) }
    assert.equal(result.isError, true)
    assert.equal(result.error.info.code, 'ABORTED')
    assert.equal(result.value, undefined)
    const notices = (result.additionalContexts ?? []).filter(value => value.source.kind === 'dsh-ops:shell-reset')
    assert.equal(notices.length, 1, JSON.stringify(result))
    assert.equal(notices[0].source.shellState, 'reset')
    assert.equal(notices[0].source.cleanupConfirmed, true)
    assert.equal(notices[0].source.effectState, 'unknown')
    assert.equal(notices[0].source.callId, presentation === 'native' ? callId : `${callId}:ptc:1`)
    assert.match(JSON.stringify(notices[0].content), /cleanup confirmed/)
    assert.doesNotMatch(JSON.stringify(notices[0]), /sleep 30|entered >|OPS_RESET_KEEP/)
    let gone = false
    try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') gone = true; else throw error }
    assert.equal(gone, true, 'the actual shell must be gone before the returned notice')
    const preserved = okay(await run(sibling, 'native', sessionArgs('printf "%s" "$OPS_RESET_SIBLING"')))
    assert.equal(preserved.stdout.text, 'unchanged')
    const restarted = okay(await run(first, presentation, sessionArgs('printf "%s" "${OPS_RESET_KEEP-unset}"')))
    assert.equal(restarted.stdout.text, 'unset')
    assert.equal(restarted.stateLost, 'shell-reset')
    return { presentation, pid, shellGoneBeforeResult: gone, notice: notices[0], outerError: result.error,
      sibling: preserved.stdout.text, nextStateLost: restarted.stateLost }
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
