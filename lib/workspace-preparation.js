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
function runPreparation(root) {
  const windows = process.env.SystemRoot ?? 'C:\\Windows'
  const executable = path.join(windows, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const backups = path.join(home, 'dsh-ops/acl-backups')
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-File', script, '-Workspace', root, '-BackupDir', backups], { windowsHide: true, stdio: ['ignore','pipe','pipe'] })
    let stderr = ''
    child.stdout.resume()
    child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-2048) })
    const timer = setTimeout(() => child.kill(), 10000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`DSH workspace preparation failed (not a user permission denial): ${stderr.trim()}`)) })
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
