/**
 * Setup A: prepare the two benchmark profiles, idempotently.
 *
 * In order: copy `bench/llm.patch.example.yml` to `bench/llm.patch.yml` when the filled-in
 * overlay is absent (copy-only — an existing overlay is the operator's and is never
 * rewritten), create both profiles from the shipped template when they are absent, pin the
 * baseline's PowerShell executable to Windows PowerShell 5.1, pin **both** sides to one
 * permission mode and the approval preset it implies, install the plugin under test into
 * the candidate profile — **this checkout by default**, not the published package — then
 * read the composed config tree back and prove both pins landed.
 *
 * Why this is a module instead of a handful of README steps:
 *
 * - **Profile creation is not idempotent.** `--from-default-profile` fails when the profile
 *   already exists, so a README line could only ever say "skip it if it errors".
 * - **The baseline's shell engine is a measured condition nobody checks.** The host
 *   resolves `pwshPath` → PowerShell 7's well-known location → a PATH scan → Windows
 *   PowerShell 5.1 last, and Windows puts a Store `pwsh` alias on the user PATH: without a
 *   pin *both* sides run PowerShell 7 and the "stock Windows" comparison silently measures
 *   something else. The pin goes into the baseline's own patch layer only, never into the
 *   shared overlay, where it would leave `dump-config.txt` claiming 5.1 while 7 executed.
 * - **The permission mode is a measured condition too.** Under `workspace-write` on Windows
 *   the candidate's `ops_replace` failed at its publish step while every read and in-place
 *   write worked, so a default-mode sweep would measure the fallback path instead of the
 *   tool; both sides are pinned in their own patch layer, and the archived
 *   `dump-config.txt` proves it.
 * - **The candidate has to measure the code you are editing.** The default spec is this
 *   checkout; a different version already installed is a failure with the fix named
 *   (`--reinstall`), never a skip: "already installed" is not "installed what you meant".
 * - **The overlay is copy-once, never a rewrite.** It names the operator's bench server and
 *   is gitignored for that reason; a script that re-synced it would quietly point a sweep at
 *   the template's placeholders.
 *
 * It never touches `$DSH_HOME/cordis.patch.yml` (the home layer, which composes into every
 * profile) and never edits a profile's `cordis.yml`. Patch-layer edits are line-local and
 * comment-preserving; a shape the editor cannot merge safely is reported with the exact
 * block to paste by hand instead of being rewritten.
 *
 * This is **half** of `setup`: the PSModulePath probe, the home-layer warning and the
 * local-build preflight live in `setup/preflight.mjs`, composed by the `setup` entry point,
 * which prints one combined problem list and owns the exit code. `prepareProfiles` therefore
 * returns its verdict instead of deciding one, and every path it writes is reachable from
 * `options`/`context` — so the tests run against a temporary home and a temporary checkout,
 * never a real `~/.dsh`.
 *
 * @module dsh-ops/bench/setup/profile
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { BENCH_DIR, REPO_ROOT } from '../lib/env.mjs'

/** The plugin under test — the only package this module ever installs, and the name every
 * install failure has to carry so "failed" never means "something, somewhere". */
export const PLUGIN_NAME = 'dsh-ops'
/** The patch entry the host's PowerShell executor reads: `dsh-pwsh-sandbox` inherits
 * `dsh-pwsh-local`'s config schema, whose only executable key is `pwshPath`. */
export const SHELL_ENTRY_ID = 'pwsh-sandbox'
export const SHELL_CONFIG_KEY = 'pwshPath'
/** The patch entry that carries the sandbox mode, and the entry whose approval preset
 * follows from it (`dsh-base` derives `never` only for `danger-full-access`). */
export const PERMISSION_ENTRY_ID = 'sandbox-policy'
export const PERMISSION_CONFIG_KEY = 'mode'
export const APPROVAL_ENTRY_ID = 'approval'
export const APPROVAL_CONFIG_KEY = 'policy'
/** The modes a bench profile may be pinned to; `none` leaves the profiles alone. */
export const PERMISSION_MODES = ['danger-full-access', 'workspace-write', 'read-only', 'none']
/** Shipped template names: a bench profile is created *from* one of these, so naming a
 * profile after one would make `--from-default-profile` read its own output. */
export const SHIPPED_PROFILES = ['headless', 'web', 'tui', 'acp', 'sdk', 'sdk-minimal', 'dsh-tui']
/** The overlay every dsh call is given, and the committed template it is filled in from.
 * The filled-in file is gitignored: it names the operator's bench server. */
export const LLM_OVERLAY = path.join(BENCH_DIR, 'llm.patch.yml')
export const LLM_OVERLAY_EXAMPLE = path.join(BENCH_DIR, 'llm.patch.example.yml')

/** The `setup` help text for the flags this half owns; setup B appends its own. */
export const USAGE = `usage: node bench/cli.mjs setup [options]

  --base-profile <name>   stock baseline profile (default bench-base)
  --cand-profile <name>   profile under test (default bench-ops)
  --template <name>       shipped profile the two are created from (default headless)
  --pin-shell <path>      the PowerShell executable the baseline must use
                          (default %SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe)
  --no-pin                leave the baseline's shell engine alone; it then resolves to
                          whatever PATH hands back — a PowerShell 7
  --permission-mode <mode>  the sandbox mode both bench profiles are pinned to in their
                          own patch layer: danger-full-access (default), workspace-write,
                          read-only — or "none" to leave the profiles alone
  --no-permission-mode    alias for --permission-mode none
  --plugin <spec>         what to install into the candidate: "local" (default) installs
                          this checkout, i.e. the local build — the profile links the repo
                          root, so edits are what the next run executes; an npm spec
                          (dsh-ops@<version>, a tarball, a dist tag) installs that instead;
                          "none" installs nothing
  --no-plugin             alias for --plugin none
  --reinstall             remove the plugin from the candidate before installing
  --dsh-home <dir>        isolate DSH_HOME (profiles + sessions) for the benchmark
  --dsh <path>            dsh's JS entry (lib/bin.js) or an executable; default: from PATH
  --force                 overwrite a pwshPath or permission mode this script did not write
  --dry-run               plan only: print every write and command, change nothing`

/**
 * The flags this half owns, as data so setup B can add its own without editing this file:
 * `value` maps a flag to the options key it sets, `boolean` maps a flag to the
 * `[key, value]` pair it assigns.
 */
export const VALUE_FLAGS = {
  '--base-profile': 'baseProfile',
  '--cand-profile': 'candProfile',
  '--template': 'template',
  '--pin-shell': 'pinShell',
  '--permission-mode': 'permissionMode',
  '--plugin': 'plugin',
  '--dsh-home': 'dshHome',
  '--dsh': 'dsh',
}
export const BOOLEAN_FLAGS = {
  '--help': ['help', true],
  '--dry-run': ['dryRun', true],
  '--force': ['force', true],
  '--reinstall': ['reinstall', true],
  '--no-pin': ['pinShell', null],
  '--no-permission-mode': ['permissionMode', 'none'],
  '--no-plugin': ['plugin', 'none'],
}

/**
 * Everything this half can be told.
 * @typedef {object} Options
 * @property {string} baseProfile - the stock baseline profile name.
 * @property {string} candProfile - the candidate profile name.
 * @property {string} template - the shipped profile both are created from.
 * @property {string|null} pinShell - the executable to pin, null with --no-pin.
 * @property {string} permissionMode - the mode both profiles are pinned to, "none" for none.
 * @property {string} plugin - "local" (this checkout, the default), an npm spec, or "none".
 * @property {boolean} reinstall - remove the plugin before installing.
 * @property {string|null} dshHome - --dsh-home.
 * @property {string|null} dsh - --dsh.
 * @property {boolean} force - overwrite a foreign pwshPath or permission mode.
 * @property {boolean} dryRun - plan only.
 * @property {boolean} help - print usage.
 */

/** The documented stock shell on this machine's Windows install.
 * @returns {string} an absolute path to Windows PowerShell. */
export function defaultShellPath() {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** The defaults, before any flag is read.
 * @returns {Options} the defaults. */
function defaultOptions() {
  return {
    baseProfile: 'bench-base', candProfile: 'bench-ops', template: 'headless',
    // There is no Windows PowerShell to pin off Windows, and `dsh-pwsh-sandbox` is
    // Windows-gated in the composition anyway, so the default is "no pin" there.
    pinShell: process.platform === 'win32' ? defaultShellPath() : null,
    permissionMode: 'danger-full-access',
    // The candidate measures the working tree: the default install is this checkout, so a
    // sweep prepares itself from the code under edit without a publish or a version bump.
    plugin: 'local', reinstall: false,
    dshHome: null, dsh: null, force: false, dryRun: false, help: false,
  }
}

/**
 * Parse the command line. An unknown flag is an error: a typo must not quietly prepare a
 * baseline with the wrong engine, or a candidate that is the published package.
 * @param {string[]} argv - arguments after the command name.
 * @param {{value?: Record<string, string>, boolean?: Record<string, [string, unknown]>}} [extra]
 *   - setup B's own flags, merged over the ones above.
 * @returns {Options} the options.
 */
export function parseArgs(argv, extra = {}) {
  const options = defaultOptions()
  const values = { ...VALUE_FLAGS, ...extra.value }
  const booleans = { ...BOOLEAN_FLAGS, ...extra.boolean }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument "${arg}"`)
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? null : arg.slice(eq + 1)
    const toggle = booleans[name]
    if (toggle) { options[toggle[0]] = toggle[1]; continue }
    const target = values[name]
    if (!target) throw new Error(`unknown option "${name}"`)
    const value = inline ?? argv[++i]
    if (value === undefined || value === '') throw new Error(`${name} needs a value`)
    options[target] = value
  }
  if (options.help) return options
  for (const [flag, value] of [['--base-profile', options.baseProfile], ['--cand-profile', options.candProfile]]) {
    if (!value) throw new Error(`${flag} needs a name`)
    if (SHIPPED_PROFILES.includes(value)) {
      throw new Error(`${flag} "${value}" is a shipped template name; bench profiles are created from it`)
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

/** The version of a checkout, which is also the version `local` resolves to.
 * @param {string} [root] - the checkout root (defaults to this repository).
 * @returns {string} the version, or `latest` when package.json cannot be read. */
export function repoVersion(root = REPO_ROOT) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? 'latest' } catch { return 'latest' }
}

/**
 * The home dsh will use, so the profiles prepared here are the profiles the runner reads.
 * @param {Options} options - the options.
 * @param {{env?: Record<string, string|undefined>, home?: string}} [context] - the
 *   environment and the user's home directory, injectable so a test never has to look at
 *   (let alone write) the real `~/.dsh`.
 * @returns {string} the absolute home.
 */
export function dshHomeFor(options, { env = process.env, home = os.homedir() } = {}) {
  if (options.dshHome) return path.resolve(options.dshHome)
  return path.resolve(env.DSH_HOME ?? path.join(home, '.dsh'))
}

/**
 * One patch entry this module owns: an `id` and the config keys it writes under it.
 * @typedef {object} PatchEntry
 * @property {string} id - the loader entry id the patch targets.
 * @property {Record<string, string>} config - the keys and values to pin.
 * @property {(current: string, wanted: string) => boolean} [same] - equality against a
 *   value already in the file; defaults to an exact string comparison.
 */

/**
 * Decide how to merge one patch entry into a profile patch layer, without a YAML library
 * and without rewriting a single character the module does not own.
 * @param {string} text - the current file content.
 * @param {PatchEntry} entry - the entry to pin.
 * @param {{force?: boolean}} [flags] - `force` allows overwriting a value this module did
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
  if (content.length === 0) return { action: 'write', text: joinLines([...trimTrailingBlanks(lines), ...block]), note: 'this patch layer held nothing but comments' }
  if (content.length === 1 && content[0].trim() === '[]') {
    return { action: 'write', text: joinLines(replace(lines, lines.findIndex(line => line.trim() === '[]'), 1, block)), note: 'replaced the template\'s [] placeholder' }
  }

  // Anything that is not a plain top-level list: refuse instead of guessing.
  if (!content.every(line => /^-\s/.test(line) || /^[ \t]+\S/.test(line))) {
    return { action: 'manual', text, note: 'this layer is not a plain top-level list, so its shape was not guessed at' }
  }

  const found = collectEntries(lines).find(item => item.id === entry.id)
  if (!found) return { action: 'write', text: joinLines([...trimTrailingBlanks(lines), ...block]), note: `appended a ${entry.id} entry` }

  const own = found.lines
  // An inline config is refused: one key is easy to add, but guessing where a flow mapping
  // ends is how a comment-preserving edit stops being one.
  if (own.some(line => /^[ \t]+config:\s*\S/.test(line))) {
    return { action: 'manual', text, note: `${entry.id}'s config is written inline; pasting one line by hand is safer than rewriting it` }
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
    if (!force) return { action: 'conflict', text, note: `already carries ${key}: ${current}, which this module did not write; not overwriting without --force` }
    const indent = /^[ \t]*/.exec(own[keyAt])[0]
    ops.push({ at: found.start + keyAt, count: 1, lines: [`${indent}${key}: ${value}`] })
    changed.push(`${key} → ${value}`)
  }
  if (missing.length > 0) {
    const pairs = missing.map(([key, value]) => `${key}: ${value}`)
    if (configAt !== -1) {
      const indent = /^[ \t]*/.exec(own[configAt])[0]
      ops.push({ at: found.start + configAt + 1, count: 0, lines: pairs.map(line => `${indent}  ${line}`) })
      changed.push(`added ${missing.map(([key]) => key).join(', ')}`)
    } else {
      const last = found.start + own.reduce((keep, line, offset) => (line.trim() === '' ? keep : offset), -1)
      ops.push({ at: last + 1, count: 0, lines: ['  config:', ...pairs.map(line => `    ${line}`)] })
      changed.push(`added the config block (${missing.map(([key]) => key).join(', ')})`)
    }
  }
  if (ops.length === 0) {
    return { action: 'noop', text, note: `already pinned to ${Object.entries(entry.config).map(([key, value]) => `${key} = ${value}`).join(', ')}` }
  }
  // Apply from the bottom up, so an earlier edit can never shift a later index.
  let next = lines
  for (const op of [...ops].sort((left, right) => right.at - left.at)) next = replace(next, op.at, op.count, op.lines)
  return { action: 'write', text: joinLines(next), note: `set ${entry.id}'s ${changed.join('; ')}` }
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
  return { action: changed ? 'write' : 'noop', text: changed ? current : text, note: notes.join('; ') }
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
 * @returns {'created'|'exists'|'missing-example'} what happened.
 */
export function ensureLlmOverlay({ overlay, example, dryRun = false, log = () => {} }) {
  if (fs.existsSync(overlay)) { log(`  ${overlay} already exists; it was not touched`); return 'exists' }
  if (!fs.existsSync(example)) {
    log(`  there is no ${example}, so there is no template to copy (a sweep can still run with --no-llm-patch, but the two sides then share no route)`)
    return 'missing-example'
  }
  if (dryRun) { log(`  would copy ${example} → ${overlay}`); return 'created' }
  fs.copyFileSync(example, overlay)
  log(`  no ${overlay} yet, so it was copied from ${path.basename(example)}; fill in the server and the model before a sweep`)
  return 'created'
}

/**
 * The plugin version installed in a profile, read from its dependency tree.
 * @param {string} home - the DSH_HOME in play.
 * @param {string} profile - the profile name.
 * @returns {string|null} the version, or null when the plugin is absent.
 */
export function installedPlugin(home, profile) {
  try {
    const manifest = path.join(home, 'profiles', profile, 'node_modules', PLUGIN_NAME, 'package.json')
    return JSON.parse(fs.readFileSync(manifest, 'utf8')).version ?? null
  } catch { return null }
}

/**
 * Where the candidate's copy of the plugin actually lives, when it is a link. `local`
 * installs this checkout, so a link that resolves somewhere else is worth saying out loud;
 * a copied (non-link) install answers null, because its real path says nothing about what
 * it was installed from.
 * @param {string} home - the DSH_HOME in play.
 * @param {string} profile - the profile name.
 * @returns {string|null} the resolved link target, or null.
 */
export function installedPluginOrigin(home, profile) {
  const dir = path.join(home, 'profiles', profile, 'node_modules', PLUGIN_NAME)
  try {
    if (!fs.lstatSync(dir).isSymbolicLink()) return null
    return fs.realpathSync(dir)
  } catch { return null }
}

/**
 * The version a plugin spec would land in the profile, when the spec names exactly one.
 * `local` means "whatever this checkout's package.json says"; a dist tag (`@latest`) or a
 * tarball URL pins nothing this module can compare against, so it answers null.
 * @param {string} spec - an npm spec, or "local".
 * @param {string} [root] - the checkout `local` resolves to (defaults to this repository).
 * @returns {string|null} the version, or null when the spec does not name one.
 */
export function specVersion(spec, root = REPO_ROOT) {
  const named = spec === 'local' ? repoVersion(root) : /^dsh-ops@(.+)$/.exec(spec)?.[1]
  return named && /^\d/.test(named) ? named : null
}

/**
 * What the candidate install would be, in the terms every message about it uses: the plugin
 * name, the spec handed to `dsh plugin add`, and the version a stale copy is compared with.
 * @param {Options} options - the options.
 * @param {string} [root] - the checkout `local` resolves to.
 * @returns {{local: boolean, spec: string, version: string|null, label: string, what: string}} the plan.
 */
export function installSpec(options, root = REPO_ROOT) {
  const local = options.plugin === 'local'
  const spec = local ? root : options.plugin
  const version = specVersion(options.plugin, root)
  return {
    local, spec, version,
    label: version ? `${PLUGIN_NAME}@${version}` : PLUGIN_NAME,
    what: local ? `the local checkout ${spec}` : spec,
  }
}

/** The canonical path of a directory, or null when it cannot be resolved.
 * @param {string} dir - the directory.
 * @returns {string|null} the canonical path, or null. */
function realPath(dir) {
  try { return fs.realpathSync(dir) } catch { return null }
}

/**
 * Run one dsh command and capture it, without a shell.
 *
 * This is the **only** way this half spawns dsh: `dsh`'s Windows PATH entry is a `.cmd`
 * wrapper Node cannot spawn with captured pipes, so callers resolve `lib/bin.js` (P1's
 * `resolveDshEntry` + `spawnPlan`) and pass the resulting argv prefix. `shell` stays off so
 * array arguments arrive verbatim. The deadline is three minutes because a cold
 * `pnpm install` behind `dsh plugin add` is a normal, slow, successful call.
 * @param {object} plan - what to spawn.
 * @param {string} plan.command - the executable (`process.execPath` for a JS entry).
 * @param {Record<string, string|undefined>} plan.env - the environment.
 * @param {number} [plan.timeoutMs] - the deadline.
 * @returns {(args: string[]) => {status: number|null, stdout: string, stderr: string, errorCode: string|null}}
 *   an `invoke` for {@link prepareProfiles}.
 */
export function spawnInvoker({ command, env, timeoutMs = 300_000 }) {
  return (args) => {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', errorCode: result.error?.code ?? null }
  }
}

/** Render a planned command line for humans, dropping the bin.js argument.
 * @param {string[]} args - the full argv including the entry file.
 * @returns {string} the printable form. */
function describeInvocation(args) {
  return `dsh ${args.filter(arg => !/bin\.js$/.test(arg)).join(' ')}`
}

/**
 * Create a profile from the shipped template when it does not exist yet.
 * @param {string} name - the profile name.
 * @param {object} context - the run context: home, template, dryRun, log, invoke.
 * @returns {'created'|'exists'|'failed'} what happened.
 */
function ensureProfile(name, context) {
  const dir = path.join(context.home, 'profiles', name)
  if (fs.existsSync(dir)) { context.log(`  ${name}: already exists, creation skipped`); return 'exists' }
  const args = [...context.prefix, name, '--from-default-profile', context.template, '--dump-config']
  if (context.dryRun) { context.log(`  ${name}: would run ${describeInvocation(args)}`); return 'created' }
  const result = context.invoke(args)
  if (result.status !== 0) {
    context.log(`  ${name}: creation failed exit=${result.status} — ${(result.stderr || result.stdout).trim().split('\n')[0]}`)
    return 'failed'
  }
  context.log(`  ${name}: created from ${context.template}`)
  return 'created'
}

/**
 * Apply the shell pin to the baseline profile's patch layer.
 * @param {Options} options - the options.
 * @param {object} context - the run context.
 * @returns {'pinned'|'noop'|'conflict'|'manual'|'absent'|'skipped'} the outcome.
 */
function pinBaselineShell(options, context) {
  if (!options.pinShell) {
    context.log('  --no-pin: nothing was touched. The baseline then hits the PATH pwsh alias, so both sides run PowerShell 7')
    return 'skipped'
  }
  const file = path.join(context.home, 'profiles', options.baseProfile, 'cordis.patch.yml')
  if (!fs.existsSync(file)) {
    // In a plan for a home that has no such profile yet, the file is created by the step
    // before this one, so its absence is the expected state rather than a failure.
    if (context.dryRun && !fs.existsSync(path.join(context.home, 'profiles', options.baseProfile))) {
      context.log(`  [dry-run] after the profile exists, ${SHELL_CONFIG_KEY} goes into ${file}`)
      return 'pinned'
    }
    context.log(`  cannot find ${file}`)
    return 'absent'
  }
  const plan = planProfilePatch(fs.readFileSync(file, 'utf8'), options.pinShell, { force: options.force })
  if (plan.action === 'noop') { context.log(`  ${plan.note}`); return 'noop' }
  if (plan.action === 'conflict' || plan.action === 'manual') {
    context.log(`  ${plan.note}`)
    context.log(`  by hand: edit ${file} so ${SHELL_ENTRY_ID}'s ${SHELL_CONFIG_KEY} takes the value below (add it when absent, replace another value; the file's [] placeholder becomes these three lines)`)
    context.log(`    - id: ${SHELL_ENTRY_ID}\n      config:\n        ${SHELL_CONFIG_KEY}: ${options.pinShell}`)
    return plan.action
  }
  if (context.dryRun) { context.log(`  would write ${file} — ${plan.note}`); return 'pinned' }
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
 * @returns {'pinned'|'noop'|'conflict'|'manual'|'absent'|'skipped'} the worst outcome.
 */
function pinPermissionMode(options, context) {
  if (options.permissionMode === 'none') {
    context.log('  --permission-mode none: nothing was touched. Both sides keep the profile\'s own mode, and runs from different modes are not comparable')
    return 'skipped'
  }
  context.log(`  both sides pinned to ${options.permissionMode} / approval ${approvalPolicyFor(options.permissionMode)}: that is not the default workspace-write, and runs made under another mode cannot be compared directly`)
  const outcomes = [options.baseProfile, options.candProfile].map(profile => pinOneProfileMode(profile, options, context))
  const order = ['conflict', 'manual', 'absent', 'pinned', 'noop']
  return order.find(outcome => outcomes.includes(outcome)) ?? 'noop'
}

/**
 * Apply {@link pinPermissionMode} to one profile.
 * @param {string} profile - the profile name.
 * @param {Options} options - the options.
 * @param {object} context - the run context.
 * @returns {'pinned'|'noop'|'conflict'|'manual'|'absent'} the outcome.
 */
function pinOneProfileMode(profile, options, context) {
  const file = path.join(context.home, 'profiles', profile, 'cordis.patch.yml')
  if (!fs.existsSync(file)) {
    // Same dry-run allowance as the shell pin: the profile step is about to create it.
    if (context.dryRun && !fs.existsSync(path.join(context.home, 'profiles', profile))) {
      context.log(`  [dry-run] after profile ${profile} exists, ${options.permissionMode} goes into ${file}`)
      return 'pinned'
    }
    context.log(`  ${profile}: cannot find ${file}`)
    return 'absent'
  }
  const plan = planPatchEntries(fs.readFileSync(file, 'utf8'), permissionEntries(options.permissionMode), { force: options.force })
  if (plan.action === 'noop') { context.log(`  ${profile}: ${plan.note}`); return 'noop' }
  if (plan.action === 'conflict' || plan.action === 'manual') {
    context.log(`  ${profile}: ${plan.note}`)
    context.log(`  by hand: edit ${file} so ${PERMISSION_ENTRY_ID}.${PERMISSION_CONFIG_KEY} takes ${options.permissionMode} and ${APPROVAL_ENTRY_ID}.${APPROVAL_CONFIG_KEY} takes ${approvalPolicyFor(options.permissionMode)}`)
    context.log(`    - id: ${PERMISSION_ENTRY_ID}\n      config:\n        ${PERMISSION_CONFIG_KEY}: ${options.permissionMode}\n    - id: ${APPROVAL_ENTRY_ID}\n      config:\n        ${APPROVAL_CONFIG_KEY}: ${approvalPolicyFor(options.permissionMode)}`)
    return plan.action
  }
  if (context.dryRun) { context.log(`  [dry-run] would write ${file} — ${plan.note}`); return 'pinned' }
  fs.writeFileSync(file, plan.text, 'utf8')
  context.log(`  ${profile}: ${plan.note}`)
  return 'pinned'
}

/**
 * Read the composed tree back on both sides and prove the mode pin landed. The mode is what
 * the tools actually run under, so the archived `dump-config.txt` has to show it.
 * @param {Options} options - the options.
 * @param {object} context - the run context.
 * @returns {boolean} whether both profiles really compose to the requested mode.
 */
function verifyPermissionMode(options, context) {
  if (options.permissionMode === 'none') return true
  const overlay = context.overlay ?? LLM_OVERLAY
  const wantedApproval = approvalPolicyFor(options.permissionMode)
  let ok = true
  for (const profile of [options.baseProfile, options.candProfile]) {
    const args = [...context.prefix, '--profile', profile]
    if (fs.existsSync(overlay)) args.push('--patch', overlay)
    args.push('--dump-config')
    const result = context.invoke(args)
    if (result.status !== 0) {
      context.log(`  "dsh --profile ${profile} --dump-config" exit=${result.status}; the composed tree could not be read`)
      ok = false
      continue
    }
    const text = `${result.stdout}\n${result.stderr}`
    const mode = entryConfigValue(text, PERMISSION_ENTRY_ID, PERMISSION_CONFIG_KEY)
    const approval = entryConfigValue(text, APPROVAL_ENTRY_ID, APPROVAL_CONFIG_KEY)
    if (mode === options.permissionMode && approval === wantedApproval) {
      context.log(`  ${profile}: ${PERMISSION_ENTRY_ID}.${PERMISSION_CONFIG_KEY} = ${mode}, ${APPROVAL_ENTRY_ID}.${APPROVAL_CONFIG_KEY} = ${approval} ✅`)
      continue
    }
    context.log(`  ${profile}: the composed tree says mode=${mode ?? '(unreadable)'} / approval=${approval ?? '(unreadable)'}, wanted ${options.permissionMode} / ${wantedApproval} ❌`)
    ok = false
  }
  return ok
}

/**
 * Read the composed tree back: the only proof that the shell pin actually landed, because a
 * patch whose id the loader does not know is warned about and skipped silently.
 * @param {Options} options - the options.
 * @param {object} context - the run context.
 * @returns {boolean} whether the baseline really got the requested engine.
 */
function verifyBaselineShell(options, context) {
  if (!options.pinShell) return true
  const overlay = context.overlay ?? LLM_OVERLAY
  const args = [...context.prefix, '--profile', options.baseProfile]
  if (fs.existsSync(overlay)) args.push('--patch', overlay)
  args.push('--dump-config')
  const result = context.invoke(args)
  if (result.status !== 0) {
    context.log(`  "dsh --profile ${options.baseProfile} --dump-config" exit=${result.status}; the composed tree could not be read`)
    return false
  }
  const pinned = `${result.stdout}\n${result.stderr}`.match(/pwshPath:\s*(.+)$/m)?.[1]?.trim() ?? null
  if (pinned && samePath(pinned, options.pinShell)) {
    context.log(`  the baseline composes ${SHELL_ENTRY_ID}.config.${SHELL_CONFIG_KEY} = ${pinned} ✅ (the overlay layer sits above the profile layer)`)
    return true
  }
  context.log(pinned
    ? `  the baseline actually runs ${pinned}, which is not the required ${options.pinShell} ❌`
    : `  the composed tree has no ${SHELL_CONFIG_KEY} ❌ — the baseline would hit the PATH pwsh alias, not the in-box Windows PowerShell 5.1`)
  return false
}

/**
 * Install (or deliberately leave) the plugin under test in the candidate profile.
 *
 * The default spec is this checkout, so the candidate carries the working tree; a profile
 * whose copy is a different version is a failure with the fix named, not a silent skip —
 * otherwise a sweep happily measures the last release instead of the code under edit. Every
 * failure names the plugin, the version and the spec it was trying to install.
 * @param {Options} options - the options.
 * @param {object} context - the run context.
 * @returns {'installed'|'present'|'stale'|'skipped'|'failed'} the outcome.
 */
function prepareCandidate(options, context) {
  const root = context.repoRoot ?? REPO_ROOT
  const { local, spec, version: wanted, label, what } = installSpec(options, root)
  const installed = installedPlugin(context.home, options.candProfile)
  const origin = installedPluginOrigin(context.home, options.candProfile)
  if (options.plugin === 'none') {
    context.log(installed ? `  ${PLUGIN_NAME}@${installed} is already installed; --no-plugin left it alone` : `  --no-plugin: the candidate profile has no ${PLUGIN_NAME}, so the candidate side cannot be measured`)
    return installed ? 'present' : 'skipped'
  }
  if (installed) {
    context.log(`  the candidate profile carries ${PLUGIN_NAME}@${installed}${origin ? `, linked from ${origin}` : ''}`)
    if (local && origin && origin !== realPath(root)) {
      context.log(`  that link does not resolve to this checkout (${root}); --reinstall relinks it`)
    }
  }
  if (installed && !options.reinstall) {
    if (wanted && installed !== wanted) {
      if (context.dryRun) {
        context.log(`  the candidate has ${PLUGIN_NAME}@${installed} but ${label} (${what}) is wanted: a real run would remove it and add ${spec}`)
        return 'installed'
      }
      context.log(`  the candidate has ${PLUGIN_NAME}@${installed} but ${label} (${what}) is wanted — without a reinstall this sweep measures that older release; add --reinstall`)
      return 'stale'
    }
    context.log(local
      ? `  ${PLUGIN_NAME}@${installed} is installed (${what}). The profile links the local directory, so code edits land in the next run; reinstall only after dependency or version changes`
      : `  ${PLUGIN_NAME}@${installed} is installed and matches ${spec}; it was left alone`)
    return 'present'
  }
  const steps = installed && options.reinstall ? [['remove', PLUGIN_NAME], ['add', spec]] : [['add', spec]]
  for (const [verb, target] of steps) {
    const args = [...context.prefix, 'plugin', '--profile', options.candProfile, verb, target]
    if (context.dryRun) { context.log(`  would run ${describeInvocation(args)}`); continue }
    context.log(`  installing ${label} into ${options.candProfile}: dsh plugin ${verb} ${target} … (pnpm is doing the work; this can take a while)`)
    const result = context.invoke(args)
    if (result.status !== 0) {
      const hint = result.errorCode === 'ENOENT' ? ' (the command could not start)' : ''
      context.log(`  ✗ could not install ${label} (${what}) into ${options.candProfile}: ${describeInvocation(args)} → exit=${result.status}${hint}`)
      context.log(`    ${(result.stderr || result.stdout).trim().split('\n').slice(-3).join('\n    ')}`)
      context.log('    when pnpm is not on PATH, "dsh plugin" exits 127')
      return 'failed'
    }
  }
  context.log(`  the candidate now installs ${label} (${what}); at runtime it injects its own pwshPath`)
  return 'installed'
}

/**
 * The closing "what now" lines: the sweep entry point, and nothing else.
 *
 * The wrapper runs the baseline side, the candidate side and the comparison, and derives
 * both labels from the profile names this module just prepared — so a renamed pair is handed
 * over explicitly instead of letting the run fall back to bench-base/bench-ops.
 * @param {object} profiles - the prepared pair.
 * @param {string} profiles.baseProfile - the baseline profile.
 * @param {string} profiles.candProfile - the candidate profile.
 * @returns {string[]} the lines, ready to print.
 */
export function nextStepLines({ baseProfile, candProfile }) {
  const renamed = baseProfile !== 'bench-base' || candProfile !== 'bench-ops'
  const flags = renamed ? ` --base ${baseProfile} --cand ${candProfile}` : ''
  return [
    `  node bench/cli.mjs ab${flags}  — baseline, candidate, then the comparison, in one bench/runs group`,
    '  node bench/cli.mjs ab --show  — print the group and its three commands without running them',
  ]
}

/**
 * The context {@link prepareProfiles} narrates into and reads paths from. Every field is
 * injectable so the tests run against a temporary home and a temporary checkout.
 * @typedef {object} PrepareContext
 * @property {string} home - the DSH_HOME the profiles live under.
 * @property {(line: string) => void} log - where the narration goes.
 * @property {(args: string[]) => {status: number|null, stdout: string, stderr: string, errorCode: string|null}} invoke
 *   - how a dsh command is run; the tests pass a stand-in, so nothing is really installed.
 * @property {string[]} prefix - the argv prefix that reaches `lib/bin.js` (P1's `spawnPlan`).
 * @property {boolean} dryRun - plan only.
 * @property {string} [template] - the shipped profile to create from (default headless).
 * @property {string} [repoRoot] - the checkout `local` installs (default this repository).
 * @property {string} [overlay] - the filled-in overlay path (default `bench/llm.patch.yml`).
 * @property {string} [overlayExample] - the committed template (default the `.example.yml`).
 */

/**
 * The verdict {@link prepareProfiles} returns instead of printing.
 * @typedef {object} PrepareResult
 * @property {boolean} ok - whether the pair is ready (no problems).
 * @property {string[]} problems - what makes the pair unusable, each naming its fix.
 * @property {string[]} warnings - conditions worth reporting that are not failures.
 * @property {Record<string, string>} outcomes - the per-step verdicts.
 * @property {string[]} nextSteps - the sweep command lines.
 */

/**
 * Prepare both profiles, in order, and report what happened.
 *
 * Steps: the LLM overlay, profile creation, the baseline shell pin, the permission pin on
 * both sides, the candidate install, then the `--dump-config` read-back that proves both
 * pins landed. Nothing is written under `--dry-run`, including the overlay copy.
 * @param {Options} options - the parsed options.
 * @param {PrepareContext} context - where to write and how to invoke dsh.
 * @returns {PrepareResult} the verdict; the caller prints it and owns the exit code.
 */
export function prepareProfiles(options, context) {
  const log = context.log ?? (() => {})
  const problems = []
  const warnings = []
  const outcomes = {}
  const overlayPath = context.overlay ?? LLM_OVERLAY
  const examplePath = context.overlayExample ?? LLM_OVERLAY_EXAMPLE
  const root = context.repoRoot ?? REPO_ROOT
  const install = installSpec(options, root)

  if (process.platform !== 'win32' && options.pinShell) {
    warnings.push(`this host is not Windows, so the pinned baseline shell ${options.pinShell} does not exist here; pass --no-pin (the pin only matters where the Store pwsh alias does)`)
  }

  log('\n— 1) LLM overlay —')
  outcomes.overlay = ensureLlmOverlay({ overlay: overlayPath, example: examplePath, dryRun: options.dryRun, log })
  if (outcomes.overlay === 'missing-example') {
    warnings.push(`there is no ${examplePath} to copy: ${path.basename(overlayPath)} cannot be created, and a sweep then needs --no-llm-patch, which leaves the two sides without one shared route`)
  }

  log('\n— 2) profiles —')
  outcomes.baseProfile = ensureProfile(options.baseProfile, context)
  outcomes.candProfile = ensureProfile(options.candProfile, context)
  if (outcomes.baseProfile === 'failed' || outcomes.candProfile === 'failed') {
    problems.push(`could not create both bench profiles from the "${context.template}" template, so nothing was pinned`)
    return { ok: false, problems, warnings, outcomes, nextSteps: nextStepLines(options) }
  }

  log('\n— 3) baseline shell engine —')
  outcomes.shellPin = pinBaselineShell(options, context)
  if (outcomes.shellPin === 'conflict') problems.push(`the baseline profile already pins ${SHELL_CONFIG_KEY} to another value; re-run with --force to overwrite it`)
  if (outcomes.shellPin === 'manual') problems.push(`the baseline profile's patch layer is not a plain top-level list; paste the printed entry by hand`)
  if (outcomes.shellPin === 'absent') problems.push(`there is no cordis.patch.yml under profiles/${options.baseProfile}`)

  log('\n— 4) permission mode —')
  outcomes.permissions = pinPermissionMode(options, context)
  if (outcomes.permissions === 'conflict') problems.push(`a bench profile already pins a different permission mode; re-run with --force to overwrite it (both sides have to run in one mode)`)
  if (outcomes.permissions === 'manual') problems.push(`a bench profile's patch layer is not a plain top-level list; paste the printed entries by hand`)
  if (outcomes.permissions === 'absent') problems.push(`one of the two bench profiles has no cordis.patch.yml`)

  log('\n— 5) candidate plugin —')
  outcomes.plugin = prepareCandidate(options, context)
  if (outcomes.plugin === 'failed') {
    problems.push(`the candidate profile does not have ${install.label} (${install.what}); "dsh plugin --profile ${options.candProfile}" did not succeed — see the lines above, and install pnpm if it is missing from PATH`)
  }
  if (outcomes.plugin === 'stale') {
    const installed = installedPlugin(context.home, options.candProfile)
    problems.push(`the candidate profile has ${PLUGIN_NAME}@${installed} but this checkout is ${install.label} (${install.what}); re-run with --reinstall, or the sweep measures that other release`)
  }

  log('\n— 6) read the composed tree back —')
  let installedNow = installedPlugin(context.home, options.candProfile)
  let shellVerified = true
  let permissionsVerified = true
  if (options.dryRun) {
    log('  [dry-run] skipping the read-back: a real run confirms the baseline pwshPath and both permission modes with dsh --dump-config')
  } else {
    shellVerified = verifyBaselineShell(options, context)
    permissionsVerified = verifyPermissionMode(options, context)
    installedNow = installedPlugin(context.home, options.candProfile)
    if (options.plugin !== 'none') {
      log(installedNow ? `  the candidate profile carries ${PLUGIN_NAME}@${installedNow} ✅` : `  no ${PLUGIN_NAME} readable in the candidate profile ❌ (node_modules/${PLUGIN_NAME}/package.json is absent)`)
    }
  }
  if (!shellVerified) problems.push('the baseline shell engine did not verify out of --dump-config')
  if (!permissionsVerified) problems.push('the permission mode did not verify out of --dump-config')
  if (options.plugin !== 'none' && !options.dryRun && !installedNow) problems.push(`there is no ${PLUGIN_NAME} in the candidate profile, so the candidate side has nothing to measure`)

  log('\n— next —')
  for (const line of nextStepLines(options)) log(line)

  return { ok: problems.length === 0, problems, warnings, outcomes, nextSteps: nextStepLines(options) }
}
