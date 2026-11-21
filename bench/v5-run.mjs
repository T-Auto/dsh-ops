/**
 * The V5 (#994) Flash measurement driver: real OPS-PTC sessions on the real
 * opencode-go/deepseek-v4.1-flash route, one fresh composed group per session.
 *
 * Why this driver exists instead of `bench ab`: the host's one-shot headless
 * runner composes the host realm only — it refuses preset sessions by design
 * ("runs under agent preset … which the one-shot runner does not compose"), and
 * the dsh-ops plugin treats a registry-less host realm as Standard, so an
 * `ab` sweep would measure Standard and be invalid per #980. This driver reuses
 * the V1 isolated-entry composition (real AgentLoop + real PTC executor + real
 * staged worker + the shipped dsh-ops row) and replaces the scripted provider
 * with the real llm-pi-ai adapter, which the smoke probe proved end to end:
 * run_code-only surface, nested ops_* envelopes, per-step usage with cache
 * buckets.
 *
 * One session = one throwaway workspace + one fresh Context (nothing leaks
 * across sessions). The sweep interleaves arms per (task, repeat) AB/BA, so
 * machine drift cannot masquerade as an arm effect. Every session archives its
 * raw events, its trajectory (root programs + nested calls + envelopes), its
 * folded metrics, its verified answer and its workspace outcome; nothing is
 * averaged away before it is written down.
 *
 * Prerequisites (all fail loud, never silently):
 * - a built `lib/` and staged `runtime/<platform>-<arch>/dsh-ops-worker`
 *   (`npm run build` + `npm run build:ptc`);
 * - the vendored `@deepseek-ai/dsh-llm-pi-ai` tree under node_modules (see
 *   ensureVendoredLlm below — copies the pi-ai adapter and its credential
 *   helper from the installed dsh host so every import resolves through this
 *   checkout's tree and one cordis instance serves the whole composition);
 * - the route credential: OPENCODE_GO_API_KEY resolved from the credentials
 *   file of --dsh-home (or already exported in the environment).
 *
 * @module dsh-ops/bench/v5-run
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import Agents from '@deepseek-ai/dsh-agent'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as PtcExecutor from '@deepseek-ai/dsh-tool-executor-ptc'
import Llm from '@deepseek-ai/dsh-llm'
import * as LlmPiAiModule from '@deepseek-ai/dsh-llm-pi-ai'
import Loop from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import Policy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'

import { generate } from './lib/fixtures/index.mjs'
import { verifyWorkspace } from './lib/verify.mjs'
import { resolveDshEntry } from './lib/env.mjs'
import { loadTrackTasks, TRACK_TASK_IDS } from './lib/track-corpus.mjs'

const BENCH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)))
const REPO_ROOT = path.dirname(BENCH_DIR)
const LlmPiAi = LlmPiAiModule.default ?? LlmPiAiModule

/** The frozen route every session of one sweep shares (#994 step 1). */
const CONDITION = Object.freeze({ provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' })
/** The agentPreset every session carries; the plugin's mode detection keys on it. */
const PRESET = 'ops-ptc'
/** The sandbox mode pinned for every session, matching the operator's real profiles. */
const SANDBOX_MODE = 'danger-full-access'
/** The two arms of the comparison sweep: the preregistered factor is the row's disclosurePolicy. */
const ARMS = Object.freeze([
  { label: 'ondemand', disclosurePolicy: 'on-demand' },
  { label: 'full', disclosurePolicy: 'full' },
])
/** A/A arms: the same config twice, so the sweep measures the noise floor. */
const AA_ARMS = Object.freeze([
  { label: 'aa-one', disclosurePolicy: 'on-demand' },
  { label: 'aa-two', disclosurePolicy: 'on-demand' },
])

/** The CLI text. */
const USAGE = [
  'usage: node bench/v5-run.mjs [--task <id>]... [--repeat N] [--aa] [--out <dir>]',
  '           [--dsh-home <dir>] [--timeout-ms N] [--keep-workspaces]',
  '',
  'Runs real OPS-PTC sessions on the frozen opencode-go/deepseek-v4.1-flash route.',
  'One fresh workspace and one fresh composed group per session; arms interleave',
  'AB/BA per (task, repeat).',
  '',
  '  --task <id>         a V4 track task (' + TRACK_TASK_IDS.join(', ') + ');',
  '                     default: ptc-catalog-recover ptc-wait-dispatch',
  '  --repeat N          repeats per task per arm (default 3)',
  '  --aa                A/A mode: both arms run the on-demand config (default:',
  '                     the on-demand vs full comparison)',
  '  --out <dir>         the sweep directory (default bench/runs/v5-<UTC stamp>)',
  '  --dsh-home <dir>    where the credentials file lives (default ~/.dsh)',
  '  --timeout-ms N      per-session cap (default: the task file\'s own timeoutMs)',
  '  --keep-workspaces   keep the seeded workspaces under <out>/workspaces',
  '',
  'Exit codes: 0 the sweep ran to its plan · 1 a setup or session failure',
].join('\n')

/** Parse the command line; anything unknown is a usage error. */
function parseArgs(argv) {
  const options = { tasks: [], repeat: 3, aa: false, out: null, dshHome: null, timeoutMs: null, keepWorkspaces: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '-h' || flag === '--help') { console.log(USAGE); process.exit(0) }
    if (flag === '--task') {
      if (value === undefined || !TRACK_TASK_IDS.includes(value)) {
        console.error('--task needs one of: ' + TRACK_TASK_IDS.join(', ')); process.exit(2)
      }
      options.tasks.push(value); index += 1; continue
    }
    if (flag === '--repeat') { options.repeat = Number(value); index += 1; continue }
    if (flag === '--aa') { options.aa = true; continue }
    if (flag === '--out') { options.out = value; index += 1; continue }
    if (flag === '--dsh-home') { options.dshHome = value; index += 1; continue }
    if (flag === '--timeout-ms') { options.timeoutMs = Number(value); index += 1; continue }
    if (flag === '--keep-workspaces') { options.keepWorkspaces = true; continue }
    console.error('unknown option ' + JSON.stringify(flag) + '\n'); console.error(USAGE); process.exit(2)
  }
  if (options.tasks.length === 0) options.tasks = ['ptc-catalog-recover', 'ptc-wait-dispatch']
  if (!Number.isInteger(options.repeat) || options.repeat < 1 || options.repeat > 20) {
    console.error('--repeat needs an integer in [1, 20]'); process.exit(2)
  }
  return options
}

/**
 * Vendor the real pi-ai adapter into this checkout's node_modules so the whole
 * composition shares one dsh-llm and one cordis instance. node_modules is
 * gitignored and no package.json is touched: this is a runtime resolution
 * detail of the measurement driver, not a dependency change.
 * @param {string} installed - the installed dsh host's node_modules/@deepseek-ai directory.
 */
function ensureVendoredLlm(installed) {
  const root = path.join(REPO_ROOT, 'node_modules')
  const targets = [
    { from: path.join(installed, 'dsh-llm-pi-ai'), to: path.join(root, '@deepseek-ai', 'dsh-llm-pi-ai') },
    { from: path.join(installed, 'dsh-credentials'), to: path.join(root, '@deepseek-ai', 'dsh-credentials') },
  ]
  for (const target of targets) {
    if (fs.existsSync(path.join(target.to, 'package.json'))) continue
    if (!fs.existsSync(path.join(target.from, 'package.json'))) {
      throw new Error('cannot find the installed ' + path.basename(target.from) + ' under ' + installed)
    }
    fs.cpSync(target.from, target.to, { recursive: true })
    console.log('[vendor] copied ' + path.basename(target.from) + ' into node_modules (gitignored, no manifest change)')
  }
  const link = path.join(root, '@earendil-works', 'pi-ai')
  const source = path.join(installed, '..', '@earendil-works', 'pi-ai')
  if (!fs.existsSync(link)) {
    if (!fs.existsSync(path.join(source, 'package.json'))) {
      throw new Error('cannot find the installed @earendil-works/pi-ai beside ' + installed)
    }
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(source, link, 'dir')
    console.log('[vendor] linked @earendil-works/pi-ai -> ' + source)
  }
}

/** Resolve OPENCODE_GO_API_KEY from the credentials file or the environment. */
function resolveCredential(dshHome) {
  if (process.env.OPENCODE_GO_API_KEY) return { source: 'environment' }
  const file = path.join(dshHome, '.credentials.yaml')
  let text = null
  try { text = fs.readFileSync(file, 'utf8') } catch { text = null }
  const match = text?.match(/^  OPENCODE_GO_API_KEY: (.+)$/m)
  if (match === null) throw new Error('OPENCODE_GO_API_KEY is not exported and ' + file + ' does not carry it')
  process.env.OPENCODE_GO_API_KEY = match[1].trim()
  return { source: file }
}

/** The checked-out commit, without trusting the environment. */
function pluginCommit() {
  const shaOf = value => /^[0-9a-f]{40}$/i.test(value ?? '') ? value.toLowerCase() : undefined
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' })
  return shaOf(result.stdout?.trim()) ?? 'unknown'
}

/** The staged worker the row leaves to its own resolution, with its digest. */
function stagedWorkerFacts() {
  const platform = process.platform + '-' + process.arch
  const file = path.join(REPO_ROOT, 'runtime', platform, 'dsh-ops-worker')
  if (!fs.existsSync(file)) throw new Error('no staged worker at ' + file + '; run npm run build:ptc')
  const receipt = path.join(REPO_ROOT, 'runtime', platform, 'provenance.json')
  return {
    file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    receipt: fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, 'utf8')) : null,
  }
}

/** The shipped-row config one arm runs: identical except the preregistered tier. */
function armRow(arm) {
  return {
    global: {},
    discovery: { required: true },
    minimal: { enabled: false }, standard: { enabled: false }, cordis: { enabled: false }, ptc: { enabled: false },
    'ops-ptc': { enabled: true, required: true, disclosurePolicy: arm.disclosurePolicy },
  }
}

/**
 * Boot one session's group: the V1 composition with the real provider.
 * @param {string} root - the seeded workspace.
 * @param {object} arm - the arm descriptor.
 * @returns {Promise<{ctx: object, events: object[], execs: object[], errors: string[]}>} the live group.
 */
async function bootGroup(root, arm) {
  const ctx = new Context(); ctx.logger.level = 0
  ctx.provide('workingDirectory', {
    get: session => session?.header?.cwd ?? root,
    ensure: async agent => agent?.session?.header?.cwd ?? root,
    set: async (_agent, target) => target ?? root,
  })
  const events = []
  const execs = []
  const errors = []
  for (const plugin of [Agents, Sessions, Projections, Prompt]) await ctx.plugin(plugin, {})
  await ctx.plugin(Tools, {})
  await ctx.plugin(Policy, { mode: SANDBOX_MODE, workspaceRoot: root })
  await ctx.plugin(Subprocess)
  await ctx.plugin(Sandbox)
  await ctx.plugin(FileSystem, { cwd: root })
  await ctx.plugin(NodePtc, {})
  await ctx.plugin(PtcExecutor, {})
  ctx.on('session/event', (session, event) => events.push(event))
  await ctx.plugin(Llm, {})
  await ctx.plugin(LlmPiAi, { providers: { [CONDITION.provider]: {
    apiKeyEnv: 'OPENCODE_GO_API_KEY',
    models: [{ id: CONDITION.model, name: CONDITION.model, contextWindow: 1000000, maxTokens: 384000, input: ['text', 'image'] }],
  } } })
  ctx.on('tools/execute', async (exec, next) => { const result = await next(); execs.push({ exec, result }); return result })
  ctx.on('agent/error', ({ error }) => errors.push(String(error?.stack ?? error)))
  const { apply: applyShippedRow } = await import(pathToFileURL(path.join(REPO_ROOT, 'lib', 'index.js')).href)
  await ctx.plugin({ name: 'dsh-ops-v5-row', apply: inner => applyShippedRow(inner, armRow(arm)) })
  await ctx.plugin(Loop, { agents: [], maxParallelToolCalls: 3 })
  await ctx.get('loader')?.await()
  return { ctx, events, execs, errors }
}

/** Parse one exec's arguments whether the host handed a string or an object. */
function execArgs(exec) {
  const raw = exec.input ?? exec.arguments ?? exec.args
  if (raw === undefined || raw === null) return {}
  if (typeof raw === 'string') { try { return JSON.parse(raw) } catch { return { unparsed: String(raw) } } }
  return raw
}

/**
 * Fold a finished session's raw captures into the archived metrics.
 * @param {object[]} events - the raw session events, in order.
 * @param {object[]} execs - the captured tool executions with results.
 * @returns {object} the metrics block.
 */
function foldMetrics(events, execs) {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
  const promptSizes = []
  let steps = 0
  let stepsWithUsage = 0
  const toolCallsByName = Object.create(null)
  let turnEndReason = null
  const number = value => Number.isFinite(Number(value)) ? Number(value) : 0
  for (const event of events) {
    const data = event.data ?? {}
    if (event.type === 'assistant/message') {
      steps += 1
      const reported = data.usage && typeof data.usage === 'object'
      if (reported) {
        stepsWithUsage += 1
        for (const bucket of Object.keys(usage)) usage[bucket] += number(data.usage[bucket])
        promptSizes.push(number(data.usage.inputTokens) + number(data.usage.cacheReadTokens) + number(data.usage.cacheWriteTokens))
      }
      for (const block of data.message?.content ?? []) {
        if (block.type === 'tool-call') toolCallsByName[block.name] = (toolCallsByName[block.name] ?? 0) + 1
      }
      continue
    }
    if (event.type === 'turn/end') turnEndReason = data.reason?.kind ?? null
  }
  return {
    steps, stepsWithUsage,
    usageReported: steps > 0 && stepsWithUsage === steps,
    usage,
    prompt: {
      reported: steps > 0 && promptSizes.length === steps,
      firstStep: promptSizes.length > 0 ? promptSizes[0] : null,
      perStep: promptSizes,
      total: promptSizes.length > 0 ? promptSizes.reduce((sum, value) => sum + value, 0) : null,
    },
    toolCallsByName: { ...toolCallsByName },
    programs: execs.filter(entry => !String(entry.exec.id ?? '').includes(':ptc:')).length,
    turnEndReason,
  }
}

/**
 * Fold the captured executions into the judge-ready trajectory: root programs
 * in completion order, each with its nested calls and envelopes.
 * @param {object[]} execs - the captured tool executions with results.
 * @returns {object} the trajectory block.
 */
function foldTrajectory(execs) {
  const programs = []
  for (const { exec, result } of execs) {
    const callId = String(exec.id ?? exec.callId ?? '')
    if (callId.includes(':ptc:')) continue
    const args = execArgs(exec)
    programs.push({ callId, name: exec.name, description: args.description ?? null, code: args.code ?? null,
      isError: result?.isError === true, error: result?.error?.message ?? null })
  }
  const byRoot = new Map()
  for (const { exec, result } of execs) {
    const callId = String(exec.id ?? exec.callId ?? '')
    const split = callId.lastIndexOf(':ptc:')
    if (split < 0) continue
    const root = callId.slice(0, split)
    if (!byRoot.has(root)) byRoot.set(root, [])
    byRoot.get(root).push({
      api: exec.name,
      args: execArgs(exec),
      response: result?.value ?? { hostError: result?.error?.message ?? 'no envelope' },
    })
  }
  for (const program of programs) {
    program.calls = byRoot.get(program.callId) ?? []
  }
  return { programs }
}

/** Write one JSON file, refusing to clobber. */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

/**
 * Run one measured session end to end and archive it.
 * @param {object} plan - {task, repeat, arm, outDir, timeoutMs, corpus}.
 * @returns {Promise<object>} the archived row summary.
 */
async function runSession(plan) {
  const { task, repeat, arm, outDir, timeoutMs, corpus } = plan
  const workspace = fs.mkdtempSync(path.join(outDir, 'workspaces', task.id + '-r' + repeat + '-' + arm.label + '-'))
  const fixture = generate(task.task.fixture.generator, task.task.fixture.params ?? {})
  for (const file of fixture.files) {
    const target = path.join(workspace, file.path)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, file.content)
  }
  const group = await bootGroup(workspace, arm)
  const { ctx, events, execs, errors } = group
  const startedAt = Date.now()
  let timedOut = false
  let sessionError = null
  let agent = null
  try {
    agent = (await ctx.get('agents').create({
      sessionId: 'v5-' + task.id + '-r' + repeat + '-' + arm.label + '-' + startedAt,
      meta: { cwd: workspace, agentPreset: PRESET },
      agentOptions: { ...CONDITION },
    })).agent
    setSandboxMode(agent.session, SANDBOX_MODE)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: task.task.prompt }], source: { kind: 'user' } }))
    await Promise.race([
      agent.whenIdle(),
      new Promise((resolve, reject) => {
        setTimeout(() => reject(new Error('session timeout')), timeoutMs)
      }),
    ])
  } catch (error) {
    if (/session timeout/.test(String(error?.message))) timedOut = true
    else sessionError = String(error?.stack ?? error)
  }
  const finishedAt = Date.now()
  const metrics = foldMetrics(events, execs)
  const trajectory = foldTrajectory(execs)
  const answerPath = path.join(workspace, 'answer.txt')
  const answer = fs.existsSync(answerPath) ? fs.readFileSync(answerPath, 'utf8') : null
  const outcome = await verifyWorkspace(workspace, task.task.verify, fixture.exports).catch(error => ({ passed: false, checks: [], error: String(error?.message ?? error) }))
  try { await ctx.fiber.dispose() } catch { /* the session is over; dispose is best-effort */ }
  if (!plan.keepWorkspaces) fs.rmSync(workspace, { recursive: true, force: true })

  const row = {
    task: task.id, repeat, arm: arm.label, condition: CONDITION, preset: PRESET,
    startedAt, finishedAt, durationMs: finishedAt - startedAt,
    timedOut, sessionError, agentErrors: errors,
    ...metrics,
    trajectoryPrograms: trajectory.programs.length,
    verify: { passed: outcome.passed === true, checks: (outcome.checks ?? []).map(check => ({ type: check.type, path: check.path, passed: check.passed === true, detail: check.detail ?? '' })) },
    answer,
  }
  const stem = task.id + '-r' + repeat + '.' + arm.label
  writeJson(path.join(outDir, 'results', stem + '.metrics.json'), row)
  writeJson(path.join(outDir, 'results', stem + '.trajectory.json'), trajectory)
  fs.writeFileSync(path.join(outDir, 'results', stem + '.events.ndjson'),
    events.map(event => JSON.stringify(event)).join('\n') + '\n')
  return row
}

/**
 * The entry point.
 * @param {string[]} argv - the arguments after the script name.
 */
export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const dshHome = options.dshHome ?? path.join(os.homedir(), '.dsh')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outDir = options.out ? path.resolve(options.out) : path.join(BENCH_DIR, 'runs', 'v5-' + stamp)
  fs.mkdirSync(path.join(outDir, 'results'), { recursive: true })
  fs.mkdirSync(path.join(outDir, 'workspaces'), { recursive: true })

  // Environment facts, frozen before any session runs (#994 step 1).
  const entry = resolveDshEntry(null)
  const installedDsh = path.resolve(path.dirname(entry.file), '..')
  ensureVendoredLlm(path.join(installedDsh, 'node_modules', '@deepseek-ai'))
  const credentialSource = resolveCredential(dshHome)
  const worker = stagedWorkerFacts()
  const corpus = loadTrackTasks()
  const arms = options.aa ? AA_ARMS : ARMS
  const environment = {
    plugin: { commit: pluginCommit(), root: REPO_ROOT },
    host: { version: getDshRuntimeVersion?.() ?? 'unknown' },
    platform: process.platform + '-' + process.arch, node: process.version,
    worker: { file: worker.file, sha256: worker.sha256, receipt: worker.receipt },
    sandbox: { mode: SANDBOX_MODE }, preset: PRESET, condition: CONDITION,
    credential: { source: credentialSource.source },
    tasks: options.tasks, repeat: options.repeat, aa: options.aa,
    note: 'composed V1 isolated-entry group with the real llm-pi-ai adapter; the host one-shot runner cannot compose presets, so bench ab (host realm = Standard) would be invalid per #980',
  }
  for (const arm of arms) {
    const dump = [
      '# v5 dump-config — arm ' + arm.label + ' (' + new Date().toISOString() + ')',
      '# The frozen sweep facts; the row below is the only preregistered difference.',
      'condition: ' + JSON.stringify(CONDITION),
      'preset: ' + PRESET,
      'sandbox: ' + SANDBOX_MODE,
      'row:',
      JSON.stringify(armRow(arm), null, 2),
    ].join('\n')
    fs.mkdirSync(path.join(outDir, 'arms', arm.label), { recursive: true })
    fs.writeFileSync(path.join(outDir, 'arms', arm.label, 'dump-config.txt'), dump + '\n')
  }
  writeJson(path.join(outDir, 'environment.json'), environment)

  // AB/BA interleave per (task, repeat), as bench/run/schedule.mjs orders a sweep.
  const plan = []
  for (const id of options.tasks) {
    const task = corpus.find(entry => entry.id === id)
    if (task === undefined) { console.error('unknown task ' + id); return 1 }
    for (let repeat = 1; repeat <= options.repeat; repeat += 1) {
      const order = repeat % 2 === 1 ? [arms[0], arms[1]] : [arms[1], arms[0]]
      for (const arm of order) {
        plan.push({ task, repeat, arm, outDir, timeoutMs: options.timeoutMs ?? task.task.timeoutMs, keepWorkspaces: options.keepWorkspaces, corpus })
      }
    }
  }
  console.log('[v5] sweep ' + outDir + ' — ' + plan.length + ' sessions: ' + options.tasks.join(', ') + ' x ' + options.repeat + ' x ' + arms.length + ' arms' + (options.aa ? ' (A/A)' : ''))
  const rows = []
  for (let index = 0; index < plan.length; index += 1) {
    const row = plan[index]
    console.log('[v5] ' + (index + 1) + '/' + plan.length + ' — ' + row.task.id + ' r' + row.repeat + ' arm=' + row.arm.label + ' (timeout ' + row.timeoutMs + 'ms)')
    const summary = await runSession(row)
    rows.push(summary)
    console.log('[v5]   -> ' + (summary.timedOut ? 'TIMEOUT' : summary.verify.passed ? 'pass' : 'fail')
      + ' steps=' + summary.steps + ' usage=' + (summary.usageReported ? 'yes' : 'MISSING')
      + ' prompt1=' + summary.prompt.firstStep + ' programs=' + summary.trajectoryPrograms
      + ' ' + summary.durationMs + 'ms')
  }
  writeJson(path.join(outDir, 'summary.json'), { environment, rows })
  const failed = rows.filter(row => row.sessionError !== null).length
  console.log('[v5] sweep complete: ' + rows.length + ' sessions, ' + failed + ' with session errors')
  console.log('[v5] collect with: node bench/v5-collect.mjs --run ' + outDir)
  return failed === 0 ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main()
}
