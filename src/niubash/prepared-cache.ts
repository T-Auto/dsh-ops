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

/** Rename once before deletion. A Windows image/sharing lock leaves the sibling for next selection. */
export function retirePreparedNiubash(directory: string): boolean {
  if (!PREPARED_NAME.test(path.basename(directory))) return false
  const retired = `${directory}.retired-${randomUUID()}`
  try {
    const info = fs.lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) return false
    fs.renameSync(directory, retired)
  } catch { return false }
  try { fs.rmSync(retired, { recursive: true, force: true }); return true }
  catch { return false }
}

/** A successful selection keeps only its current version; busy siblings never fail selection. */
export function reclaimPreparedNiubash(current: string): void {
  const hash = path.basename(current)
  for (const directory of preparedNiubashEntries(current)) {
    const name = path.basename(directory)
    // Another pin may still be building; only our own hash's staging losers are online garbage.
    if (name.slice(0, 64) !== hash && name.slice(64).startsWith('.stage-')) continue
    retirePreparedNiubash(directory)
  }
}
