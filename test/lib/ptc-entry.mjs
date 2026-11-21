/**
 * The isolated OPS-PTC entry (#990).
 *
 * A headless comparison is only evidence when the group it measured truly
 * entered the OPS-PTC routing: one run_code transport, the shipped ops-ptc row,
 * and an executable worker. This module is that guarantee, packaged for the
 * later measurement cards (V2-V5) to reuse:
 *
 * - bootEntryGroup boots one preset group on the real AgentLoop with the
 *   shipped single row mounted, inside this suite's throwaway DSH_HOME.
 *   Nothing outside the temp root is read; the probe file the entry inspects
 *   is freshly invented content, never a real session or credential.
 * - collectEnvironment records the machine facts a measurement must be able to
 *   name: plugin commit, host version, platform, worker digest and staged
 *   receipt, sandbox mode, the row's resolved switches, and the actual preset.
 *   The provider is scripted and every report says so: a mocked provider can
 *   verify assembly only, and no real model request ever leaves the fixture.
 * - enterPtc runs the minimal case (one scripted provider request) and
 *   separates every way the group could quietly prove nothing: a worker that
 *   cannot execute, a preset that is not the target (Standard is the
 *   deliberate counter-example), a transport that is not run_code, an
 *   execution that failed. An invalid report carries its reasons and no
 *   evidence block at all, so it can never be mistaken for a comparable
 *   result. Byte and cost accounting is deliberately not collected here;
 *   that is the V2 card's scope.
 *
 * @module dsh-ops/test/lib/ptc-entry
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { presetOf } from '../../lib/consumer/identity.js'
import { modeOf } from '../../lib/presets/detect.js'
import { MODE_IDS } from '../../lib/presets/types.js'
import { resolveMergedConfig } from '../../lib/settings/merged.js'
import { bootLoop } from './agent-loop.mjs'
import { WORKER } from './boundary.mjs'
import { assert, PACKAGE_ROOT, TEST_HOME } from './harness.mjs'

/** The preset this entry exists to prove: OPS (PTC), the sandboxed-code routing. */
export const TARGET_PRESET = 'ops-ptc'

/** Read a small file as trimmed text, or undefined when it cannot be read. */
function readText(file) {
  try { return fs.readFileSync(file, 'utf8').trim() } catch { return undefined }
}

/** Parse one JSON file, or undefined when it cannot be read or parsed. */
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return undefined }
}

/** sha256 of one file, or undefined when it cannot be read. */
function sha256OfFile(file) {
  try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex') } catch { return undefined }
}

/** Whether the worker path names a file this process may execute. */
function workerExecutable(file) {
  try { fs.accessSync(file, fs.constants.X_OK); return true } catch { return false }
}

/**
 * The checked-out commit, read straight from the git directory.
 *
 * No subprocess is spawned and no environment is trusted: a plain checkout
 * (a .git directory), a linked worktree (a .git pointer plus commondir) and a
 * detached HEAD all resolve, and anything else honestly reports 'unknown'
 * instead of a guess. A suite assertion turns the value into a claim.
 * @param {string} [root] - the checkout root; defaults to the package root.
 * @returns {string} the 40-hex commit, or 'unknown'.
 */
export function pluginCommit(root = PACKAGE_ROOT) {
  const shaOf = value => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : undefined
  let gitdir = path.join(root, '.git'), common = gitdir
  let stat
  try { stat = fs.statSync(gitdir) } catch { return 'unknown' }
  if (stat.isFile()) {
    const pointer = readText(gitdir)?.match(/^gitdir:\s*(\S+)$/m)?.[1]
    if (pointer === undefined) return 'unknown'
    gitdir = path.resolve(root, pointer)
  }
  const shared = readText(path.join(gitdir, 'commondir'))
  if (shared !== undefined) common = path.resolve(gitdir, shared)
  const head = readText(path.join(gitdir, 'HEAD'))
  const direct = shaOf(head)
  if (direct !== undefined) return direct
  const ref = head?.match(/^ref:\s*(\S+)$/)?.[1]
  if (ref === undefined) return 'unknown'
  for (const base of [gitdir, common]) {
    const sha = shaOf(readText(path.join(base, ref)))
    if (sha !== undefined) return sha
  }
  const packed = readText(path.join(common, 'packed-refs')) ?? ''
  const escaped = ref.replace(/[^A-Za-z0-9/_.-]/g, '\\$&')
  const line = packed.match(new RegExp('^([0-9a-f]{40}) ' + escaped + '$', 'm'))
  return line === null ? 'unknown' : line[1]
}

/** The staged runtime receipt for one platform, or null when nothing is staged. */
function stagedReceipt(platform) {
  const receipt = readJson(path.join(PACKAGE_ROOT, 'runtime', platform, 'provenance.json'))
  return receipt === undefined ? null : receipt
}

/**
 * The shipped-row configuration one group boots with: only the target mode is
 * enabled, every mode's worker is pinned to the same explicit binary.
 * @param {string} mode - the single mode row to enable.
 * @param {object} [options] - row inputs.
 * @param {string} [options.worker] - the worker binary the row pins.
 * @param {Record<string, unknown>} [options.switches] - overrides for the enabled mode.
 * @returns {Record<string, unknown>} the row configuration for the shipped apply.
 */
export function entryRow(mode, { worker = WORKER, switches = {} } = {}) {
  const row = { global: {}, discovery: { binaryPath: worker, required: true } }
  for (const id of MODE_IDS) {
    row[id] = { enabled: id === mode, binaryPath: worker, required: true, ...(id === mode ? switches : {}) }
  }
  return row
}

/**
 * The environment one group runs in: recorded machine facts, never claims.
 * @param {object} options - what the group ran as.
 * @param {string} options.root - the group's isolated work directory.
 * @param {string} options.preset - the agentPreset the group's agents carry.
 * @param {string|undefined} options.mode - the mode row the group enabled.
 * @param {string} [options.worker] - the worker binary the row pins.
 * @param {Record<string, unknown>} options.row - the row configuration booted.
 * @param {string} [options.sandboxMode] - the sandbox mode the loop commits.
 * @returns {Promise<object>} the environment summary.
 */
export async function collectEnvironment({ root, preset, mode, worker = WORKER, row, sandboxMode = 'workspace-write' } = {}) {
  const platform = process.platform + '-' + process.arch
  const resolved = resolveMergedConfig(row)
  const boot = await import('@deepseek-ai/dsh-app-boot')
  const digest = sha256OfFile(worker)
  const staged = stagedReceipt(platform)
  const state = mode === undefined ? undefined : resolved[mode]
  return {
    plugin: { commit: pluginCommit(), version: readJson(path.join(PACKAGE_ROOT, 'package.json'))?.version },
    host: { version: typeof boot.getDshRuntimeVersion === 'function' ? boot.getDshRuntimeVersion() : 'unknown' },
    platform,
    node: process.version,
    worker: {
      file: worker,
      sha256: digest,
      executable: workerExecutable(worker),
      staged: staged === null ? null : { target: staged.target, sha256: staged.sha256, version: staged.version },
      matchesStaged: staged === null || digest === undefined ? undefined : digest === staged.sha256,
    },
    sandbox: { mode: sandboxMode, workspaceRoot: root },
    dshHome: TEST_HOME,
    agentPreset: preset,
    mode,
    switches: state === undefined ? {} : {
      enabled: state.enabled,
      residentTools: state.config.residentTools,
      dynamicTools: state.config.dynamicTools,
      batchingGuidance: state.config.batchingGuidance,
      batchingTelemetry: state.config.batchingTelemetry,
      hideOfficialTools: state.config.hideOfficialTools,
      bash: state.config.bash,
      global: resolved.global,
    },
    // A mocked provider verifies assembly only; no real model request leaves
    // the fixture, and every report carries this marker instead of hiding it.
    provider: 'scripted',
    networkModelRequests: 0,
  }
}

/**
 * Boot one isolated preset group on the real loop with the shipped row.
 *
 * The group's root must live inside this suite's throwaway DSH_HOME. A boot
 * that fails because the row refuses a missing worker is reported as the
 * 'worker' failure; any other boot failure is rethrown, because it is a suite
 * defect, not an honest environment answer.
 * @param {string} root - the isolated work directory (under the suite home).
 * @param {object} [options] - group inputs.
 * @param {string} [options.preset] - the agentPreset; defaults to the target.
 * @param {Record<string, unknown>} [options.switches] - mode row overrides.
 * @param {'ptc'|'native'} [options.executor] - force the executor; defaults by mode.
 * @param {string} [options.worker] - the worker binary; defaults to the test build.
 * @param {string} [options.sandboxMode] - recorded with the environment.
 * @param {Array} [options.hostPlugins] - host plugins (e.g. the official file
 *   tools) mounted before the shipped row, so a group measures against a real
 *   official surface instead of an empty registry.
 * @returns {Promise<object>} the booted group, or an invalid-boot report.
 */
export async function bootEntryGroup(root, { preset = TARGET_PRESET, switches = {}, executor, worker = WORKER, sandboxMode = 'workspace-write', hostPlugins = [] } = {}) {
  assert.ok(path.resolve(root).startsWith(path.resolve(TEST_HOME)),
    'the entry only boots groups inside the suite throwaway DSH_HOME, got ' + root)
  const mode = MODE_IDS.includes(preset) ? preset : undefined
  const row = entryRow(mode ?? 'standard', { worker, switches })
  const environment = await collectEnvironment({ root, preset, mode, worker, row, sandboxMode })
  const ptcPresentation = executor === 'native' ? false : executor === 'ptc' ? true : mode === 'ops-ptc' || mode === 'ptc'
  try {
    const host = await bootLoop(root, { ptcMode: ptcPresentation, preset, row, hostPlugins })
    return { booted: true, host, root, worker, preset, mode, environment, close: () => host.close() }
  } catch (error) {
    const message = String(error?.message ?? error)
    if (/Native worker/.test(message)) {
      return { booted: false, reason: 'worker', detail: message, environment }
    }
    throw error
  }
}

/** The probe file enterPtc invents in the group root before it executes one program. */
const PROBE_FILE = 'entry-probe.txt'

/**
 * Run the minimal case through the real loop and judge the routing honestly.
 *
 * Phase one is exactly one scripted provider request and executes nothing: it
 * observes the wire surface the group would send. Only a run_code surface
 * earns a second turn, which invents one fresh probe file and executes a
 * single program through the worker. Checks run in a fixed priority order
 * (worker, preset, route, execution) and the first failure becomes the
 * report's reason; an invalid report never carries an evidence block.
 * @param {object} group - a {@link bootEntryGroup} result.
 * @param {object} [options] - validation inputs.
 * @param {string} [options.target] - the preset the report demands.
 * @returns {Promise<object>} the entry report.
 */
export async function enterPtc(group, { target = TARGET_PRESET } = {}) {
  if (group.booted === false) {
    return { status: 'invalid', target, reason: group.reason,
      findings: { worker: { ok: false, detail: group.detail } },
      environment: group.environment }
  }
  const { host, worker, environment } = group
  const agent = await host.agent()
  const identity = {
    preset: presetOf(host.ctx, agent),
    declared: agent.session?.header?.agentPreset,
    mode: modeOf(host.ctx, agent),
  }
  let surface
  const probe = await host.run(agent, [request => {
    // A composition that declares no tool at all sends no tools array; that
    // absence is data for the route check, not a crash.
    surface = {
      topLevel: (request.tools ?? []).map(tool => tool.name).sort(),
      text: JSON.stringify(request.messages),
    }
    return []
  }])
  const routeOk = surface.topLevel.length === 1 && surface.topLevel[0] === 'run_code'
    && /ops_[a-z0-9_]+:/.test(surface.text)
  let execution = { ok: false, requests: 0, result: undefined }
  if (routeOk) {
    // Freshly invented content only: the probe file is this entry's own fixture.
    fs.writeFileSync(path.join(group.root, PROBE_FILE), 'ops-ptc entry probe\n')
    const program = '// plan: inspect the freshly made probe file once\n'
      + 'const outcome = await tools.ops_inspect_local_file({ path: ' + JSON.stringify(PROBE_FILE) + ' })\n'
      + 'return outcome'
    const executed = await host.run(agent, [
      () => [{ name: 'run_code', args: { description: 'Prove the OPS-PTC entry executes', code: program } }], []])
    const result = executed.results.find(value => value.exec.name === 'run_code')?.result
    execution = { ok: result?.isError === false, requests: executed.requests.length, result }
  }
  const findings = {
    worker: { ok: workerExecutable(worker), file: worker },
    preset: { ok: identity.preset === target, target, actual: identity.preset, declared: identity.declared, mode: identity.mode },
    route: { ok: routeOk, expected: ['run_code'], topLevel: surface.topLevel, transport: routeOk ? 'ptc' : 'unknown-or-native' },
    execution: routeOk
      ? { ok: execution.ok, requests: execution.requests }
      : { ok: null, attempted: false, note: 'route invalid: nothing was executed' },
  }
  const order = ['worker', 'preset', 'route']
  if (routeOk) order.push('execution')
  const failed = order.filter(reason => findings[reason].ok !== true)
  if (failed.length > 0) {
    // The refusal is explicit and carries nothing that could be read as a
    // comparable result: no evidence block, no measurement of any kind.
    return { status: 'invalid', target, reason: failed[0], findings, environment }
  }
  return {
    status: 'entered',
    target,
    findings,
    evidence: {
      topLevel: surface.topLevel,
      preset: identity.preset,
      mode: identity.mode,
      requests: { probe: probe.requests.length, execution: execution.requests },
      executed: execution.result,
    },
    environment,
  }
}
