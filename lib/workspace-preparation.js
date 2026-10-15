/** Prepare the host's Windows ACL prerequisite before native or PTC execution.
 * No monkey-patching host services; only the selected, owned workspace gains
 * directory-only WRITE_OWNER. The DSH provider still owns confinement/grants.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
const script = fileURLToPath(new URL('../bin/prepare-workspace.ps1', import.meta.url))
const pending = new Map()
const prepared = new Set()
export function prepareWorkspace(policy, { platform = process.platform, run = runPreparation } = {}) {
  if (platform !== 'win32' || policy?.mode !== 'workspace-write') return Promise.resolve()
  if (!path.isAbsolute(policy.workspaceRoot ?? '')) return Promise.reject(new Error('Invalid authoritative workspace root'))
  const root = fs.realpathSync.native(policy.workspaceRoot)
  // Do not silently resolve a link selected as the authority root.
  if (path.normalize(root).toLowerCase() !== path.resolve(policy.workspaceRoot).toLowerCase()) {
    return Promise.reject(new Error('Workspace root must not resolve through a junction or symlink'))
  }
  if (prepared.has(root)) return Promise.resolve()
  if (!pending.has(root)) {
    const work = Promise.resolve().then(() => run(root)).then(() => { prepared.add(root) }).finally(() => { pending.delete(root) })
    pending.set(root, work)
  }
  return pending.get(root)
}
/** Safety net only: the root DACL write no longer scales with workspace size (#43). */
export const PREPARATION_TIMEOUT_MS = 120_000
const FAILED = 'DSH workspace preparation failed (not a user permission denial)'
/**
 * The environment the preparation interpreter is allowed to inherit.
 *
 * `PSModulePath` is dropped rather than passed through, because the interpreter this module
 * hardcodes is Windows PowerShell 5.1 while a DSH host normally runs under PowerShell 7. Starting
 * up, pwsh 7 publishes its own module directories into the variable — `<ProgramFiles>\PowerShell\7\
 * Modules` among them — and `Microsoft.PowerShell.Security` exists in both trees. 5.1 reads the
 * variable in order, resolves the .NET Core copy first, fails to load it (its extended type data
 * collides with the inbox copy already loaded), and is left with neither `Get-Acl` nor `Set-Acl`.
 * `bin/prepare-workspace.ps1` then dies at its first cmdlet with `CommandNotFoundException`, before
 * it inspects or writes a single ACL, and every shell tool fails behind it. With the variable
 * absent, 5.1 rebuilds its own default path from `$PSHOME\Modules` plus the machine and user values,
 * and the inbox module loads.
 *
 * Only that one variable is removed: PATH, SystemRoot and DSH_HOME are the child's own inputs and
 * stay exactly as the host set them.
 * @param {NodeJS.ProcessEnv} [source] - the environment to derive from.
 * @returns {NodeJS.ProcessEnv} a copy without the inherited module search path.
 */
export function preparationEnvironment(source = process.env) {
  const env = { ...source }
  delete env.PSModulePath
  return env
}
/**
 * The exact spawn specification the preparation interpreter is launched with.
 *
 * Extracted as a pure function so the **call site** is directly assertable: an assertion on
 * `preparationEnvironment()` alone cannot catch a regression that passes `process.env` straight to
 * `spawn` — verified by mutation, which the earlier suite did not catch (nothing covered the spawn
 * arguments).
 * @param {string} root - the authoritative workspace root.
 * @returns {{executable: string, args: string[], options: object}}
 */
export function preparationSpawnSpec(root) {
  const windows = process.env.SystemRoot ?? 'C:\\Windows'
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const backups = path.join(home, 'dsh-ops/acl-backups')
  return {
    executable: path.join(windows, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-File', script, '-Workspace', root, '-BackupDir', backups],
    options: { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: preparationEnvironment() },
  }
}
export function runPreparation(root, { executable, args, timeoutMs = PREPARATION_TIMEOUT_MS } = {}) {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const backups = path.join(home, 'dsh-ops/acl-backups')
  const spec = preparationSpawnSpec(root)
  executable ??= spec.executable
  args ??= spec.args
  return new Promise((resolve, reject) => {
    const started = Date.now()
    // `spec.options` carries the scrubbed `env`; callers may override executable/args (the suites
    // do), but the environment the interpreter inherits is this module's decision.
    const child = spawn(executable, args, spec.options)
    let stdout = '', stderr = '', timedOut = false
    child.stdout.on('data', b => { stdout = (stdout + b.toString()).slice(-2048) })
    child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-2048) })
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
    child.once('error', error => { clearTimeout(timer); reject(new Error(`${FAILED}: could not start ${executable}: ${error.message}`)) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0 && !timedOut) return resolve()
      // Never end the message at the colon: a killed child has written nothing yet.
      const detail = timedOut
        ? `timed out after ${timeoutMs} ms preparing ${root}; the workspace ACL state is unknown and the backup receipt is under ${backups}.`
        : `exited with ${code === null ? `signal ${signal}` : `code ${code}`} after ${Date.now() - started} ms preparing ${root}: ${stderr.trim() || stdout.trim() || '(no output)'}`
      reject(new Error(`${FAILED}: ${detail}`))
    })
  })
}
export function mountWorkspacePreparation(root) {
  if (process.platform !== 'win32') return
  root.inject(['sandboxPolicy', 'tools'], ctx => {
    // Execute-stage hook: user approval/guards have already accepted the call.
    ctx.on('tools/execute', async (exec, next) => {
      const session = exec?.agent?.session
      if (session && ['run_code', 'pwsh', 'bash', 'pwsh_persistent', 'bash_persistent'].includes(exec.name)) {
        await prepareWorkspace(ctx.get('sandboxPolicy').resolve({ session }))
      }
      return next()
    })
  })
}
