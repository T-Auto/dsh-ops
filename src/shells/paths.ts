/**
 * Where each shell rung can come from, and in what order.
 *
 * This module is pure and read-only: it probes configured paths, the
 * provisioned copies `dsh-ops provision-shells` installed under
 * `<DSH_HOME>/dsh-ops/shells`, the copies a plugin package carries, and the
 * conventional install locations, and it NEVER mutates ambient state (no PATH
 * writes, no profile writes, no `process.chdir`).
 *
 * Legacy PowerShell probes remain available for compatibility and explicit
 * provisioning reports. Runtime mounting never activates those copies or
 * rewrites the host PowerShell configuration.
 *
 * The probes below are exported for their sibling modules under `lib/shells/`;
 * the barrel `lib/shells.js` re-exports only the public names.
 *
 * @module dsh-ops/shells/paths
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { ShellKind } from './pins.js'
import {
  PLATFORM_PACKAGES,
  provisionedShellStore,
  shellExecutable,
  shellUpstreamPin,
} from './pins.js'

export type ShellResolution = { available: true; file: string; source: string; detail: string }
  | { available: false; file?: undefined; source: string; detail: string }
export type BundledCause = 'no-manifest' | 'not-declared' | 'not-installed' | 'incomplete-tree'
interface BundleProbe { kind: ShellKind; bundleRoot: string; platform: string; arch: string }
type PackageProbe = { found: true; file: string } | { found: false; detail: string; cause: BundledCause }

/**
 * Historical PowerShell layout order, retained for compatibility probes only.
 * @type {readonly ['provisioned', 'package', 'vendor']}
 */
export const PWSH_LAYOUT_ORDER = Object.freeze(['provisioned', 'package', 'vendor'])

/**
 * One shell rung's resolution.
 * @typedef {object} ShellResolution
 * @property {boolean} available - whether this rung can run right now.
 * @property {string|undefined} file - the resolved executable, when available.
 * @property {string} source - where the answer came from, for reports and tests.
 *   One of `disabled`, `config`, `provisioned`, `bundled`, `path`, `well-known`,
 *   `missing`, `host`.
 * @property {string} detail - a one-line English explanation, for reports.
 */

/**
 * Whether a candidate names something this process can spawn.
 *
 * `lstat` is used deliberately: a symlink (the Node shape of a Windows Store
 * app-execution alias) is a valid executable even when its target is not
 * statable, a real directory never is, and any unexpected error answers `false`
 * rather than throwing out of a load-time probe.
 * @param {string|undefined} file - the candidate path.
 * @returns {boolean} whether the candidate exists and is not a directory.
 */
export function isSpawnableFile(file: unknown): file is string {
  if (typeof file !== 'string' || file === '') return false
  try {
    const stat = fs.lstatSync(file)
    return stat.isFile() || stat.isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * The `<platform>-<arch>` infix both the platform packages and the vendored
 * layout use (`win32-x64`).
 * @param {string} platform - `process.platform`.
 * @param {string} arch - `process.arch`.
 * @returns {string} the key.
 */
function platformKey(platform: string, arch: string) {
  return `${platform}-${arch}`
}

/**
 * The two layouts the plugin's own shell can arrive in, in the order they are
 * preferred. Phase C publishes `@dsh-ops/<kind>-<platform>-<arch>` (the shell
 * at `bin/<exe>`); a checkout that vendors its own copy uses
 * `vendor/<kind>/<platform>-<arch>/<exe>`.
 *
 * The ORDER is part of the contract, not an implementation detail: the L3
 * `!!js` override in `cordis.patch.yml` probes the same two places in the same
 * order (it cannot import this module — a bundle patch is plain YAML), so the
 * ladder's `available`/`file` and the host row's executable must agree for
 * every layout a deployment can present. `test/shells-resolution.test.mjs`
 * asserts that agreement against both layouts.
 * @type {readonly ['package', 'vendor']}
 */
export const BUNDLED_LAYOUT_ORDER = Object.freeze(['package', 'vendor'])

/**
 * The vendored bundled shell inside the package, whether or not it exists.
 * @param {object} options - resolution inputs.
 * @param {'bash'|'pwsh'} options.kind - which rung.
 * @param {string} options.bundleRoot - the plugin package root.
 * @param {string} options.platform - `process.platform`.
 * @param {string} options.arch - `process.arch`.
 * @returns {string} the path the bundled copy would occupy.
 */
export function bundledShellPath({ kind, bundleRoot, platform, arch }: BundleProbe) {
  const target = PLATFORM_PACKAGES[kind]
  return path.join(bundleRoot, 'vendor', target.vendor, platformKey(platform, arch), shellExecutable(kind, platform))
}

/**
 * Why the plugin's own copy of one shell is unusable.
 *
 * The four values are the whole domain of a bundled miss, and they are what
 * {@link bashRemedy} switches on: the advice a deployment sees is chosen by
 * this fact rather than by matching words inside the detail, so editing the
 * sentence can never silently move a user onto the wrong remedy. The wording
 * of the facts is `lib/binary.js`'s (`packageBinaryAt` reports the same three
 * shapes in the same words), because a reader who has seen one side of this
 * plugin should recognise the other.
 * @typedef {'no-manifest'|'not-declared'|'not-installed'|'incomplete-tree'} BundledCause
 */

/**
 * Where the installed platform package's shell would live, when that package is
 * resolvable at all.
 *
 * Every miss names itself twice: `detail` is the sentence a report shows, and
 * `cause` is the same fact in machine-readable form for the code that has to
 * choose what to tell the reader to do about it.
 * @param {object} options - resolution inputs.
 * @param {'bash'|'pwsh'} options.kind - which rung.
 * @param {string} options.bundleRoot - the plugin package root.
 * @param {string} options.platform - `process.platform`.
 * @param {string} options.arch - `process.arch`.
 * @returns {{found: true, file: string}|{found: false, detail: string, cause: BundledCause}} the candidate.
 */
function platformPackageShell({ kind, bundleRoot, platform, arch }: BundleProbe): PackageProbe {
  const target = PLATFORM_PACKAGES[kind]
  const name = `${target.prefix}${platformKey(platform, arch)}`
  let declared
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'package.json'), 'utf8')) as { optionalDependencies?: Record<string, unknown>; dependencies?: Record<string, unknown> }
    declared = { ...manifest.optionalDependencies, ...manifest.dependencies }
  } catch {
    return { found: false, cause: 'no-manifest', detail: `${name} is not installed (no readable plugin manifest)` }
  }
  if (declared[name] === undefined) {
    return { found: false, cause: 'not-declared', detail: `${name} is not installed` }
  }
  let directory
  try {
    const require = createRequire(path.join(bundleRoot, 'package.json'))
    directory = path.dirname(require.resolve(`${name}/package.json`))
  } catch {
    return { found: false, cause: 'not-installed', detail: `${name} is declared but not installed` }
  }
  const file = path.join(directory, 'bin', shellExecutable(kind, platform))
  return isSpawnableFile(file)
    ? { found: true, file }
    : { found: false, cause: 'incomplete-tree', detail: `${name} is installed without bin/${shellExecutable(kind, platform)}` }
}

/**
 * Pick the bundled shell from the layout candidates, first existing wins.
 *
 * This is the ONE preference rule both the probe and the patch expression
 * implement; see {@link BUNDLED_LAYOUT_ORDER}.
 * @param {(string|undefined)[]} candidates - candidate paths, most preferred first.
 * @returns {string|undefined} the first existing candidate.
 */
export function preferredBundledFile(candidates: readonly (string | undefined)[]) {
  for (const candidate of candidates) {
    if (isSpawnableFile(candidate)) return candidate
  }
  return undefined
}

/**
 * The plugin's own copy of one shell, from whichever layout carries it: the
 * installed platform package first, then the vendored subdirectory.
 *
 * `cause` is carried alongside `detail` so a caller that has to act on the
 * miss — `resolveBash` in `lib/shells/resolve.js` chooses which remedy to
 * print — reads a fact
 * instead of parsing the sentence. It is additive: callers that only read
 * `file`/`detail` are unaffected.
 * @param {object} options - resolution inputs.
 * @param {'bash'|'pwsh'} options.kind - which rung.
 * @param {string} options.bundleRoot - the plugin package root.
 * @param {string} options.platform - `process.platform`.
 * @param {string} options.arch - `process.arch`.
 * @returns {{file: string|undefined, detail: string|undefined, cause: BundledCause|undefined}}
 *   the executable and, when there is none, why the plugin's own copy is
 *   unusable — as text for a report, and as the cause behind it.
 */
export function bundledShell({ kind, bundleRoot, platform, arch }: BundleProbe) {
  const packaged = platformPackageShell({ kind, bundleRoot, platform, arch })
  const vendored = bundledShellPath({ kind, bundleRoot, platform, arch })
  // The same preference rule, in the same order, as the L3 patch expression.
  const file = preferredBundledFile([packaged.found ? packaged.file : undefined, vendored])
  // A cause only ever explains a miss: a vendored copy that IS there outranks
  // the platform package's absence, and reporting the absence beside a usable
  // file would be a fact about nothing.
  return file === undefined
    ? { file: undefined, detail: packaged.found ? undefined : packaged.detail, cause: packaged.found ? undefined : packaged.cause }
    : { file, detail: undefined, cause: undefined }
}

/**
 * The provisioned copy of one shell, out of the plugin-managed store.
 *
 * Layout: `<DSH_HOME>/dsh-ops/shells/<kind>/<version>/<executableRelativePath>`
 * — the directory `dsh-ops provision-shells` installs the pinned upstream
 * release into. Every version directory that actually holds the executable is a
 * candidate, and the greatest version name wins.
 *
 * That comparison IS the whole rule, deliberately: `cordis.patch.yml`'s L3
 * expression implements the identical one, because a bundle patch is plain YAML
 * and cannot import this module, and the ladder's PowerShell rung and the host's
 * `pwsh-sandbox` row must keep pointing at the same file. The store holds one
 * version per shell in normal use; a leftover version directory is what the
 * comparison is there for.
 *
 * A copy installed here was digest-checked against {@link SHELL_UPSTREAM_PINS}
 * when it arrived, which is why it outranks anything already on the machine
 * while still sitting below `config.<kind>Path` and below a system fallback's
 * own off switch.
 * @param {object} options - resolution inputs.
 * @param {'bash'|'pwsh'} options.kind - which rung.
 * @param {NodeJS.ProcessEnv} options.env - the environment to read `DSH_HOME` from.
 * @param {string} [options.platform] - `process.platform`.
 * @param {string} [options.arch] - `process.arch`.
 * @returns {{file: string, version: string}|undefined} the executable and the
 *   version directory it came from, or undefined when the store has none.
 */
export function provisionedShell({ kind, env, platform = process.platform, arch = process.arch }: { kind: ShellKind; env: NodeJS.ProcessEnv; platform?: string; arch?: string }) {
  const store = path.join(provisionedShellStore({ env }), kind)
  let versions
  try {
    versions = fs.readdirSync(store, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
  } catch {
    return undefined
  }
  const relative = shellUpstreamPin({ kind, platform, arch })?.executableRelativePath
    ?? path.join('bin', shellExecutable(kind, platform))
  for (const version of versions) {
    const file = path.join(store, version, relative)
    if (isSpawnableFile(file)) return { file, version }
  }
  return undefined
}

/**
 * One executable found by walking a PATH-shaped string.
 *
 * This is a read-only walk of the value it was handed: it never writes PATH and
 * never consults anything but the string it is given.
 * @param {object} options - search inputs.
 * @param {string[]} options.names - executable names to accept, in order.
 * @param {string|undefined} options.pathValue - the PATH value to walk.
 * @returns {string|undefined} the first existing entry, or undefined.
 */
export function fromPath({ names, pathValue, reject }: { names: readonly string[]; pathValue?: string; reject?: (file: string) => boolean }) {
  if (typeof pathValue !== 'string' || pathValue.trim() === '') return undefined
  for (const entry of pathValue.split(path.delimiter)) {
    // PATH entries may carry surrounding quotes from `setx`-style definitions.
    const directory = entry.trim().replace(/^"(.*)"$/, '$1')
    if (directory === '' || !path.isAbsolute(directory)) continue
    for (const name of names) {
      const file = path.join(directory, name)
      if (isSpawnableFile(file) && !(reject?.(file) ?? false)) return file
    }
  }
  return undefined
}

/**
 * Windows ships the WSL distribution launcher as a `bash.exe`, not as a POSIX
 * shell: `%SystemRoot%\\System32\\bash.exe`, plus the Store app-execution alias
 * `%LOCALAPPDATA%\\Microsoft\\WindowsApps\\bash.exe`, which `where bash` finds on a
 * machine that never installed Git Bash. Treating either as a normal PATH bash
 * silently moves commands into a Linux distribution, so neither may be selected
 * by the fallback scan or offered as a candidate. `path.win32` is intentional:
 * tests can exercise the Windows resolver while running on another host platform.
 * @param {string} file - candidate executable.
 * @param {NodeJS.ProcessEnv} env - environment containing SystemRoot and LOCALAPPDATA.
 * @param {string} platform - target platform.
 * @returns {boolean} whether the candidate is a WSL launcher.
 */
export function isWslBashLauncher(file: string, env: NodeJS.ProcessEnv, platform: string) {
  if (platform !== 'win32') return false
  const normalize = (value: string) => path.win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase()
  const candidate = normalize(file)
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT
  if (typeof systemRoot === 'string' && systemRoot.trim() !== ''
    && candidate === normalize(path.win32.join(systemRoot, 'System32', 'bash.exe'))) return true
  // The Store alias lives under %LOCALAPPDATA%; a Git for Windows install never does.
  const aliasRoot = env.LOCALAPPDATA ?? env.LocalAppData
  return typeof aliasRoot === 'string' && aliasRoot.trim() !== ''
    && candidate === normalize(path.win32.join(aliasRoot, 'Microsoft', 'WindowsApps', 'bash.exe'))
}

/**
 * The well-known install locations to probe for one rung.
 *
 * The bash list deliberately omits `%SystemRoot%\System32\bash.exe`: that is the
 * WSL distribution launcher, not a POSIX shell over the caller's filesystem, so
 * spawning it would silently run the command on a different machine. The pwsh
 * list keeps Windows PowerShell 5.1 last, matching upstream's own resolution
 * order (`packages/shell/pwsh-local/src/resolve.ts:21-37`).
 * @param {object} options - probe inputs.
 * @param {'bash'|'pwsh'} options.kind - which rung.
 * @param {NodeJS.ProcessEnv} options.env - the environment to read.
 * @param {string} options.platform - `process.platform`.
 * @returns {string[]} the candidate paths, in order.
 */
export function wellKnownCandidates({ kind, env, platform }: { kind: ShellKind; env: NodeJS.ProcessEnv; platform: string }) {
  if (platform !== 'win32') {
    // Only bash has a POSIX rung here. PowerShell resolution belongs to
    // the host on every platform.
    // `path.posix` is deliberate — see POSIX_BASH_WELL_KNOWN.
    return kind === 'bash' ? POSIX_BASH_WELL_KNOWN.map(entry => path.posix.normalize(entry)) : []
  }
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES ?? 'C:\\Program Files'
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = env.LOCALAPPDATA ?? env.LocalAppData ?? ''
  const userProfile = env.USERPROFILE ?? ''
  const candidates = kind === 'bash'
    ? [
      path.join(programFiles, 'Git', 'bin', 'bash.exe'),
      path.join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'),
      path.join(programFilesX86, 'Git', 'bin', 'bash.exe'),
      localAppData === '' ? '' : path.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'),
      userProfile === '' ? '' : path.join(userProfile, 'scoop', 'shims', 'bash.exe'),
      userProfile === '' ? '' : path.join(userProfile, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
      'C:\\ProgramData\\chocolatey\\bin\\bash.exe',
      'C:\\tools\\msys64\\usr\\bin\\bash.exe',
      'C:\\msys64\\usr\\bin\\bash.exe',
    ]
    : [
      path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
      path.join(programFiles, 'PowerShell', '7-preview', 'pwsh.exe'),
      path.join(programFilesX86, 'PowerShell', '7', 'pwsh.exe'),
      localAppData === '' ? '' : path.join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe'),
      userProfile === '' ? '' : path.join(userProfile, 'scoop', 'shims', 'pwsh.exe'),
      'C:\\ProgramData\\chocolatey\\bin\\pwsh.exe',
    ]
  return candidates.filter((file) => file !== '')
}

/**
 * The executable names one rung answers to.
 * @param {'bash'|'pwsh'} kind - which rung.
 * @param {string} platform - `process.platform`.
 * @returns {string[]} the names, in probe order.
 */
export function executableNames(kind: ShellKind, platform: string) {
  const base = kind === 'bash' ? 'bash' : 'pwsh'
  return platform === 'win32' ? [`${base}.exe`, base] : [base]
}

/**
 * The remedy for a bash this deployment cannot place at all: the one action
 * that is right whatever the cause was, and therefore the one both the load
 * time detail and the spawn time failure fall back to. It is written once
 * because it is one decision — the spawn wording only adds the sentence's
 * closing period.
 */
export const GENERIC_BASH_REMEDY = 'run `dsh-ops provision-shells --bash` to install the pinned upstream copy'

/**
 * The remedy for a POSIX host that has no bash at all.
 *
 * `dsh-ops provision-shells` provisions the *pinned Windows* payload and is
 * Windows-only, so pointing a Linux operator at it would be wrong: the one
 * action that helps is naming the executable explicitly.
 */
export const POSIX_BASH_REMEDY = 'install bash with the distribution package manager, or set config.bashPath to the executable'

/**
 * Where a POSIX host keeps its own bash, in probe order.
 *
 * The same three locations cover Linux and the other non-Windows targets, so the
 * list is one fact rather than a per-distribution table: a distribution that put
 * bash elsewhere either has it on `PATH` (the rung above this one) or is served
 * by `config.bashPath`.
 *
 * `path.posix` is intentional for the same reason `path.win32` is used below:
 * this branch is selected by the TARGET platform, and the suite exercises it
 * while running on another host, so the candidates must not acquire a drive
 * letter or a backslash from the host's own `path` module.
 * @type {readonly string[]}
 */
export const POSIX_BASH_WELL_KNOWN = Object.freeze([
  '/opt/homebrew/bin/bash',
  '/usr/local/bin/bash',
  '/bin/bash',
  '/usr/bin/bash',
])

/**
 * What to do about a bundled bash that is not there, chosen by cause.
 *
 * The two named causes are NOT interchangeable, and the difference is the whole
 * point of this mapping:
 *
 * - `not-installed` is the mirror shape. The manifest asked for the platform
 *   package, the registry the profile installed from did not carry it, and the
 *   package manager skipped it in silence (exit code 0, no warning). Nothing on
 *   this machine can repair a package that was never published there, so this
 *   line names that possibility and points at `dsh-ops provision-shells`, which
 *   bypasses the registry entirely. It deliberately does not say `repair`: that
 *   is the word issue #20 kept following into a dead end.
 * - `incomplete-tree` is the opposite: the package IS here and only its
 *   executable is missing, which reinstalling the profile's dependencies really
 *   does fix. That advice stays, with the registry-free copy offered beside it.
 *
 * Everything else — a package the manifest never declared, an unreadable
 * manifest, and any cause a future version adds without mapping it — falls
 * through to the provisioner alone. That is the explicit default branch (D8):
 * the resolution contract is "never throw", so an unmapped cause still gets a
 * line that is correct rather than silence.
 * @param {BundledCause|undefined} cause - why the plugin's own copy is unusable.
 * @returns {string} the remedy, as a clause that ends a detail line.
 */
export function bashRemedy(cause: BundledCause | undefined) {
  if (cause === 'not-installed') {
    return 'the registry this profile installed from may not carry that platform package, '
      + 'so run `dsh-ops provision-shells --bash` to fetch the pinned copy from upstream releases instead'
  }
  if (cause === 'incomplete-tree') {
    return "reinstalling the profile's dependencies repairs that, or run "
      + '`dsh-ops provision-shells --bash` to fetch the pinned copy from upstream releases instead'
  }
  return GENERIC_BASH_REMEDY
}
