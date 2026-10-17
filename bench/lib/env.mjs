/**
 * The platform, path and environment facts every bench command shares.
 *
 * Locating the launcher: on Windows `dsh` resolves to a `.cmd` shim a Node process
 * cannot spawn with captured pipes, so the shim is *read* and the `lib/bin.js` behind
 * it is spawned as `spawn(process.execPath, [binJs, ...args])` instead. Describing the
 * environment: a polluted `PSModulePath` does not fail loudly, it used to make the
 * candidate side die inside every shell tool before the model's command ran (README §1).
 *
 * @module dsh-ops/bench/env
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** The `bench/` directory: this module lives one level below it. */
export const BENCH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** The repository root this checkout is, `bench/`'s parent. */
export const REPO_ROOT = path.dirname(BENCH_DIR)
/** The `<platform>-<arch>` tag the run contract records and reports key on. */
export const platformTag = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`

/**
 * Find an executable on PATH without spawning anything. A PATH scan beats
 * `where.exe` / `which`: a confined parent (an agent inside a sandbox) cannot always
 * open those pipes, and the launcher would then look missing from the next directory.
 */
export function findOnPath(name, env = process.env, platform = process.platform) {
  const directories = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)
  const extensions = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : ['']
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {}
    }
  }
  return null
}

/**
 * Extract the package's JS entry from an npm shim (`.cmd`, POSIX shell script, or
 * symlink target): npm writes `%dp0%\node_modules\@deepseek-ai\dsh\lib\bin.js` into
 * the Windows shim and `$basedir/node_modules/.../bin.js` into the POSIX one.
 */
export function binFromShim(shimFile) {
  let text = ''
  try {
    text = fs.readFileSync(shimFile, 'utf8')
  } catch {
    return null
  }
  const match = text.match(/(?:%dp0%|\$basedir|"?\{?\$?DIR\}?)[/\\]?(node_modules[/\\]@deepseek-ai[/\\]dsh[/\\].*?\.js)/i)
    ?? text.match(/(node_modules[/\\]@deepseek-ai[/\\]dsh[/\\].*?\.js)/i)
  if (!match) return null
  const fromShim = path.resolve(path.dirname(shimFile), match[1].replace(/"/g, ''))
  if (fs.existsSync(fromShim)) return fromShim
  const fallback = path.join(path.resolve(path.dirname(shimFile), '..'), '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  return fs.existsSync(fallback) ? fallback : null
}

/** Run a command and capture its output, never throwing on a missing binary. */
export function runCapture(command, args, env = process.env) {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', errorCode: result.error?.code ?? null }
  } catch {
    return null
  }
}

/**
 * Everything the harness learns while locating the dsh launcher.
 * @typedef {object} DshEntry
 * @property {string} file - the resolved `lib/bin.js` (or an executable).
 * @property {'js'|'exe'} kind - how to spawn it.
 * @property {string|null} version - the reported dsh version.
 * @property {string[]} notes - how it was found, for the audit trail.
 */

/**
 * Find the dsh launcher to spawn: `--dsh` wins, otherwise the PATH shim's
 * `node_modules/@deepseek-ai/dsh/lib/bin.js` target, otherwise Windows' npm prefix.
 */
export function resolveDshEntry(explicit = null, options = {}) {
  const { env = process.env, platform = process.platform } = options
  if (explicit) {
    const file = path.resolve(explicit)
    if (!fs.existsSync(file)) throw new Error(`--dsh points at a path that does not exist: ${file}`)
    return { file, kind: /\.(js|mjs|cjs)$/i.test(file) ? 'js' : 'exe', version: null, notes: ['explicit --dsh'] }
  }
  const notes = []
  const candidates = []
  const shim = findOnPath(platform === 'win32' ? 'dsh.cmd' : 'dsh', env, platform) ?? findOnPath('dsh', env, platform)
  if (shim) {
    notes.push(`PATH ${platform === 'win32' ? 'shim' : 'entry'} ${shim}`)
    let real = shim
    try {
      real = fs.realpathSync(shim)
    } catch {}
    if (/\.(js|mjs|cjs)$/i.test(real)) candidates.push(real)
    else candidates.push(binFromShim(real))
  }
  if (platform === 'win32' && env.APPDATA) candidates.push(path.join(env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return { file: candidate, kind: 'js', version: null, notes }
  }
  throw new Error(
    'could not find the dsh launcher. Install it globally ("npm i -g @deepseek-ai/dsh") or pass '
    + `--dsh <path>/lib/bin.js. Looked via: ${notes.length ? notes.join('; ') : 'nothing (no dsh on PATH, no npm root -g)'}`,
  )
}

/**
 * The spawn plan for a resolved entry — the **only** way the bench spawns dsh: a
 * `.cmd`/`.ps1`/`.bat` shim is never passed to `spawn` (Node cannot pipe it, and a
 * shell would re-quote argv), and `shell` stays off so array arguments arrive verbatim.
 */
export function spawnPlan(entry, args = []) {
  return {
    command: entry.kind === 'js' ? process.execPath : entry.file,
    args: entry.kind === 'js' ? [entry.file, ...args] : [...args],
    label: `dsh ${args.join(' ')}`.trim(),
  }
}

/**
 * Is this environment about to break the candidate for a reason that has nothing to
 * do with the plugin? A PowerShell 7 install's own module directory ahead of the
 * in-box Windows PowerShell one makes `Get-Acl` unresolvable inside dsh-ops'
 * workspace bootstrap: 5.1 auto-loads `Microsoft.PowerShell.Security`, hits that
 * Core-only manifest, its `Security.types.ps1xml` re-registers `ObjectSecurity`
 * members 5.1 already defines, the import fails, and every `pwsh` / `bash` /
 * `run_code` call dies before the model's command runs (README §1).
 *
 * Only a directory that really ships that module counts: `Documents\PowerShell\
 * Modules` and `Program Files\PowerShell\Modules` are user module folders and are
 * harmless, so a pure string match here would cry wolf on every PowerShell 7 box.
 *   and `path.delimiter` is `:` on POSIX, which would shred `C:\…` at the drive-letter colon.
 */
export function poisonedModulePath(modulePath, windows = process.env.SystemRoot ?? 'C:\\Windows', isDirectory = (file) => {
  try {
    return fs.statSync(file).isDirectory()
  } catch {
    return false
  }
}, delimiter = ';') {
  if (!modulePath) return null
  const entries = modulePath.split(delimiter).filter(Boolean)
  // Both halves stay Windows-shaped: `windows` is a Windows root and `PSModulePath` is a
  // Windows-only variable, so the joiner is pinned to win32. With `path.join` on a POSIX
  // host the in-box entry becomes `C:\Windows/system32/…`, never equals the entry below,
  // and the ordering rule silently collapses into "scan every entry".
  const inBox = path.win32.join(windows, 'system32', 'WindowsPowerShell', 'v1.0', 'Modules').toLowerCase()
  const atInBox = entries.findIndex((entry) => entry.toLowerCase() === inBox)
  for (const entry of entries.slice(0, atInBox === -1 ? entries.length : atInBox)) {
    if (/[\\/]WindowsPowerShell[\\/]/i.test(entry)) continue
    if (isDirectory(path.win32.join(entry, 'Microsoft.PowerShell.Security'))) return entry
  }
  return null
}

/** Render `PSModulePath` as one readable line, in search order. */
export function describeModulePath(modulePath, poison = null, delimiter = ';') {
  if (!modulePath) return 'PSModulePath is not set'
  return modulePath.split(delimiter).filter(Boolean)
    .map((entry, index) => `${index + 1}. ${entry}${poison && entry === poison ? '  <-- CORE MODULE ROOT AHEAD OF 5.1 (README §1)' : ''}`)
    .join(' | ')
}
