/** Compatibility cleanup for payloads sealed by 0.5.0–0.5.2; never used by command execution. */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** Remove the legacy Everyone deny ACE and READONLY attributes before replacement/deletion.
 * Failures surface through the subsequent filesystem operation.
 */
export function unsealDirectorySync(directory: string, options: { platform?: NodeJS.Platform } = {}): void {
  let stat: fs.Stats
  try { stat = fs.lstatSync(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return
  if ((options.platform ?? process.platform) === 'win32') {
    spawnSync('icacls.exe', [directory, '/remove:d', '*S-1-1-0', '/T', '/C', '/Q'], { windowsHide: true, stdio: 'ignore' })
  }
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) walk(file)
      if (entry.isFile()) {
        const mode = fs.lstatSync(file).mode
        if ((mode & 0o200) === 0) fs.chmodSync(file, mode | 0o200)
      }
    }
  }
  walk(directory)
}
