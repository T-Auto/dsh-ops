#!/usr/bin/env node
/**
 * One-shot preparation of the two benchmark profiles, idempotent.
 *
 * It does, in order: copy `bench/llm.patch.example.yml` to `bench/llm.patch.yml` when that
 * filled-in overlay does not exist yet (copy-only — an existing overlay is the operator's
 * and is never rewritten), check the local build the candidate will execute, create the
 * baseline and candidate profiles from the shipped `headless` template when they do not
 * exist yet, pin the baseline's PowerShell executable to Windows PowerShell 5.1, install
 * the plugin under test into the candidate profile — **this checkout by default**, not the
 * published package — then read the composed config tree back and prove the pin landed.
 *
 * Why this is a script instead of a handful of README steps:
 *
 * - **Profile creation is not idempotent.** `--from-default-profile` fails when the
 *   profile already exists, so a README line can only ever say "skip it if it errors".
 * - **The baseline's shell engine is a measured condition nobody checks.** The host
 *   resolves the PowerShell executable as explicit `pwshPath` → PowerShell 7 well-known
 *   location → **a PATH scan** → Windows PowerShell 5.1 last. Windows puts a Store `pwsh`
 *   app-execution alias on the user PATH, so without a pin *both* sides run PowerShell 7
 *   and the "stock Windows" comparison silently measures something else. `meta.json` does
 *   not record the engine and `compare.mjs`'s fairness anchor does not cover it, so this
 *   script pins it and then verifies it out of `--dump-config`.
 * - **The pin belongs to one side only.** It goes into the baseline profile's own patch
 *   layer, never into `bench/llm.patch.yml`: that overlay is shared by both sides, and on
 *   the candidate the plugin re-injects `pwshPath` at runtime — a shared overlay would
 *   leave the archived `dump-config.txt` claiming 5.1 while 7 actually executed.
 * - **The permission mode is a measured condition too.** In `workspace-write` on Windows,
 *   the candidate's `ops_replace` failed at its publish step (`ACCESS_DENIED`) while every
 *   read and in-place write worked; the same call succeeds under `danger-full-access`, so
 *   a default-mode sweep would measure the fallback path instead of the tool. Both profiles
 *   are therefore pinned to `danger-full-access` in their **own** patch layer — the same
 *   mode on both sides is what keeps the comparison fair — and the archived
 *   `dump-config.txt` proves it. `--permission-mode` changes the pin; `none` leaves the
 *   profiles alone.
 * - **The candidate has to measure the code you are editing.** The default spec is this
 *   checkout (a `pnpm file:` install of the repo root, i.e. the local build), because a
 *   sweep exists to comparison-test the working tree against the stock baseline; the
 *   published `dsh-ops@<version>` would silently measure the last release instead. A
 *   different version already sitting in the candidate is reported as a failure and named
 *   with the fix (`--reinstall`), never skipped: "already installed" is not the same as
 *   "installed what you meant". `--plugin dsh-ops@<version>` / `--plugin none` opt out.
 * - **The overlay is a copy-once, never a rewrite.** `bench/llm.patch.yml` holds the bench
 *   server, model and key variable name, is gitignored for exactly that reason, and a
 *   benchmark script that "re-synced" it from the template would quietly point a sweep at
 *   the template's placeholders. So the copy only ever fills an absence; an existing file
 *   is reported and left untouched, `--dry-run` included.
 * - **The local build is a measured condition, so it is checked before it is linked in.**
 *   The candidate executes this checkout, and `runtime/<platform>-<arch>` — the Rust worker,
 *   the Windows Bash IPC proxies — is gitignored build output. A missing worker, or a proxy
 *   whose receipt no longer matches `native/bash-ipc`, breaks the candidate only: the
 *   baseline keeps serving, and the sweep reads as a plugin regression. The shell payloads
 *   (`@dsh-ops/<kind>-win32-x64`) are installed dependencies rather than build output, so
 *   their absence is a warning — one that matters, because the candidate would otherwise
 *   fall back to the machine's shells while the baseline keeps its own.
 *
 * It never touches `$DSH_HOME/cordis.patch.yml` (the home layer, which composes into every
 * profile) and never edits a profile's `cordis.yml`. Patch-layer edits are line-local and
 * comment-preserving; anything the editor cannot merge safely is reported with the exact
 * block to paste by hand instead of being rewritten.
 *
 * @module dsh-ops/bench/setup
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { pipedSpawnBlocker, placeholderLines, resolveDshEntry } from './run.mjs'
import { poisonedModulePath } from './lib/env.mjs'
import { PLATFORMS, workerName } from '../lib/ptc/runtime.js'
import { bundledShell } from '../lib/shells.js'

/** The `PSModulePath` verdict lives in `lib/env.mjs` now, because preflight needs it too;
 * re-exported here so the documented `bench/setup` surface keeps answering. */
export { poisonedModulePath, describeModulePath } from './lib/env.mjs'

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(BENCH_DIR, '..')
/** The patch entry the host's PowerShell executor reads: `dsh-pwsh-sandbox` inherits
 * `dsh-pwsh-local`'s config schema, whose only executable key is `pwshPath`. */
const SHELL_ENTRY_ID = 'pwsh-sandbox'
const SHELL_CONFIG_KEY = 'pwshPath'
/** The patch entry that carries the sandbox mode, and the entry whose approval preset
 * follows from it (`dsh-base` derives `never` only for `danger-full-access`). */
const PERMISSION_ENTRY_ID = 'sandbox-policy'
const PERMISSION_CONFIG_KEY = 'mode'
const APPROVAL_ENTRY_ID = 'approval'
const APPROVAL_CONFIG_KEY = 'policy'
/** The modes a bench profile may be pinned to; `none` leaves the profiles alone. */
export const PERMISSION_MODES = ['danger-full-access', 'workspace-write', 'read-only', 'none']
/** Shipped template names, kept in step with `SHIPPED_PROFILES` in `run.mjs`. */
const SHIPPED_PROFILES = ['headless', 'web', 'tui', 'acp', 'sdk', 'sdk-minimal', 'dsh-tui']
/** The overlay `run.mjs` injects into every dsh call, and the committed template it is
 * filled in from. The filled-in file is gitignored: it names the operator's bench server. */
const LLM_OVERLAY = path.join(BENCH_DIR, 'llm.patch.yml')
const LLM_OVERLAY_EXAMPLE = path.join(BENCH_DIR, 'llm.patch.example.yml')

const USAGE = `usage: node bench/setup.mjs [options]

  --base-profile <name>   stock baseline profile (default bench-base)
  --cand-profile <name>   profile under test (default bench-ops)
  --template <name>       shipped profile the two are created from (default headless)
  --pin-shell <path>      the PowerShell executable the baseline must use
                          (default %SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe)
  --no-pin                leave the baseline's shell engine alone; it then resolves to
                          whatever PATH hands back — a PowerShell 7 (README §2)
  --permission-mode <mode>  the sandbox mode both bench profiles are pinned to in their
                          own patch layer: danger-full-access (default), workspace-write,
                          read-only — or "none" to leave the profiles alone (README §2)
  --no-permission-mode    alias for --permission-mode none
  --plugin <spec>         what to install into the candidate: "local" (default) installs
                          this checkout, i.e. the local build — pnpm links the repo root
                          into the profile, so edits are what the next run executes; an npm
                          spec (dsh-ops@<version>, a tarball, a dist tag) installs that
                          instead; "none" installs nothing
  --no-plugin             alias for --plugin none
  --reinstall             remove the plugin from the candidate before installing
  --no-build-check        skip the local-build check: the candidate runs this checkout, so a
                          missing or stale runtime/<platform>-<arch> worker, a Bash IPC
                          proxy built from changed sources, or a missing shell payload is
                          otherwise reported — the build problems as failures
  --dsh-home <dir>        isolate DSH_HOME (profiles + sessions) for the benchmark
  --dsh <path>            dsh's JS entry (lib/bin.js) or an executable; default: from PATH
  --force                 overwrite a pwshPath or permission mode this script did not write
  --dry-run               plan only: print every write and command, change nothing`

/**
 * Everything this script can be told.
 * @typedef {object} Options
 * @property {string} baseProfile - the stock baseline profile name.
 * @property {string} candProfile - the candidate profile name.
 * @property {string} template - the shipped profile both are created from.
 * @property {string|null} pinShell - the executable to pin, null with --no-pin.
 * @property {string} permissionMode - the mode both profiles are pinned to, "none" for none.
 * @property {string} plugin - "local" (this checkout, the default), an npm spec, or "none".
 * @property {boolean} reinstall - remove the plugin before installing.
 * @property {boolean} noBuildCheck - skip the local-build check (--no-build-check).
 * @property {string|null} dshHome - --dsh-home.
 * @property {string|null} dsh - --dsh.
 * @property {boolean} force - overwrite a foreign pwshPath.
 * @property {boolean} dryRun - plan only.
 * @property {boolean} help - print usage.
 */

/**
 * Parse the command line. An unknown flag is an error: a typo must not quietly prepare a
 * baseline with the wrong engine.
 * @param {string[]} argv - arguments after the script name.
 * @returns {Options} the options.
 */
export function parseArgs(argv) {
  const options = {
    baseProfile: 'bench-base', candProfile: 'bench-ops', template: 'headless',
    // There is no Windows PowerShell to pin off Windows, and `dsh-pwsh-sandbox` is
    // Windows-gated in the composition anyway, so the default is "no pin" there.
    pinShell: process.platform === 'win32' ? defaultShellPath() : null,
    permissionMode: 'danger-full-access',
    // The candidate measures the working tree: the default install is this checkout, so a
    // sweep prepares itself from the code under edit without a publish or a version bump.
    plugin: 'local', reinstall: false, noBuildCheck: false,
    dshHome: null, dsh: null, force: false, dryRun: false, help: false,
  }
  const values = {
    '--base-profile': 'baseProfile', '--cand-profile': 'candProfile', '--template': 'template',
    '--pin-shell': 'pinShell', '--plugin': 'plugin', '--dsh-home': 'dshHome', '--dsh': 'dsh',
    '--permission-mode': 'permissionMode',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument "${arg}"`)
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? null : arg.slice(eq + 1)
    if (name === '--help') { options.help = true; continue }
    if (name === '--dry-run') { options.dryRun = true; continue }
    if (name === '--force') { options.force = true; continue }
    if (name === '--reinstall') { options.reinstall = true; continue }
    if (name === '--no-pin') { options.pinShell = null; continue }
    if (name === '--no-build-check') { options.noBuildCheck = true; continue }
    if (name === '--no-permission-mode') { options.permissionMode = 'none'; continue }
    if (name === '--no-plugin') { options.plugin = 'none'; continue }
    const target = values[name]
    if (!target) throw new Error(`unknown option "${name}"`)
    const value = inline ?? argv[++i]
    if (value === undefined) throw new Error(`${name} needs a value`)
    options[target] = value
  }
  options.plugin ??= 'local'
  if (options.help) return options
  for (const [flag, value] of [['--base-profile', options.baseProfile], ['--cand-profile', options.candProfile]]) {
    if (!value) throw new Error(`${flag} needs a name`)
    if (SHIPPED_PROFILES.includes(value)) {
      throw new Error(`${flag} "${value}" is a shipped template name; bench profiles are created from it (PLAN §2.3)`)
    }
  }
  if (options.baseProfile === options.candProfile) throw new Error('--base-profile and --cand-profile must differ')
  if (options.pinShell && process.platform === 'win32' && !path.isAbsolute(options.pinShell)) {
    throw new Error(`--pin-shell must be an absolute path, got "${options.pinShell}"`)
  }
  if (!PERMISSION_MODES.includes(options.permissionMode)) {
    throw new Error(`--permission-mode must be one of ${PERMISSION_MODES.join(', ')}, got "${options.permissionMode}"`)
  }
  return options
}

/** The documented stock shell on this machine's Windows install.
 * @returns {string} an absolute path to Windows PowerShell. */
function defaultShellPath() {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** The version of this checkout, which is also the default npm spec to install.
 * @returns {string} the version, or `latest` when package.json cannot be read. */
function repoVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version ?? 'latest' } catch { return 'latest' }
}

/** The home dsh will use. Mirrors `run.mjs`, so the profiles prepared here are the
 * profiles the runner reads.
 * @param {Options} options - the options.
 * @returns {string} the absolute home. */
export function dshHomeFor(options) {
  if (options.dshHome) return path.resolve(options.dshHome)
  return path.resolve(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'))
}

/**
 * One patch entry this script owns: an `id` and the config keys it writes under it.
 * @typedef {object} PatchEntry
 * @property {string} id - the loader entry id the patch targets.
 * @property {Record<string, string>} config - the keys and values to pin.
 * @property {(current: string, wanted: string) => boolean} [same] - equality against a
 *   value already in the file; defaults to an exact string comparison.
 */

/**
 * Decide how to merge one patch entry into a profile patch layer, without a YAML library
 * and without rewriting a single character the script does not own.
 * @param {string} text - the current file content.
 * @param {PatchEntry} entry - the entry to pin.
 * @param {{force?: boolean}} [flags] - `force` allows overwriting a value this script did
 *   not write.
 * @returns {{action: 'write'|'noop'|'conflict'|'manual', text: string, note: string}}
 *   the plan: `write` carries the new file text, every other action leaves `text` as it
 *   was read.
 */
export function planEntryPatch(text, entry, { force = false } = {}) {
  const block = [`- id: ${entry.id}`, '  config:', ...Object.entries(entry.config).map(([key, value]) => `    ${key}: ${value}`)]
  const lines = text.split(/\r?\n/)
  const content = lines.filter(line => line.trim() !== '' && !/^\s*#/.test(line))
  const same = entry.same ?? ((current, wanted) => current === wanted)

  // A layer of comments only, or the template's `[]` placeholder: both are "nothing yet".
  if (content.length === 0) return { action: 'write', text: joinLines([...trimTrailingBlanks(lines), ...block]), note: '这一层 patch 原本只有注释' }
  if (content.length === 1 && content[0].trim() === '[]') {
    return { action: 'write', text: joinLines(replace(lines, lines.findIndex(line => line.trim() === '[]'), 1, block)), note: '替换了模板的 [] 占位' }
  }

  // Anything that is not a plain top-level list: refuse instead of guessing.
  if (!content.every(line => /^-\s/.test(line) || /^[ \t]+\S/.test(line))) {
    return { action: 'manual', text, note: '这一层不是普通的顶层列表，没敢猜它的结构' }
  }

  const found = collectEntries(lines).find(item => item.id === entry.id)
  if (!found) return { action: 'write', text: joinLines([...trimTrailingBlanks(lines), ...block]), note: `追加了一个 ${entry.id} 条目` }

  const own = found.lines
  // An inline config is refused: one key is easy to add, but guessing where a flow mapping
  // ends is how a comment-preserving edit stops being one.
  if (own.some(line => /^[ \t]+config:\s*\S/.test(line))) {
    return { action: 'manual', text, note: `${entry.id} 的 config 是内联写法，手写一行比脚本改写安全` }
  }

  const configAt = own.findIndex(line => /^[ \t]+config:[ \t]*$/.test(line))
  const ops = []
  const missing = []
  const changed = []
  for (const [key, value] of Object.entries(entry.config)) {
    const keyAt = own.findIndex(line => new RegExp(`^[ \\t]+${escapeRegExp(key)}:`).test(line))
    if (keyAt === -1) { missing.push([key, value]); continue }
    const current = own[keyAt].replace(new RegExp(`^\\s*${escapeRegExp(key)}:`), '').trim()
    if (same(current, value)) continue
    if (!force) return { action: 'conflict', text, note: `已有一条 ${key}: ${current}，不是本脚本写的，不加 --force 不覆盖` }
    const indent = /^[ \t]*/.exec(own[keyAt])[0]
    ops.push({ at: found.start + keyAt, count: 1, lines: [`${indent}${key}: ${value}`] })
    changed.push(`${key} → ${value}`)
  }
  if (missing.length > 0) {
    const pairs = missing.map(([key, value]) => `${key}: ${value}`)
    if (configAt !== -1) {
      const indent = /^[ \t]*/.exec(own[configAt])[0]
      ops.push({ at: found.start + configAt + 1, count: 0, lines: pairs.map(line => `${indent}  ${line}`) })
      changed.push(`加了 ${missing.map(([key]) => key).join('、')}`)
    } else {
      const last = found.start + own.reduce((keep, line, offset) => (line.trim() === '' ? keep : offset), -1)
      ops.push({ at: last + 1, count: 0, lines: ['  config:', ...pairs.map(line => `    ${line}`)] })
      changed.push(`补了 config 块（${missing.map(([key]) => key).join('、')}）`)
    }
  }
  if (ops.length === 0) {
    return { action: 'noop', text, note: `已经钉在 ${Object.entries(entry.config).map(([key, value]) => `${key} = ${value}`).join('、')}` }
  }
  // Apply from the bottom up, so an earlier edit can never shift a later index.
  let next = lines
  for (const op of [...ops].sort((left, right) => right.at - left.at)) next = replace(next, op.at, op.count, op.lines)
  return { action: 'write', text: joinLines(next), note: `把 ${entry.id} 的 ${changed.join('，')}` }
}

/**
 * Pin the baseline's PowerShell executable: {@link planEntryPatch} with the value equality
 * a Windows path needs (case- and separator-insensitive, tolerant of quotes).
 * @param {string} text - the current file content.
 * @param {string} value - the executable to pin.
 * @param {{force?: boolean}} [flags] - `force` allows overwriting a foreign value.
 * @returns {{action: 'write'|'noop'|'conflict'|'manual', text: string, note: string}} the plan.
 */
export function planProfilePatch(text, value, flags = {}) {
  return planEntryPatch(text, { id: SHELL_ENTRY_ID, config: { [SHELL_CONFIG_KEY]: value }, same: samePath }, flags)
}

/**
 * Apply several entries to one patch layer in order, stopping at the first refusal so a
 * partial edit never lands.
 * @param {string} text - the current file content.
 * @param {PatchEntry[]} entries - the entries to pin.
 * @param {{force?: boolean}} [flags] - `force` allows overwriting foreign values.
 * @returns {{action: 'write'|'noop'|'conflict'|'manual', text: string, note: string}} the plan.
 */
export function planPatchEntries(text, entries, flags = {}) {
  let current = text
  let changed = false
  const notes = []
  for (const entry of entries) {
    const plan = planEntryPatch(current, entry, flags)
    if (plan.action === 'conflict' || plan.action === 'manual') return plan
    if (plan.action === 'write') { current = plan.text; changed = true }
    notes.push(plan.note)
  }
  return { action: changed ? 'write' : 'noop', text: changed ? current : text, note: notes.join('；') }
}

/**
 * The approval preset that goes with a sandbox mode, exactly as `dsh-base` derives it:
 * `never` for full access, `ask` for everything else.
 * @param {string} mode - the sandbox mode.
 * @returns {'never'|'ask'} the approval policy the composition should carry.
 */
export function approvalPolicyFor(mode) {
  return mode === 'danger-full-access' ? 'never' : 'ask'
}

/**
 * The two patch entries that pin one permission mode into a profile.
 * @param {string} mode - one of PERMISSION_MODES except "none".
 * @returns {PatchEntry[]} the entries to pin.
 */
export function permissionEntries(mode) {
  return [
    { id: PERMISSION_ENTRY_ID, config: { [PERMISSION_CONFIG_KEY]: mode } },
    { id: APPROVAL_ENTRY_ID, config: { [APPROVAL_CONFIG_KEY]: approvalPolicyFor(mode) } },
  ]
}

/**
 * Read one key's value out of one entry of a composed `--dump-config` tree.
 * @param {string} text - the dumped tree.
 * @param {string} id - the loader entry id.
 * @param {string} key - the config key to read.
 * @returns {string|null} the value, or null when the entry or the key is absent.
 */
export function entryConfigValue(text, id, key) {
  const lines = String(text ?? '').split(/\r?\n/)
  const start = lines.findIndex(line => new RegExp(`^- id:\\s*${escapeRegExp(id)}\\s*$`).test(line))
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => /^- /.test(line))
  for (const line of (end === -1 ? rest : rest.slice(0, end))) {
    const match = new RegExp(`^[ \\t]+${escapeRegExp(key)}:[ \\t]*(.+?)[ \\t]*$`).exec(line)
    if (match) return match[1]
  }
  return null
}

/** Split a top-level list into entries, each with its line range and the lines it owns.
 * @param {string[]} lines - the file lines.
 * @returns {{id: string|null, start: number, end: number, lines: string[]}[]} one per entry. */
function collectEntries(lines) {
  const starts = lines.map((line, index) => (/^- /.test(line) ? index : -1)).filter(index => index !== -1)
  return starts.map((start, order) => {
    const end = order + 1 < starts.length ? starts[order + 1] : lines.length
    const own = lines.slice(start, end)
    const id = own.map(line => /^\s*-?\s*id:\s*(.+)$/.exec(line)).find(match => match)?.[1]?.trim() ?? null
    return { id, start, end, lines: own }
  })
}

/** Replace `count` lines at `at` (or insert when count is 0) with `add`.
 * @param {string[]} lines - the file lines.
 * @param {number} at - the index.
 * @param {number} count - how many lines to drop.
 * @param {string[]} add - the lines to put in their place.
 * @returns {string[]} a new array; the input is never mutated. */
function replace(lines, at, count, add) {
  return [...lines.slice(0, at), ...add, ...lines.slice(at + count)]
}

/** Drop trailing blank lines so an appended entry sits against the list.
 * @param {string[]} lines - the file lines.
 * @returns {string[]} the lines without trailing blanks. */
function trimTrailingBlanks(lines) {
  const out = [...lines]
  while (out.length && out[out.length - 1].trim() === '') out.pop()
  return out
}

/** Join lines into a file text with exactly one trailing newline.
 * @param {string[]} lines - the file lines.
 * @returns {string} the text. */
function joinLines(lines) { return `${lines.join('\n')}\n` }

/** Escape a literal string so it can be embedded in a regular expression.
 * @param {string} text - the literal.
 * @returns {string} the escaped text. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Compare two Windows paths, ignoring case and separators.
 * @param {string} left - one path, possibly quoted.
 * @param {string} right - the other path.
 * @returns {boolean} whether they name the same executable. */
function samePath(left, right) {
  const clean = value => value.replace(/^['"]|['"]$/g, '').replace(/[\\/]/g, '\\').toLowerCase()
  return clean(left) === clean(right)
}

/** Run a command and capture it, without a shell. `dsh`'s Windows PATH entry is a `.cmd`
 * wrapper Node cannot spawn with captured pipes anyway, so callers pass `lib/bin.js`.
 * @param {string} command - the executable.
 * @param {string[]} args - its argv.
 * @param {Record<string, string|undefined>} env - its environment.
 * @returns {{status: number|null, stdout: string, stderr: string, errorCode: string|null}} the outcome. */
function runCapture(command, args, env) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 300_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', errorCode: result.error?.code ?? null }
}

/** What to spawn for a resolved entry.
 * @param {{file: string, kind: 'js'|'exe'}} entry - the resolved launcher.
 * @returns {{command: string, prefix: string[]}} the command and its argv prefix. */
function launcher(entry) {
  return entry.kind === 'js' ? { command: process.execPath, prefix: [entry.file] } : { command: entry.file, prefix: [] }
}

/** The plugin version installed in a profile, read from its dependency tree.
 * @param {string} home - the DSH_HOME in play.
 * @param {string} profile - the profile name.
 * @returns {string|null} the version, or null when the plugin is absent. */
export function installedPlugin(home, profile) {
  try {
    const manifest = path.join(home, 'profiles', profile, 'node_modules', 'dsh-ops', 'package.json')
    return JSON.parse(fs.readFileSync(manifest, 'utf8')).version ?? null
  } catch { return null }
}

/** The newest Rust input under `native/` — `<native>/src/**` plus the crate manifests —
 * skipping `native/target`, which is build output rather than input.
 * @param {string} nativeDir - the crate root.
 * @returns {{file: string, mtimeMs: number}|null} the newest input, or null when there is none. */
function newestRustInput(nativeDir) {
  let newest = null
  const visit = file => {
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
 * they came from — so "rebuilt from source that has since changed" is detectable instead
 * of merely suspected.
 * @param {string} root - the checkout root.
 * @returns {{what: string, fix: string}[]} the problems; empty when present and current. */
function bashIpcProblems(root) {
  const fix = 'npm run build:bash-ipc（Windows x64 + VS C++ 工具链）'
  const dir = path.join(root, 'runtime', 'win32-x64', 'bash-ipc')
  const receiptFile = path.join(dir, 'provenance.json')
  if (!fs.existsSync(receiptFile)) {
    return [{ what: `本地 build 缺 Bash IPC 代理（${path.relative(root, receiptFile)} 不在）`, fix }]
  }
  let receipt
  try { receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')) } catch {
    return [{ what: `Bash IPC 回执读不出来（${path.relative(root, receiptFile)}）`, fix }]
  }
  const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  const problems = []
  for (const name of ['opsipc.dll', 'opsnt.dll']) {
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) { problems.push({ what: `Bash IPC 代理缺 ${name}`, fix }); continue }
    if (receipt.files?.[name] !== sha256(file)) {
      problems.push({ what: `Bash IPC 代理 ${name} 和回执里的哈希对不上（被换过，或者压根没重建）`, fix })
    }
  }
  for (const name of ['security.h', 'opsipc.cpp', 'opsnt.cpp']) {
    const source = path.join(root, 'native', 'bash-ipc', name)
    if (!fs.existsSync(source) || receipt.sources?.[name] !== sha256(source)) {
      problems.push({ what: `Bash IPC 源码 ${name} 变了，代理还是旧的`, fix })
    }
  }
  return problems
}

/**
 * The plugin's own shells are payload packages rather than a local build, but the candidate
 * measures *them*: a missing payload silently moves the candidate onto the machine's
 * shells while the baseline keeps its own, which is a different experiment. Asked through
 * the plugin's own resolver, so setup cannot disagree with what activation will find.
 * @param {string} root - the checkout (the plugin package root, via the pnpm link).
 * @param {string} arch - the host architecture.
 * @returns {string[]} one line per unusable shell; empty when both are the plugin's own. */
function shellPayloadWarnings(root, arch) {
  const warnings = []
  for (const kind of ['bash', 'pwsh']) {
    const bundled = bundledShell({ kind, bundleRoot: root, platform: 'win32', arch })
    if (!bundled.file) {
      warnings.push(`插件自带的 ${kind} 不可用（${bundled.cause ?? '未知原因'}）：${bundled.detail ?? ''} —— 候选侧会退到系统 shell，和基线就不是同一个口径了；npm install 装回 optionalDependencies 再看`)
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
 * artifact dies, and the sweep reads as a plugin regression. Structural facts only
 * (presence, receipts, hashes); the binary itself — version tag, hash and PE/ELF/Mach-O
 * architecture — is the canonical gate's question, which setup runs separately rather than
 * re-implementing.
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
    problems.push({ what: `本机目标 ${target} 不在插件的 native 支持列表（${PLATFORMS.join('、')}）里：候选侧没有 worker，PTC/run_code 起不来`, fix: '换一台受支持的目标机器，或按 docs/linux-build.md 自建' })
    return { problems, warnings }
  }
  const directory = path.join(root, 'runtime', target)
  const worker = path.join(directory, workerName(target.split('-')[0]))
  const receipt = path.join(directory, 'provenance.json')
  if (!fs.existsSync(worker) || !fs.existsSync(receipt)) {
    problems.push({ what: `本地 build 缺 ${target} 的 native worker（${path.relative(root, worker)} 或它旁边的 provenance.json 不在）`, fix: 'npm run build:ptc（编译并 stage 本机目标）' })
  } else {
    const rust = newestRustInput(path.join(root, 'native'))
    if (rust && rust.mtimeMs > fs.statSync(worker).mtimeMs) {
      warnings.push(`本地 worker 比 ${path.relative(root, rust.file)} 旧：这一轮量的可能不是当前 native/src 的构建（重建：npm run build:ptc）`)
    }
  }
  // The proxies exist for win32-x64 only, and only when the sources shipped with them.
  if (target === 'win32-x64' && fs.existsSync(path.join(root, 'native', 'bash-ipc'))) problems.push(...bashIpcProblems(root))
  if (platform === 'win32') warnings.push(...shellPayloadWarnings(root, arch))
  return { problems, warnings }
}

/**
 * Check the local build the candidate will execute, and let the canonical gate judge the
 * binary itself (`bin/native-runtime.mjs check --platform <target>`: version tag, hash, and
 * the PE/ELF/Mach-O architecture, which this file deliberately does not re-implement).
 *
 * A `--plugin` that names a package makes the checkout's build irrelevant, and
 * `--no-build-check` is the operator's own call; both are reported rather than silent.
 * @param {Options} options - the options.
 * @param {object} context - the run context.
 * @returns {{problems: {what: string, fix: string}[], warnings: string[]}} the verdict. */
function checkLocalBuild(options, context) {
  if (options.plugin !== 'local') {
    context.log(`  --plugin ${options.plugin}：候选装的是现成的包，本地 build 不参与这一轮，没查`)
    return { problems: [], warnings: [] }
  }
  if (options.noBuildCheck) {
    context.log('  --no-build-check：没查。缺 worker / 代理时候选侧会在跑起来之后才现原形')
    return { problems: [], warnings: [] }
  }
  const target = `${process.platform}-${process.arch}`
  const { problems, warnings } = inspectLocalBuild({ root: REPO_ROOT })
  for (const problem of problems) context.log(`  ✗ ${problem.what} —— ${problem.fix}`)
  if (problems.length > 0) return { problems, warnings }
  context.log(`  runtime/${target} 在，worker、Bash IPC 回执和哈希都对得上`)
  if (context.dryRun) {
    context.log(`  [dry-run] 计划执行 node bin/native-runtime.mjs check --platform ${target}`)
    return { problems, warnings }
  }
  const script = path.join(REPO_ROOT, 'bin', 'native-runtime.mjs')
  const started = Date.now()
  const result = runCapture(process.execPath, [script, 'check', '--platform', target], process.env)
  const took = Math.max(1, Date.now() - started)
  context.log(`  ↳ node bin/native-runtime.mjs check --platform ${target} → exit=${result.status ?? `起不来（${result.errorCode ?? '?'}）`}，用时 ${took < 1000 ? `${took}ms` : `${(took / 1000).toFixed(1)}s`}`)
  if (result.status === 0) return { problems, warnings }
  const detail = (result.stderr || result.stdout).trim().split('\n').filter(Boolean).slice(-2).join(' / ')
  problems.push({ what: `native runtime 自检没通过：${detail || `exit=${result.status}`}`, fix: 'npm run build:ptc' })
  return { problems, warnings }
}

/**
 * Copy the committed overlay template into place when the filled-in overlay is absent.
 *
 * Copy-only, in one direction: `bench/llm.patch.yml` names the bench server, model and the
 * environment variable holding the key, and it is the operator's file (gitignored for that
 * reason). An existing overlay is reported and left byte-for-byte as it was — never
 * re-synced from the template, never overwritten, `--dry-run` included.
 * @param {object} paths - what to look at.
 * @param {string} paths.overlay - the overlay `run.mjs` injects into every dsh call.
 * @param {string} paths.example - the committed template to copy from.
 * @param {boolean} [paths.dryRun] - plan only: name the copy, write nothing.
 * @param {(line: string) => void} [paths.log] - where to narrate the outcome.
 * @returns {'created'|'exists'|'missing-example'} what happened. */
export function ensureLlmOverlay({ overlay, example, dryRun = false, log = () => {} }) {
  if (fs.existsSync(overlay)) { log(`  ${overlay} 已存在，没动它`); return 'exists' }
  if (!fs.existsSync(example)) {
    log(`  没有 ${example}：没有模板可复制（跑分也可以用 run.mjs --no-llm-patch，但两侧就没有统一路由了）`)
    return 'missing-example'
  }
  if (dryRun) { log(`  计划复制 ${example} → ${overlay}`); return 'created' }
  fs.copyFileSync(example, overlay)
  log(`  没有 ${overlay}，从 ${path.basename(example)} 复制了一份；填好服务器和模型再开跑（README §2）`)
  return 'created'
}

/**
 * Create a profile from the shipped template when it does not exist yet.
 * @param {string} name - the profile name.
 * @param {object} context - the run context: home, template, dryRun, log, invoke.
 * @returns {'created'|'exists'|'failed'} what happened. */
function ensureProfile(name, context) {
  const dir = path.join(context.home, 'profiles', name)
  if (fs.existsSync(dir)) { context.log(`  ${name}: 已存在，跳过创建`); return 'exists' }
  const args = [...context.prefix, name, '--from-default-profile', context.template, '--dump-config']
  if (context.dryRun) { context.log(`  ${name}: 计划执行 ${describe(args)}`); return 'created' }
  const result = context.invoke(args)
  if (result.status !== 0) {
    context.log(`  ${name}: 创建失败 exit=${result.status} — ${(result.stderr || result.stdout).trim().split('\n')[0]}`)
    return 'failed'
  }
  context.log(`  ${name}: 已从 ${context.template} 创建`)
  return 'created'
}

/**
 * Apply the pin plan to the baseline profile's patch layer.
 * @param {Options} options - the options.
 * @param {object} context - the run context.
 * @returns {'pinned'|'noop'|'conflict'|'manual'|'absent'|'skipped'} the outcome. */
function pinBaseline(options, context) {
  if (!options.pinShell) {
    context.log('  --no-pin：没动。基线会命中 PATH 上的 pwsh 别名（README §2），两侧就都是 PowerShell 7')
    return 'skipped'
  }
  const file = path.join(context.home, 'profiles', options.baseProfile, 'cordis.patch.yml')
  if (!fs.existsSync(file)) {
    // In a plan for a home that has no such profile yet, the file is created by step 1,
    // so its absence is the expected state rather than a failure.
    if (context.dryRun && !fs.existsSync(path.join(context.home, 'profiles', options.baseProfile))) {
      context.log(`  [dry-run] 计划：profile 建好之后把 ${SHELL_CONFIG_KEY} 写进 ${file}`)
      return 'pinned'
    }
    context.log(`  找不到 ${file}`)
    return 'absent'
  }
  const plan = planProfilePatch(fs.readFileSync(file, 'utf8'), options.pinShell, { force: options.force })
  if (plan.action === 'noop') { context.log(`  ${plan.note}`); return 'noop' }
  if (plan.action === 'conflict' || plan.action === 'manual') {
    context.log(`  ${plan.note}`)
    context.log(`  手工做法：编辑 ${file}，让里面 ${SHELL_ENTRY_ID} 的 ${SHELL_CONFIG_KEY} 取下值（没有就加，有别的值就改掉；文件里的 [] 占位直接换成这三行）`)
    context.log(`    - id: ${SHELL_ENTRY_ID}\n      config:\n        ${SHELL_CONFIG_KEY}: ${options.pinShell}`)
    return plan.action
  }
  if (context.dryRun) { context.log(`  计划写入 ${file} — ${plan.note}`); return 'pinned' }
  fs.writeFileSync(file, plan.text, 'utf8')
  context.log(`  ${plan.note} → ${options.pinShell}`)
  return 'pinned'
}

/**
 * Pin the permission mode into both profiles' own patch layers.
 *
 * Both sides, deliberately: the mode is a measured condition, so a sweep whose two sides
 * run in different modes measures the modes. It goes into each profile's patch layer, and
 * never into `bench/llm.patch.yml`, for the same reason the shell pin does.
 * @param {Options} options - the options.
 * @param {object} context - the run context.
 * @returns {'pinned'|'noop'|'conflict'|'manual'|'absent'|'skipped'} the worst outcome. */
function pinPermissionMode(options, context) {
  if (options.permissionMode === 'none') {
    context.log('  --permission-mode none：没动。两侧沿用 profile 原本的 mode（README §2）')
    return 'skipped'
  }
  context.log(`  两侧都钉 ${options.permissionMode} / approval ${approvalPolicyFor(options.permissionMode)}：和默认的 workspace-write 不是一个口径，别的口径跑出来的 run 目录不能直接比（README §2）`)
  const outcomes = [options.baseProfile, options.candProfile].map(profile => pinOneProfileMode(profile, options, context))
  const order = ['conflict', 'manual', 'absent', 'pinned', 'noop']
  return order.find(outcome => outcomes.includes(outcome)) ?? 'noop'
}

/**
 * Apply {@link pinPermissionMode} to one profile.
 * @param {string} profile - the profile name.
 * @param {Options} options - the options.
 * @param {object} context - the run context.
 * @returns {'pinned'|'noop'|'conflict'|'manual'|'absent'} the outcome. */
function pinOneProfileMode(profile, options, context) {
  const file = path.join(context.home, 'profiles', profile, 'cordis.patch.yml')
  if (!fs.existsSync(file)) {
    // Same dry-run allowance as the shell pin: step 1 is about to create this profile.
    if (context.dryRun && !fs.existsSync(path.join(context.home, 'profiles', profile))) {
      context.log(`  [dry-run] 计划：profile ${profile} 建好之后把 ${options.permissionMode} 写进 ${file}`)
      return 'pinned'
    }
    context.log(`  ${profile}: 找不到 ${file}`)
    return 'absent'
  }
  const plan = planPatchEntries(fs.readFileSync(file, 'utf8'), permissionEntries(options.permissionMode), { force: options.force })
  if (plan.action === 'noop') { context.log(`  ${profile}: ${plan.note}`); return 'noop' }
  if (plan.action === 'conflict' || plan.action === 'manual') {
    context.log(`  ${profile}: ${plan.note}`)
    const wanted = `${APPROVAL_ENTRY_ID}.${APPROVAL_CONFIG_KEY} 取 ${approvalPolicyFor(options.permissionMode)}`
    context.log(`  手工做法：编辑 ${file}，让 ${PERMISSION_ENTRY_ID}.${PERMISSION_CONFIG_KEY} 取 ${options.permissionMode}、${wanted}`)
    context.log(`    - id: ${PERMISSION_ENTRY_ID}\n      config:\n        ${PERMISSION_CONFIG_KEY}: ${options.permissionMode}\n    - id: ${APPROVAL_ENTRY_ID}\n      config:\n        ${APPROVAL_CONFIG_KEY}: ${approvalPolicyFor(options.permissionMode)}`)
    return plan.action
  }
  if (context.dryRun) { context.log(`  [dry-run] 计划写入 ${file} — ${plan.note}`); return 'pinned' }
  fs.writeFileSync(file, plan.text, 'utf8')
  context.log(`  ${profile}: ${plan.note}`)
  return 'pinned'
}

/**
 * Read the composed tree back on both sides and prove the mode pin landed. The mode is
 * what the tools actually run under, so the archived `dump-config.txt` has to show it.
 * @param {Options} options - the options.
 * @param {object} context - the run context.
 * @returns {boolean} whether both profiles really compose to the requested mode. */
function verifyPermissionMode(options, context) {
  if (options.permissionMode === 'none') return true
  const overlay = path.join(BENCH_DIR, 'llm.patch.yml')
  const wantedApproval = approvalPolicyFor(options.permissionMode)
  let ok = true
  for (const profile of [options.baseProfile, options.candProfile]) {
    const args = [...context.prefix, '--profile', profile]
    if (fs.existsSync(overlay)) args.push('--patch', overlay)
    args.push('--dump-config')
    const result = context.invoke(args)
    if (result.status !== 0) {
      context.log(`  "dsh --profile ${profile} --dump-config" exit=${result.status}，没能读到组合树`)
      ok = false
      continue
    }
    const text = `${result.stdout}\n${result.stderr}`
    const mode = entryConfigValue(text, PERMISSION_ENTRY_ID, PERMISSION_CONFIG_KEY)
    const approval = entryConfigValue(text, APPROVAL_ENTRY_ID, APPROVAL_CONFIG_KEY)
    if (mode === options.permissionMode && approval === wantedApproval) {
      context.log(`  ${profile}: ${PERMISSION_ENTRY_ID}.${PERMISSION_CONFIG_KEY} = ${mode}，${APPROVAL_ENTRY_ID}.${APPROVAL_CONFIG_KEY} = ${approval} ✅`)
      continue
    }
    context.log(`  ${profile}: 组合树里是 mode=${mode ?? '（没读到）'} / approval=${approval ?? '（没读到）'}，要求 ${options.permissionMode} / ${wantedApproval} ❌`)
    ok = false
  }
  return ok
}

/**
 * The version a plugin spec would land in the profile, when the spec names exactly one.
 * `local` means "whatever this checkout's package.json says"; a dist tag (`@latest`) or a
 * tarball URL pins nothing this script can compare against, so it answers null.
 * @param {string} spec - an npm spec, or "local".
 * @returns {string|null} the version, or null when the spec does not name one.
 */
export function specVersion(spec) {
  const named = spec === 'local' ? repoVersion() : /^dsh-ops@(.+)$/.exec(spec)?.[1]
  return named && /^\d/.test(named) ? named : null
}

/**
 * Install (or deliberately leave) the plugin under test in the candidate profile.
 *
 * The default spec is this checkout, so the candidate carries the working tree; a profile
 * whose copy is a different version is a failure with the fix named, not a silent skip —
 * otherwise a sweep happily measures the last release instead of the code under edit.
 * @param {Options} options - the options.
 * @param {object} context - the run context.
 * @returns {'installed'|'present'|'stale'|'skipped'|'failed'} the outcome. */
function prepareCandidate(options, context) {
  const installed = installedPlugin(context.home, options.candProfile)
  if (options.plugin === 'none') {
    context.log(installed ? `  已装 dsh-ops@${installed}，--no-plugin 没动它` : '  --no-plugin：候选 profile 里也没有 dsh-ops，候选侧还没法测')
    return installed ? 'present' : 'skipped'
  }
  const local = options.plugin === 'local'
  const spec = local ? REPO_ROOT : options.plugin
  const wanted = specVersion(options.plugin)
  const what = local ? `本地 checkout（${REPO_ROOT}）` : spec
  if (installed && !options.reinstall) {
    if (wanted && installed !== wanted) {
      if (context.dryRun) {
        context.log(`  候选侧已装 dsh-ops@${installed}，要的是 ${wanted}：真跑时会先 remove 再 add ${what}`)
        return 'installed'
      }
      context.log(`  候选侧已装 dsh-ops@${installed}，要的是 ${wanted}（${what}）——不重装这一轮测的就是那个旧版本；加 --reinstall`)
      return 'stale'
    }
    context.log(local
      ? `  已装 dsh-ops@${installed}（${what}）。pnpm 把本地目录链进 profile，代码改动下一轮就生效；改了依赖或版本再用 --reinstall 重装一遍`
      : `  已装 dsh-ops@${installed}，和 ${spec} 对得上，没动它`)
    return 'present'
  }
  const steps = installed && options.reinstall ? [['remove', 'dsh-ops'], ['add', spec]] : [['add', spec]]
  for (const [verb, target] of steps) {
    const args = [...context.prefix, 'plugin', '--profile', options.candProfile, verb, target]
    if (context.dryRun) { context.log(`  计划执行 ${describe(args)}`); continue }
    context.log(`  dsh plugin ${verb} ${target} …（透传 pnpm，可能要点时间）`)
    const result = context.invoke(args)
    if (result.status !== 0) {
      const hint = result.errorCode === 'ENOENT' ? '（命令起不来）' : ''
      context.log(`  失败 exit=${result.status} ${hint}— ${(result.stderr || result.stdout).trim().split('\n').slice(-3).join('\n  ')}`)
      context.log('  提示：pnpm 不在 PATH 上时 dsh plugin 会 exit 127（PLAN §2.3）')
      return 'failed'
    }
  }
  context.log(`  候选侧装的是 ${what}${wanted ? `，dsh-ops@${wanted}` : ''}，运行时会把 pwshPath 注入成插件自带 pwsh`)
  return 'installed'
}

/** Render a planned command line for humans, dropping the bin.js argument.
 * @param {string[]} args - the full argv including the entry file.
 * @returns {string} the printable form. */
function describe(args) {
  return `dsh ${args.filter(arg => arg !== process.execPath && !/bin\.js$/.test(arg)).join(' ')}`
}

/**
 * Read the composed tree back: the only proof that the pin actually landed, because a
 * patch whose id the loader does not know is warned about and skipped silently.
 * @param {Options} options - the options.
 * @param {object} context - the run context.
 * @returns {boolean} whether the baseline really got the requested engine. */
function verifyBaseline(options, context) {
  if (!options.pinShell) return true
  const overlay = path.join(BENCH_DIR, 'llm.patch.yml')
  const args = [...context.prefix, '--profile', options.baseProfile]
  if (fs.existsSync(overlay)) args.push('--patch', overlay)
  args.push('--dump-config')
  const result = context.invoke(args)
  if (result.status !== 0) {
    context.log(`  "dsh --profile ${options.baseProfile} --dump-config" exit=${result.status}，没能读到组合树`)
    return false
  }
  const pinned = `${result.stdout}\n${result.stderr}`.match(/pwshPath:\s*(.+)$/m)?.[1]?.trim() ?? null
  if (pinned && samePath(pinned, options.pinShell)) {
    context.log(`  基线组合树里 ${SHELL_ENTRY_ID}.config.${SHELL_CONFIG_KEY} = ${pinned} ✅（overlay 层压得住 profile 层）`)
    return true
  }
  context.log(pinned
    ? `  基线实际生效的是 ${pinned}，和要求的 ${options.pinShell} 不一致 ❌`
    : `  组合树里没有 ${SHELL_CONFIG_KEY} ❌ —— 基线会命中 PATH 上的 pwsh 别名，不是 Windows 原装 5.1`)
  return false
}

/**
 * The closing "what now" lines: one command, and nothing else.
 *
 * The wrapper runs the baseline side, the candidate side and the comparison, and derives
 * both labels from the profile names this script just prepared — so a renamed pair is
 * handed over explicitly (`npm run` needs its own `--` before script arguments, or npm
 * swallows the flags) instead of letting the run fall back to bench-base/bench-ops.
 * `bench:baseline` is the Windows entry point; elsewhere the same three commands are run
 * by hand, with the same labels.
 * @param {object} options - the prepared pair.
 * @param {string} options.baseProfile - the baseline profile.
 * @param {string} options.candProfile - the candidate profile.
 * @param {string} [options.platform] - the host platform (defaults to this process).
 * @returns {string[]} the lines, ready to print.
 */
export function nextStepLines({ baseProfile, candProfile, platform = process.platform }) {
  const renamed = baseProfile !== 'bench-base' || candProfile !== 'bench-ops'
  const flags = renamed ? ` -- --base ${baseProfile} --cand ${candProfile}` : ''
  const lines = [
    `  npm run bench:baseline${flags}  —— 整轮 A/B：base 跑一遍、ops 跑一遍、再出对比报告`,
    '  npm run bench:baseline -- --show  —— 只看这轮的工作组和三条命令，不跑',
  ]
  if (platform !== 'win32') {
    lines.push(`  （bench:baseline 是 Windows 入口；这个平台直接跑 node bench/run.mjs 两次，再 node bench/compare.mjs ${baseProfile} ${candProfile}）`)
  }
  return lines
}

/**
 * The whole preparation.
 * @param {string[]} argv - arguments after the script name.
 * @returns {Promise<number>} the process exit code: 0 prepared, 1 a step failed, 2 usage. */
export async function main(argv) {
  let options
  try { options = parseArgs(argv) } catch (error) { console.error(`${error.message}\n\n${USAGE}`); return 2 }
  if (options.help) { console.log(USAGE); return 0 }

  const blocked = pipedSpawnBlocker()
  if (blocked) {
    console.error(`这个会话读不了子进程的 stdout（${blocked}）。请在普通终端里跑：本脚本要靠管道读 dsh --dump-config。`)
    return 1
  }

  let entry
  try { entry = resolveDshEntry(options.dsh) } catch (error) { console.error(error.message); return 1 }
  const { command, prefix } = launcher(entry)
  const home = dshHomeFor(options)
  const env = { ...process.env, ...(options.dshHome ? { DSH_HOME: home } : {}) }
  const invoke = args => {
    // spawnSync cannot stream: the three minutes a cold `pnpm install` takes look like a
    // dead machine unless the script says what it is waiting on and how long it waited.
    // Timing every call is the cheapest possible heartbeat.
    const started = Date.now()
    const result = runCapture(command, args, env)
    const took = Math.max(1, Date.now() - started)
    log(`  ↳ ${describe(args)} → exit=${result.status ?? `起不来（${result.errorCode ?? '?'}）`}，用时 ${took < 1000 ? `${took}ms` : `${(took / 1000).toFixed(1)}s`}`)
    return result
  }
  const log = line => console.log(line)
  const context = { home, log, invoke, prefix, dryRun: options.dryRun, template: options.template }

  log(`dsh 入口: ${entry.kind === 'js' ? entry.file : `${entry.file} (exe)`}`)
  if (entry.notes.length) log(`  怎么找到的: ${entry.notes.join('；')}`)
  log(`DSH_HOME: ${home}`)
  log(`node ${process.version}，平台 ${process.platform}-${process.arch}${options.dryRun ? '，[--dry-run] 只看计划' : ''}`)

  const warnings = []
  const poison = poisonedModulePath(process.env.PSModulePath)
  if (poison) {
    warnings.push(`PSModulePath 里 ${poison} 排在 Windows PowerShell 自己的 Modules 之前：dsh-ops 的工作区准备脚本会死在 Get-Acl 上，候选侧每一个 pwsh / bash / run_code 调用都会在模型的命令跑起来之前失败（README §1）。换一个 cmd.exe 窗口重开这条命令。`)
  }
  if (process.platform !== 'win32' && options.pinShell) {
    warnings.push(`当前不是 Windows：--pin-shell 指的 Windows PowerShell 路径在这台机器上不存在，考虑 --no-pin。`)
  }
  const homePatch = path.join(home, 'cordis.patch.yml')
  if (fs.existsSync(homePatch) && fs.readFileSync(homePatch, 'utf8').trim() !== '') {
    warnings.push(`${homePatch} 存在且非空：home 层会组合进每一个 profile 并压过 profile 层，基线可能已经不 stock（README §4）。用 --dsh-home 隔离，或把它清空。`)
  }

  log('\n— 1) LLM overlay —')
  const overlay = ensureLlmOverlay({ overlay: LLM_OVERLAY, example: LLM_OVERLAY_EXAMPLE, dryRun: options.dryRun, log })
  if (overlay === 'missing-example') {
    warnings.push(`没有 ${LLM_OVERLAY_EXAMPLE}：bench/llm.patch.yml 建不出来，跑分只能用 run.mjs --no-llm-patch（两侧没有统一路由）。`)
  } else if (fs.existsSync(LLM_OVERLAY)) {
    // Same definition of "unfilled" as run.mjs's preflight, so setup and the sweep agree.
    const placeholders = placeholderLines(fs.readFileSync(LLM_OVERLAY, 'utf8'))
    if (placeholders.length > 0) {
      warnings.push(`bench/llm.patch.yml 里还有模板占位符：${placeholders.join(' | ')} —— run.mjs preflight 会拒跑，先把服务器和模型填上（README §2）。`)
    }
  }

  log('\n— 2) 本地 build —')
  const build = checkLocalBuild(options, context)
  warnings.push(...build.warnings)
  if (options.dryRun) {
    for (const problem of build.problems) warnings.push(`[dry-run] 本地 build 会卡住：${problem.what} —— ${problem.fix}`)
  }

  log('\n— 3) profile —')
  const base = ensureProfile(options.baseProfile, context)
  const cand = ensureProfile(options.candProfile, context)
  if (base === 'failed' || cand === 'failed') return 1

  log('\n— 4) 基线 shell 引擎 —')
  const pin = pinBaseline(options, context)

  log('\n— 5) 权限模式 —')
  const permissions = pinPermissionMode(options, context)

  log('\n— 6) 候选插件 —')
  const plugin = prepareCandidate(options, context)

  log('\n— 7) 回读组合树 —')
  let installedNow = installedPlugin(home, options.candProfile)
  let verified = true
  let permissionsVerified = true
  if (options.dryRun) {
    log('  [dry-run] 跳过回读：真跑时会用 dsh --dump-config 确认基线那行 pwshPath 和两侧的权限模式')
  } else {
    verified = verifyBaseline(options, context)
    permissionsVerified = verifyPermissionMode(options, context)
    installedNow = installedPlugin(home, options.candProfile)
    if (options.plugin !== 'none') {
      log(installedNow ? `  候选 profile 里 dsh-ops@${installedNow} ✅` : '  候选 profile 里读不到 dsh-ops ❌（node_modules/dsh-ops/package.json 不在）')
    }
  }

  for (const warning of warnings) console.warn(`\n*** ${warning}`)

  log('\n— 下一步 —')
  for (const line of nextStepLines(options)) log(line)

  // A deliberate --no-plugin leaves the candidate unprepared without being a failure; a
  // plugin that was asked for and is still missing is one, because bench-ops cannot run.
  const unresolved = [
    ...(options.dryRun ? [] : build.problems.map(problem => `${problem.what} —— ${problem.fix}`)),
    pin === 'conflict' ? 'pwshPath 已有别的值（要覆盖就 --force）' : '',
    pin === 'manual' ? '基线 patch 文件的形状需要手工处理（上面印了要贴的三行）' : '',
    pin === 'absent' ? '基线 profile 的 cordis.patch.yml 找不到' : '',
    permissions === 'conflict' ? '权限模式已有别的值（要覆盖就 --force）' : '',
    permissions === 'manual' ? '权限模式的 patch 形状需要手工处理（上面印了要贴的条目）' : '',
    permissions === 'absent' ? '两侧 profile 的 cordis.patch.yml 有一个找不到' : '',
    plugin === 'failed' ? '插件安装失败' : '',
    plugin === 'stale' ? '候选 profile 里的 dsh-ops 版本不对（加 --reinstall 重装成本次要测的那份）' : '',
    options.plugin !== 'none' && !options.dryRun && !installedNow ? '候选 profile 里没有 dsh-ops，bench-ops 无从测起' : '',
    verified ? '' : '基线 shell 引擎没验证上',
    permissionsVerified ? '' : '权限模式没验证上',
  ].filter(Boolean)
  if (options.plugin === 'none' && !installedNow) {
    console.warn('\n*** 候选 profile 里没有 dsh-ops（--no-plugin 是你自己给的）：装上之后再跑 bench-ops。')
  }
  if (unresolved.length > 0) {
    console.error(`\n准备没做完：${unresolved.join('；')}`)
    return 1
  }
  log(options.dryRun ? '\n[dry-run] 以上全是计划，没有改动任何文件。' : '\n准备完成。')
  return 0
}

/** Let other modules import this file without running it.
 * @returns {void} */
async function run() {
  process.exitCode = await main(process.argv.slice(2))
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) await run()
