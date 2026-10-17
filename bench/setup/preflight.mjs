/**
 * Setup B: the preflight half of `setup` — the self-checks a sweep cannot mean anything
 * without, run before a single profile is touched.
 *
 * Three checks, in the order they are printed:
 *
 * - **The permission combination.** A bench sweep pins both sides to one sandbox mode, and
 *   `dsh-base` derives the approval preset from that mode (`never` only for
 *   `danger-full-access`). A layer that pairs a mode with another preset, a mode outside the
 *   set `profile.mjs` pins, or two sides that do not run alike is a measured condition that
 *   was never measured: the sweep would compare modes, not the plugin. The mapping itself is
 *   never re-derived here — `permissionEntries`/`approvalPolicyFor` own it, and this module
 *   reads the pair back out of them.
 * - **`PSModulePath`.** The ordering rule lives in `bench/lib/env.mjs`: a Core module root
 *   that really ships `Microsoft.PowerShell.Security` ahead of the in-box 5.1 directory makes
 *   dsh-ops' workspace bootstrap die in `Get-Acl`, so every candidate-side `pwsh` / `bash` /
 *   `run_code` call fails before the model's command runs. The value is Windows-shaped on any
 *   host, so the `';'` delimiter default and `path.win32` joiner are the whole portability
 *   story and are deliberately not replaced with `path.delimiter`/`path.join`.
 * - **The local build.** The candidate executes *this checkout* (a pnpm link), and
 *   `runtime/<platform>-<arch>` is gitignored build output. A missing worker or a Bash IPC
 *   proxy built from sources that have since changed breaks the candidate only — the baseline
 *   keeps serving — so the sweep reads as a plugin regression. Every problem names the one
 *   rebuild command. Presence and receipts are structural facts this module can answer
 *   cheaply; the binary itself (version tag, hash, PE/ELF/Mach-O architecture) is the
 *   canonical gate's question (`bin/native-runtime.mjs check --platform <target>`), which is
 *   run rather than re-implemented.
 *
 * The closing hint is one command: `ab` runs the baseline, the candidate and the comparison,
 * and handing the operator three manual commands would be handing them a way to get the
 * group wrong.
 *
 * @module dsh-ops/bench/setup/preflight
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

import { REPO_ROOT, describeModulePath, poisonedModulePath } from '../lib/env.mjs'
import { PLATFORMS, workerName } from '../../lib/ptc/runtime.js'
import { bundledShell } from '../../lib/shells.js'
import {
  APPROVAL_CONFIG_KEY, APPROVAL_ENTRY_ID, PERMISSION_CONFIG_KEY, PERMISSION_ENTRY_ID,
  PERMISSION_MODES, approvalPolicyFor, entryConfigValue, nextStepLines, permissionEntries,
} from './profile.mjs'

/** The modes a profile can actually run under. `none` is `profile.mjs`'s "leave the
 * profiles alone" sentinel rather than a sandbox mode, so it never counts as one here. */
export const SANDBOX_MODES = PERMISSION_MODES.filter((mode) => mode !== 'none')

/** Setup B's own flags, handed to `profile.mjs`'s parser, which merges them over its own. */
export const EXTRA_FLAGS = { boolean: { '--no-build-check': ['noBuildCheck', true] } }

/** The flag line setup B appends to `profile.mjs`'s usage. */
export const USAGE_EXTRA = `  --no-build-check        skip the local-build check: the candidate runs this
                          checkout, so an absent or stale runtime/<platform>-<arch> worker, a
                          Bash IPC proxy built from sources that have since changed, or an
                          absent shell payload would otherwise be reported — the build
                          problems as failures`

/** One side's `(mode, approval)` pair, as it stands in a profile patch layer. `null` means
 * the layer pins neither key: `profile.mjs` has not pinned this profile yet.
 * @typedef {{mode: string|null, approval: string|null}|null} PermissionPair */

/** Render a pair for a message: always both keys, so "pinned nothing" can never be mistaken
 * for "pinned the right thing".
 * @param {PermissionPair} pair - the pair, or null.
 * @returns {string} the readable form. */
function pairText(pair) {
  return pair === null ? 'nothing pinned' : `mode=${pair.mode ?? '(unset)'} approval=${pair.approval ?? '(unset)'}`
}

/**
 * The `(mode, approval)` pair `profile.mjs` pins for one requested mode, read out of
 * {@link permissionEntries} — the mapping stays owned there and is never repeated here.
 * @param {string} mode - a sandbox mode.
 * @returns {{mode: string|null, approval: string|null}} the pair.
 */
export function pinnedPair(mode) {
  const entries = permissionEntries(mode)
  const value = (id, key) => entries.find((entry) => entry.id === id)?.config?.[key] ?? null
  return {
    mode: value(PERMISSION_ENTRY_ID, PERMISSION_CONFIG_KEY),
    approval: value(APPROVAL_ENTRY_ID, APPROVAL_CONFIG_KEY),
  }
}

/**
 * Read one side's pair out of a `cordis.patch.yml` patch layer, through `profile.mjs`'s own
 * entry reader — the layer and a composed `--dump-config` tree spell an entry the same way,
 * so reading it works before the profile has ever been composed.
 * @param {string} text - the patch layer's content.
 * @returns {PermissionPair} the pair, or null when neither key is pinned.
 */
export function layerPair(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  const mode = entryConfigValue(text, PERMISSION_ENTRY_ID, PERMISSION_CONFIG_KEY)
  const approval = entryConfigValue(text, APPROVAL_ENTRY_ID, APPROVAL_CONFIG_KEY)
  return mode === null && approval === null ? null : { mode, approval }
}

/**
 * One side's pair against the mode this run will pin, as a refusal or null.
 * @param {string} who - the side, for the message.
 * @param {PermissionPair} pair - the side's pair.
 * @param {string|null} requested - the mode being pinned, or null when nothing is pinned
 *   (`--permission-mode none`), which is when `--force` cannot repair anything.
 * @param {boolean} force - whether `profile.mjs` is allowed to overwrite a foreign pair;
 *   under `--force` a diagnose-able pair is not a refusal.
 * @returns {string|null} the refusal, or null when this side is consistent.
 */
function pairProblem(who, pair, requested, force) {
  if (!pair) return null
  const rewrite = `re-run with --force to rewrite it`
  const diagnose = () => {
    if (pair.mode !== null && !SANDBOX_MODES.includes(pair.mode)) {
      return `the ${who} profile pins "${pair.mode}", which is not a sandbox mode (${SANDBOX_MODES.join(' / ')}): a foreign mode is refused rather than compared`
    }
    if (pair.mode === null) {
      return `the ${who} profile pins an approval preset without a sandbox mode (${pairText(pair)}): the two are pinned together by permissionEntries, so this layer was edited by hand — ${rewrite}`
    }
    const derived = approvalPolicyFor(pair.mode)
    if (pair.approval !== derived) {
      return `the ${who} profile pairs ${pair.mode} with approval ${pair.approval ?? '(unset)'}, but dsh-base derives ${derived} from that mode: the combination is not self-consistent — ${rewrite}`
    }
    if (requested !== null && pair.mode !== requested) {
      return `the ${who} profile already pins ${pair.mode} while this run asked for ${requested}: both sides have to run in one mode — ${rewrite}, or leave the profiles alone with --permission-mode none`
    }
    return null
  }
  const problem = diagnose()
  // --force makes every diagnosis here repairable: profile.mjs rewrites the pair. With
  // --permission-mode none nothing is written, so the same diagnosis stays a refusal.
  return requested !== null && force ? null : problem
}

/**
 * Judge the permission combination: the requested mode, the pair each side already carries,
 * and the two sides against each other.
 * @param {object} input - what to judge.
 * @param {string} input.requested - the mode this run pins, or `none` to leave both alone.
 * @param {PermissionPair} [input.base] - the baseline profile's current pair.
 * @param {PermissionPair} [input.cand] - the candidate profile's current pair.
 * @param {boolean} [input.force] - `--force`, which lets `profile.mjs` rewrite a foreign pair.
 * @returns {{ok: boolean, problems: string[], warnings: string[], expected: {mode: string|null, approval: string|null}|null}}
 *   the verdict; `expected` is the pair the requested mode implies.
 */
export function inspectPermissions({ requested, base = null, cand = null, force = false }) {
  const problems = []
  const warnings = []
  if (!PERMISSION_MODES.includes(requested)) {
    problems.push(`permission mode "${requested}" is not one profile.mjs pins (${SANDBOX_MODES.join(' / ')}, or "none" to leave both sides alone): a foreign mode is refused rather than prepared`)
    return { ok: false, problems, warnings, expected: null }
  }
  if (requested === 'none') {
    for (const [who, pair] of [['base', base], ['cand', cand]]) {
      const bad = pairProblem(who, pair, null, false)
      if (bad) problems.push(bad)
    }
    // The whole reason --permission-mode none is not "the safe default": nothing is pinned,
    // so the two sides can differ, and a sweep whose sides differ measures the modes.
    if (base && cand) {
      if (base.mode !== cand.mode || base.approval !== cand.approval) {
        problems.push(`--permission-mode none left the two sides in different modes (base: ${pairText(base)}; cand: ${pairText(cand)}): a sweep then measures the modes instead of the plugin — pin one with --permission-mode <mode>`)
      }
    } else if (base || cand) {
      warnings.push(`only one side pins a mode (base: ${pairText(base)}; cand: ${pairText(cand)}): the other keeps the profile's own composition, so the two sides may not be comparable`)
    } else {
      warnings.push('neither side pins a sandbox mode: both keep whatever the profile composes, so two sides that differ measure the modes — pin one with --permission-mode <mode>')
    }
    return { ok: problems.length === 0, problems, warnings, expected: null }
  }

  const expected = pinnedPair(requested)
  if (expected.mode !== requested || expected.approval !== approvalPolicyFor(requested)) {
    problems.push(`profile.mjs disagrees with itself for "${requested}": permissionEntries pins ${pairText(expected)} while approvalPolicyFor derives "${approvalPolicyFor(requested)}" — the mode and its approval preset have to come from one mapping`)
  }
  for (const [who, pair] of [['base', base], ['cand', cand]]) {
    const bad = pairProblem(who, pair, requested, force)
    if (bad) problems.push(bad)
  }
  return { ok: problems.length === 0, problems, warnings, expected }
}

/**
 * The `PSModulePath` verdict: the poisoned entry and the one fix that works.
 *
 * The ordering rule and its `';'`-delimited, `path.win32`-joined shape belong to
 * `bench/lib/env.mjs`; this only turns its answer into an operator-facing warning. The fix
 * is a fresh `cmd.exe` because the poison is inherited: a PowerShell 7 session prepends its
 * own module root before dsh-ops is ever started, and no edit made from inside this process
 * can put the in-box 5.1 directory back in front.
 * @param {object} [probe] - what to inspect.
 * @param {string} [probe.modulePath] - the `PSModulePath` value (undefined or empty is clean).
 * @param {string} [probe.windows] - the Windows root the in-box entry is derived from.
 * @param {(file: string) => boolean} [probe.isDirectory] - the module-directory probe.
 * @returns {{entry: string, warning: string}|null} the finding, or null when the order is clean.
 */
export function inspectModulePath({ modulePath, windows, isDirectory } = {}) {
  // No explicit delimiter: the value is a Windows variable and ';' is the rule's default.
  const poison = poisonedModulePath(modulePath, windows, isDirectory)
  if (!poison) return null
  return {
    entry: poison,
    warning: `PSModulePath puts ${poison} ahead of the in-box Windows PowerShell 5.1 module directory: dsh-ops' workspace bootstrap then dies in Get-Acl, so every candidate-side pwsh / bash / run_code call fails before the model's command runs. Fix: open a fresh cmd.exe window — cmd.exe inherits the machine's own PSModulePath, while a PowerShell 7 session has already prepended its Core module root — and run this command there.`,
  }
}

/**
 * The newest Rust input under `native/` — `<native>/src/**` plus the crate manifests —
 * skipping `native/target`, which is build output rather than input.
 * @param {string} nativeDir - the crate root.
 * @returns {{file: string, mtimeMs: number}|null} the newest input, or null when there is none.
 */
function newestRustInput(nativeDir) {
  let newest = null
  const visit = (file) => {
    let stat
    try { stat = fs.statSync(file) } catch { return }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(file, { withFileTypes: true })) visit(path.join(file, entry.name))
      return
    }
    if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { file, mtimeMs: stat.mtimeMs }
  }
  for (const input of ['src', 'Cargo.toml', 'Cargo.lock']) visit(path.join(nativeDir, input))
  return newest
}

/**
 * The Windows Bash IPC proxies are a local build too: the DLLs are compiled from
 * `native/bash-ipc`, and the receipt carries the hashes of both the DLLs and the sources
 * they came from — so "rebuilt from source that has since changed" is detectable instead of
 * merely suspected.
 * @param {string} root - the checkout root.
 * @returns {{what: string, fix: string}[]} the problems; empty when present and current. */
function bashIpcProblems(root) {
  const fix = 'npm run build:bash-ipc (Windows x64 with the VS C++ toolchain)'
  const directory = path.join(root, 'runtime', 'win32-x64', 'bash-ipc')
  const receiptFile = path.join(directory, 'provenance.json')
  if (!fs.existsSync(receiptFile)) {
    return [{ what: `the local build has no Bash IPC proxies (${path.relative(root, receiptFile)} is missing)`, fix }]
  }
  let receipt
  try { receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')) } catch {
    return [{ what: `the Bash IPC receipt cannot be read (${path.relative(root, receiptFile)})`, fix }]
  }
  const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  const problems = []
  for (const name of ['opsipc.dll', 'opsnt.dll']) {
    const file = path.join(directory, name)
    if (!fs.existsSync(file)) { problems.push({ what: `the Bash IPC proxies are missing ${name}`, fix }); continue }
    if (receipt.files?.[name] !== sha256(file)) {
      problems.push({ what: `Bash IPC proxy ${name} does not match its receipt hash (swapped, or never rebuilt)`, fix })
    }
  }
  for (const name of ['security.h', 'opsipc.cpp', 'opsnt.cpp']) {
    const source = path.join(root, 'native', 'bash-ipc', name)
    if (!fs.existsSync(source) || receipt.sources?.[name] !== sha256(source)) {
      problems.push({ what: `Bash IPC source ${name} changed while the proxies stayed old`, fix })
    }
  }
  return problems
}

/**
 * The plugin's own shells are payload packages rather than a local build, but the candidate
 * measures *them*: a missing payload silently moves the candidate onto the machine's shells
 * while the baseline keeps its own, which is a different experiment. Asked through the
 * plugin's own resolver, so preflight cannot disagree with what activation will find.
 * @param {string} root - the checkout (the plugin package root, via the pnpm link).
 * @param {string} arch - the host architecture.
 * @returns {string[]} one line per unusable shell; empty when both are the plugin's own. */
function shellPayloadWarnings(root, arch) {
  const warnings = []
  for (const kind of ['bash', 'pwsh']) {
    const bundled = bundledShell({ kind, bundleRoot: root, platform: 'win32', arch })
    if (!bundled.file) {
      warnings.push(`the plugin's own ${kind} is unusable (${bundled.cause ?? 'unknown cause'}): ${bundled.detail ?? ''} — the candidate falls back to the machine's shell while the baseline keeps its own, which is not the same experiment; run npm install so the optionalDependencies come back`)
    }
  }
  return warnings
}

/**
 * What this checkout's local build is missing, split into fatal problems and warnings.
 *
 * The candidate runs from this checkout (a pnpm link), so an absent or stale native worker,
 * or a Bash IPC proxy built from source that has since changed, is a condition of the
 * candidate side only: the baseline keeps working, every candidate call that needs the
 * artifact dies, and the sweep reads as a plugin regression.
 * @param {object} [options] - what to inspect.
 * @param {string} [options.root] - the checkout root.
 * @param {string} [options.platform] - the target platform (defaults to the host).
 * @param {string} [options.arch] - the target architecture (defaults to the host).
 * @returns {{problems: {what: string, fix: string}[], warnings: string[]}} the verdict.
 */
export function inspectLocalBuild({ root = REPO_ROOT, platform = process.platform, arch = process.arch } = {}) {
  const target = `${platform}-${arch}`
  const problems = []
  const warnings = []
  if (!PLATFORMS.includes(target)) {
    problems.push({
      what: `this host is ${target}, outside the plugin's native support matrix (${PLATFORMS.join(' / ')}): the candidate has no worker, so PTC and run_code cannot start`,
      fix: 'run the sweep on a supported target, or build one per docs/linux-build.md',
    })
    return { problems, warnings }
  }
  const directory = path.join(root, 'runtime', target)
  const worker = path.join(directory, workerName(target.split('-')[0]))
  const receipt = path.join(directory, 'provenance.json')
  if (!fs.existsSync(worker) || !fs.existsSync(receipt)) {
    problems.push({
      what: `the local build has no ${target} native worker (${path.relative(root, worker)} or the provenance.json beside it is missing)`,
      fix: 'npm run build:ptc (compiles and stages this host target)',
    })
  } else {
    const rust = newestRustInput(path.join(root, 'native'))
    if (rust && rust.mtimeMs > fs.statSync(worker).mtimeMs) {
      warnings.push(`the staged worker is older than ${path.relative(root, rust.file)}: this sweep may measure a build that predates native/src (rebuild: npm run build:ptc)`)
    }
  }
  // The proxies exist for win32-x64 only, and only when the sources shipped with them.
  if (target === 'win32-x64' && fs.existsSync(path.join(root, 'native', 'bash-ipc'))) problems.push(...bashIpcProblems(root))
  if (platform === 'win32') warnings.push(...shellPayloadWarnings(root, arch))
  return { problems, warnings }
}

/** The canonical gate, spawned without a shell. Injectable so a suite never runs it.
 * @param {string} root - the checkout holding `bin/native-runtime.mjs`.
 * @param {Record<string, string|undefined>} env - the environment to spawn in.
 * @returns {(target: string) => {status: number|null, stdout: string, stderr: string, errorCode: string|null}} the gate. */
function defaultGate(root, env) {
  const script = path.join(root, 'bin', 'native-runtime.mjs')
  return (target) => {
    const result = spawnSync(process.execPath, [script, 'check', '--platform', target], {
      encoding: 'utf8', timeout: 30_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env,
    })
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', errorCode: result.error?.code ?? null }
  }
}

/**
 * Check the local build the candidate will execute, and let the canonical gate judge the
 * binary itself (version tag, hash and PE/ELF/Mach-O architecture, which this module
 * deliberately does not re-implement).
 *
 * A `--plugin` that names a package makes the checkout's build irrelevant, and
 * `--no-build-check` is the operator's own call; both are reported rather than skipped
 * silently. Under `--dry-run` a missing artifact is a plan note, not a refusal: the plan
 * writes nothing, so nothing is broken by it yet.
 * @param {{plugin: string, noBuildCheck?: boolean, dryRun?: boolean}} options - the options.
 * @param {object} [context] - the run context: root, platform, arch, env, log, runGate.
 * @returns {{problems: {what: string, fix: string}[], warnings: string[], status: 'ok'|'problems'|'skipped'|'planned'}}
 *   the verdict and what it was.
 */
export function checkLocalBuild(options, context = {}) {
  const log = context.log ?? (() => {})
  const platform = context.platform ?? process.platform
  const arch = context.arch ?? process.arch
  const root = context.root ?? REPO_ROOT
  const target = `${platform}-${arch}`
  if (options.plugin !== 'local') {
    log(`  --plugin ${options.plugin}: the candidate installs a published package, so this checkout's build is not what runs; the build check was skipped`)
    return { problems: [], warnings: [], status: 'skipped' }
  }
  if (options.noBuildCheck) {
    log('  --no-build-check: skipped. A missing worker or proxy then shows up only once the candidate side dies')
    return { problems: [], warnings: [], status: 'skipped' }
  }
  const { problems, warnings } = inspectLocalBuild({ root, platform, arch })
  for (const problem of problems) log(`  ✗ ${problem.what} — ${problem.fix}`)
  if (options.dryRun) {
    log(`  [dry-run] would run the canonical gate: node bin/native-runtime.mjs check --platform ${target}`)
    return {
      problems: [],
      warnings: [...warnings, ...problems.map((problem) => `[dry-run] a real run would refuse: ${problem.what} — ${problem.fix}`)],
      status: 'planned',
    }
  }
  if (problems.length > 0) return { problems, warnings, status: 'problems' }
  log(`  runtime/${target} is in place: the worker and the provenance receipt are both there`)
  const gate = context.runGate ?? defaultGate(root, context.env ?? process.env)
  const started = Date.now()
  const result = gate(target)
  const took = Math.max(1, Date.now() - started)
  log(`  ↳ node bin/native-runtime.mjs check --platform ${target} → exit=${result.status ?? `could not start (${result.errorCode ?? '?'})`} in ${took < 1000 ? `${took}ms` : `${(took / 1000).toFixed(1)}s`}`)
  if (result.status === 0) return { problems, warnings, status: 'ok' }
  const detail = (result.stderr || result.stdout).trim().split('\n').filter(Boolean).slice(-2).join(' / ')
  return {
    problems: [{ what: `the canonical native runtime self-check failed: ${detail || `exit=${result.status}`}`, fix: 'npm run build:ptc' }],
    warnings,
    status: 'problems',
  }
}

/**
 * Run the three self-checks and report what they found. Nothing is written.
 * @param {{baseProfile: string, candProfile: string, permissionMode: string, plugin: string, noBuildCheck?: boolean, dryRun?: boolean, force?: boolean}} options
 *   - the parsed options.
 * @param {object} [context] - the run context: home, env, platform, arch, root, log, runGate,
 *   isDirectory. `home` is required for the permission check to see the profiles; without it
 *   the check sees "nothing pinned" and says so, rather than reading a real `~/.dsh`.
 * @returns {{ok: boolean, problems: string[], warnings: string[], outcomes: {permissions: string, modulePath: string, build: string}}}
 *   the verdict.
 */
export function preflight(options, context = {}) {
  const log = context.log ?? (() => {})
  const env = context.env ?? process.env
  const platform = context.platform ?? process.platform
  const arch = context.arch ?? process.arch
  const home = context.home ?? null
  const problems = []
  const warnings = []
  const outcomes = {}

  log('\n— preflight: permission mode —')
  const layerAt = (profile) => {
    if (!home) return null
    try { return layerPair(fs.readFileSync(path.join(home, 'profiles', profile, 'cordis.patch.yml'), 'utf8')) } catch { return null }
  }
  const base = layerAt(options.baseProfile)
  const cand = layerAt(options.candProfile)
  log(`  base: ${pairText(base)}; cand: ${pairText(cand)}`)
  const permissions = inspectPermissions({ requested: options.permissionMode, base, cand, force: options.force })
  outcomes.permissions = permissions.ok ? 'ok' : 'refused'
  problems.push(...permissions.problems)
  warnings.push(...permissions.warnings)
  if (options.permissionMode === 'none') log('  --permission-mode none: nothing is pinned; the pairs above are what each side runs')
  else if (permissions.ok) log(`  both sides will pin ${pairText(permissions.expected)}`)

  log('\n— preflight: PSModulePath —')
  const modulePath = inspectModulePath({ modulePath: env.PSModulePath, windows: env.SystemRoot, isDirectory: context.isDirectory })
  outcomes.modulePath = modulePath ? 'poisoned' : 'clean'
  if (modulePath) {
    log(`  ✗ ${modulePath.entry} is ahead of the in-box 5.1 module directory`)
    log(`  search order: ${describeModulePath(env.PSModulePath, modulePath.entry)}`)
    warnings.push(modulePath.warning)
  } else {
    log('  clean: no Core module root ahead of the in-box Windows PowerShell 5.1 directory')
  }

  log('\n— preflight: local build —')
  const build = checkLocalBuild(options, { ...context, log, platform, arch })
  outcomes.build = build.status
  // The build check answers in {what, fix} pairs so one message can carry both; the
  // preflight's own contract is printable lines.
  problems.push(...build.problems.map((problem) => `${problem.what} — ${problem.fix}`))
  warnings.push(...build.warnings)

  return { ok: problems.length === 0, problems, warnings, outcomes }
}

/**
 * The closing hint: the ONE command that runs the sweep.
 *
 * `profile.mjs`'s `nextStepLines` already names the entry point and derives the renamed
 * pair's flags, so this takes its first line instead of writing a second, drifting copy —
 * and takes only one, because the three-command sequence is `ab`'s own business.
 * @param {{baseProfile: string, candProfile: string}} profiles - the prepared pair.
 * @returns {string[]} a single line, ready to print.
 */
export function closingLines(profiles) {
  return [nextStepLines(profiles)[0]]
}
