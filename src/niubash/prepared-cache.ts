/** Version-level prepared runtime cleanup, never command-lifetime cleanup. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const PREPARED_NAME = /^[a-f0-9]{64}(?:\.(?:broken|stage|retired)-[A-Za-z0-9-]+)*$/u

/** Only our exact version namespace and real directories are cleanup candidates. */
export function preparedNiubashEntries(current: string): string[] {
  const parent = path.dirname(current)
  try {
    const root = fs.lstatSync(parent)
    if (!root.isDirectory() || root.isSymbolicLink()) return []
    return fs.readdirSync(parent, { withFileTypes: true })
      .filter(entry => entry.name !== path.basename(current) && PREPARED_NAME.test(entry.name)
        && entry.isDirectory() && !entry.isSymbolicLink())
      .map(entry => path.join(parent, entry.name))
  } catch { return [] }
}

/** Rename a live name once before deletion: a Windows image/sharing lock refuses it and leaves the
 * sibling for the next host start. A `.retired-` name is already out of use and is removed in place:
 * renaming it again while another process deletes it splits one tree across two names, and
 * `rmSync` with `force` reports success for the half it no longer finds.
 */
export function retirePreparedNiubash(directory: string): boolean {
  const name = path.basename(directory)
  if (!PREPARED_NAME.test(name)) return false
  let retired = directory
  try {
    const info = fs.lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) return false
    if (!/\.retired-[A-Za-z0-9-]+$/u.test(name)) {
      retired = `${directory}.retired-${randomUUID()}`
      fs.renameSync(directory, retired)
    }
  } catch { return false }
  try { fs.rmSync(retired, { recursive: true, force: true }); return true }
  catch { return false }
}

/** The first successful preparation in a process keeps only its current version; busy siblings never fail it. */
export function reclaimPreparedNiubash(current: string): void {
  const hash = path.basename(current)
  for (const directory of preparedNiubashEntries(current)) {
    const name = path.basename(directory)
    // Another pin may still be building; only our own hash's staging losers are online garbage.
    if (name.slice(0, 64) !== hash && name.slice(64).startsWith('.stage-')) continue
    retirePreparedNiubash(directory)
  }
}
