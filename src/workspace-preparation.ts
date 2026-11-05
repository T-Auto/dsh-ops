/** Prepare the host's Windows ACL prerequisite before native or PTC execution.
 * No monkey-patching host services; only the selected, owned workspace gains
 * directory-only WRITE_OWNER. The DSH provider still owns confinement/grants.
 */
import fs from 'node:fs'
import type { Context } from './adapter/dsh/types.js'
import type { SandboxExecutionPolicy } from './adapter/dsh/types.js'
import type { SpawnOptionsWithStdioTuple, StdioNull, StdioPipe } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
const script = fileURLToPath(new URL('../bin/prepare-workspace.ps1', import.meta.url))
const pending = new Map<string, Promise<void>>()
const prepared = new Set<string>()
/** Whether the given path, or any ancestor of it, is a reparse point (junction or symlink).
 * Judged on the path as given, never on its resolved form: resolving first hides a link above the
 * root, and an 8.3 short name resolves to its long form without any link being involved.
 */
function traversesReparsePoint(target: string) {
  for (let current = path.resolve(target);; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) return true
    const parent = path.dirname(current)
    if (parent === current) return false
  }
}
export function prepareWorkspace(policy: Pick<SandboxExecutionPolicy, 'mode' | 'workspaceRoot'> | undefined, { platform = process.platform, run = runPreparation }: { platform?: NodeJS.Platform; run?: (root: string) => void | Promise<void> } = {}): Promise<void> {
  if (platform !== 'win32' || policy?.mode !== 'workspace-write') return Promise.resolve()
  if (typeof policy.workspaceRoot !== 'string' || !path.isAbsolute(policy.workspaceRoot)) return Promise.reject(new Error('Invalid authoritative workspace root'))
  const root = fs.realpathSync.native(policy.workspaceRoot)
  // Do not silently resolve a link selected as the authority root: the authority would be a
  // directory the caller did not name. Ask that question directly instead of comparing the given
  // path with its resolved form, which also rejects an 8.3 short name (a second spelling of the
  // same directory) and any other difference realpath happens to normalise away.
  if (traversesReparsePoint(policy.workspaceRoot)) {
    return Promise.reject(new Error('Workspace root must not resolve through a junction or symlink'))
  }
  if (prepared.has(root)) return Promise.resolve()
  if (!pending.has(root)) {
    const work = Promise.resolve().then(() => run(root)).then(() => { prepared.add(root) }).finally(() => { pending.delete(root) })
    pending.set(root, work)
  }
  return pending.get(root)!
}
/** Safety net only: the root DACL write no longer scales with workspace size (#43). */
export const PREPARATION_TIMEOUT_MS = 120_000
const FAILED = 'DSH workspace preparation failed'
// Locale-independent markers PowerShell prints when execution policy refuses a script file.
const EXECUTION_POLICY = /about_Execution_Policies|UnauthorizedAccess|PSSecurityException/i
// A folder owned by another account is usable when it already grants WRITE_OWNER; preparation
// refuses only when the ACE still has to be added, and that reason is reported separately (#651).
const OWNER_MISMATCH = /Workspace is not owned by the current user/i
// bin/prepare-workspace.ps1's other refusals, plus a denied DACL write: the folder lacks the prerequisite.
const PREREQUISITE = /reparse point|Explicit effective denial of WRITE_OWNER|is not a directory|WRITE_OWNER verification failed|Access is denied|0x80070005/i
/** Name the cause of a failed preparation run, so a policy, a folder and an executor problem read differently (#66). */
export function classifyPreparationFailure(output: string, { root, script: file = script }: { root?: string; script?: string } = {}) {
  const tail = output.trim() || '(no output)'
  if (/DSH_OPS_CONSTRAINED_LANGUAGE|ConstrainedLanguage|CannotDefineNewType/i.test(output)) {
    return `PowerShell ConstrainedLanguage prevents the trusted workspace ACL preparation script from using required identity and DACL APIs; no ACL preparation was completed. Keep the host security policy enabled and ask its administrator for a supported preparation path. OPS has not changed the session permission mode. Output: ${tail}`
  }
  if (EXECUTION_POLICY.test(output)) {
    return `PowerShell execution policy blocked dsh-ops's own preparation script ${file} even with -ExecutionPolicy Bypass, so the policy comes from Group Policy (MachinePolicy/UserPolicy). Ask an administrator, check \`powershell.exe -NoProfile -Command Get-ExecutionPolicy -List\`, or use danger-full-access for this session (it skips preparation). Output: ${tail}`
  }
  if (OWNER_MISMATCH.test(output)) {
    const reason = output.split(/\r?\n/).map(line => line.trim()).find(line => OWNER_MISMATCH.test(line)) ?? tail
    return `the workspace root ${root} is not owned by the current user and does not already grant the host's WRITE_OWNER prerequisite, so automatic ACL preparation left it unchanged: ${reason.replace(/\.?$/, '.')} This is a folder permission problem, not a DSH authorization denial.`
  }
  if (PREREQUISITE.test(output)) {
    const reason = output.split(/\r?\n/).map(line => line.trim()).find(line => PREREQUISITE.test(line)) ?? tail
    return `the workspace root ${root} does not meet the sandbox prerequisite (the host needs WRITE_OWNER on it): ${reason.replace(/\.?$/, '.')} Fix the folder's owner or permissions, open a workspace you own, or use danger-full-access. This is a folder permission problem, not a DSH authorization denial.`
  }
  return undefined
}
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
export function preparationEnvironment(source: NodeJS.ProcessEnv = process.env) {
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
export function preparationSpawnSpec(root: string): { executable: string; args: string[]; options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe> } {
  const windows = process.env.SystemRoot ?? 'C:\\Windows'
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const backups = path.join(home, 'dsh-ops/acl-backups')
  return {
    executable: path.join(windows, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    // Our own trusted bootstrap: execution policy is no security boundary for it, and the Windows
    // client default (Restricted) would otherwise block every shell tool (#66). Group Policy still wins.
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Workspace', root, '-BackupDir', backups],
    options: { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: preparationEnvironment() },
  }
}
export function runPreparation(root: string, { executable, args, timeoutMs = PREPARATION_TIMEOUT_MS }: { executable?: string; args?: string[]; timeoutMs?: number } = {}): Promise<void> {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const backups = path.join(home, 'dsh-ops/acl-backups')
  const spec = preparationSpawnSpec(root)
  executable ??= spec.executable
  args ??= spec.args
  return new Promise<void>((resolve, reject) => {
    const started = Date.now()
    // `spec.options` carries the scrubbed `env`; callers may override executable/args (the suites
    // do), but the environment the interpreter inherits is this module's decision.
    const child = spawn(executable, args, spec.options)
    let stdout = '', stderr = '', timedOut = false
    child.stdout.on('data', b => { stdout = (stdout + b.toString()).slice(-2048) })
    child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-2048) })
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
    child.once('error', error => { clearTimeout(timer); reject(new Error(`${FAILED}: the preparation executor could not start ${executable}: ${error.message}`)) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0 && !timedOut) return resolve()
      // Never end the message at the colon: a killed child has written nothing yet.
      const detail = timedOut
        ? `the preparation executor timed out after ${timeoutMs} ms preparing ${root}; the workspace ACL state is unknown and the backup receipt is under ${backups}.`
        : classifyPreparationFailure(`${stderr}\n${stdout}`, { root })
          ?? `exited with ${code === null ? `signal ${signal}` : `code ${code}`} after ${Date.now() - started} ms preparing ${root}: ${stderr.trim() || stdout.trim() || '(no output)'}`
      reject(new Error(`${FAILED}: ${detail}`))
    })
  })
}
export function mountWorkspacePreparation(root: Context) {
  if (process.platform !== 'win32') return
  root.inject(['sandboxPolicy', 'tools'], ctx => {
    // Execute-stage hook: user approval/guards have already accepted the call.
    ctx.on('tools/execute', async (exec, next) => {
      const session = exec?.agent?.session
      if (session && ['run_code', 'pwsh', 'bash', 'pwsh_persistent', 'bash_persistent'].includes(exec.name)) {
        await prepareWorkspace(ctx.get('sandboxPolicy')!.resolve({ session }))
      }
      return next()
    })
  })
}
