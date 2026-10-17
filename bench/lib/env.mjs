/**
 * Environment facts that decide whether a benchmark run can mean anything.
 *
 * Split out of `bench/setup.mjs` because the same check matters at sweep time:
 * a polluted `PSModulePath` does not fail loudly, it used to make the candidate side die
 * inside every shell tool before the model's command ever ran, and the symptom a human
 * saw was a run that "hangs" (README §1). The plugin now sanitizes the `PSModulePath` of
 * its own workspace-preparation child (`lib/workspace-preparation.js`), so what is left
 * here is the environment the *measurement* describes and the older plugin installs that
 * predate the repair. `run.mjs` preflight reads it here so it can say all of that before
 * burning tokens, and `setup.mjs` keeps reporting it in its own environment survey.
 *
 * @module dsh-ops/bench/env
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * Is this environment about to break the candidate for a reason that has nothing to do
 * with the plugin? A PowerShell 7 install's own module directory ahead of the in-box
 * Windows PowerShell one makes `Get-Acl` unresolvable inside dsh-ops' workspace bootstrap:
 * 5.1 auto-loads `Microsoft.PowerShell.Security`, hits that Core-only manifest, its
 * `Security.types.ps1xml` re-registers `ObjectSecurity` members 5.1 already defines, the
 * import fails, and every `pwsh` / `bash` / `run_code` call dies before the model's
 * command runs (README §1). The leak is per-process, so it arrives through the terminal
 * that started this script — which is why both setup and preflight check it.
 *
 * Only a directory that really ships that module counts: `Documents\PowerShell\Modules`
 * and `Program Files\PowerShell\Modules` are user module folders and are harmless, so a
 * pure string match here would cry wolf on every PowerShell 7 machine.
 * @param {string|undefined} modulePath - the `PSModulePath` value.
 * @param {string} [windows] - the Windows root, for tests.
 * @param {(file: string) => boolean} [isDirectory] - the existence probe, for tests.
 * @param {string} [delimiter] - the `PSModulePath` separator. Defaults to `path.delimiter`, but
 *   `PSModulePath` is a Windows-only variable: its separator is `;` no matter which host reads
 *   it. Tests pin it so a value full of `C:\…` does not get shredded at the drive-letter colons.
 * @returns {string|null} the offending entry, or null when nothing dangerous precedes the in-box path.
 */
export function poisonedModulePath(modulePath, windows = process.env.SystemRoot ?? 'C:\\Windows', isDirectory = (file) => {
  try {
    return fs.statSync(file).isDirectory()
  } catch {
    return false
  }
}, delimiter = path.delimiter) {
  if (!modulePath) return null
  const entries = modulePath.split(delimiter).filter(Boolean)
  // `windows` is always Windows-shaped (the default is `process.env.SystemRoot ?? 'C:\\Windows'`,
  // and `PSModulePath` is a Windows-only variable), so the joiner has to be pinned too: on a POSIX
  // host `path.join` produces `C:\Windows/system32/…`, which never equals the in-box entry below,
  // and the ordering rule silently collapses into "scan every entry".
  const inBox = path.win32.join(windows, 'system32', 'WindowsPowerShell', 'v1.0', 'Modules').toLowerCase()
  const atInBox = entries.findIndex((entry) => entry.toLowerCase() === inBox)
  const limit = atInBox === -1 ? entries.length : atInBox
  for (const entry of entries.slice(0, limit)) {
    if (/[\\/]WindowsPowerShell[\\/]/i.test(entry)) continue
    if (isDirectory(path.join(entry, 'Microsoft.PowerShell.Security'))) return entry
  }
  return null
}

/**
 * Render `PSModulePath` as one readable line, in search order.
 * @param {string|undefined} modulePath - the value.
 * @param {string|null} [poison] - the offending entry, when there is one.
 * @param {string} [delimiter] - the `PSModulePath` separator, matching `poisonedModulePath`.
 * @returns {string} the line.
 */
export function describeModulePath(modulePath, poison = null, delimiter = path.delimiter) {
  if (!modulePath || modulePath === '') return 'PSModulePath is not set'
  const entries = modulePath.split(delimiter).filter(Boolean)
  return entries
    .map((entry, index) => `${index + 1}. ${entry}${poison && entry === poison ? '  <-- CORE MODULE ROOT AHEAD OF 5.1 (README §1)' : ''}`)
    .join(' | ')
}
