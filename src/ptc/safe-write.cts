/**
 * Atomic, checked replacement of a file's bytes.
 *
 * The contract is narrow on purpose: the caller has already produced the new bytes, and this module
 * refuses to publish them unless the file it read during planning is still the file on disk. The lock
 * file makes two concurrent PTC writers fail loudly instead of last-write-wins.
 *
 * @module dsh-ops/ptc/safe-write
 */

import { chmodSync, closeSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

/** A refusal raised by this module carries one of these codes. */
type SafeWriteCode = 'E_INPROC_FILE_TYPE' | 'E_INPROC_CHANGED' | 'E_INPROC_UNRESOLVED_PLACEHOLDER' | 'E_INPROC_LOCKED'

/** Node's own errno shape; the lock branch needs `.code` off a thrown `fs` error. */
type ErrnoLike = Error & { code?: string }

/** What a successful write reports: cleanup failures that did not stop the publish. */
export interface CheckedWriteResult {
  cleanupErrors: string[]
}

/**
 * Refuse to touch anything that is not a lone regular file.
 *
 * Symlinks and hard links are rejected rather than followed: rewriting the target behind a link is a
 * different operation with a different blast radius, and a hard link means the bytes are shared with a
 * file this engine was never asked about.
 */
export function verifySnapshot(file: string, expected: Buffer): void {
  const stats = lstatSync(file)
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink > 1) {
    throw Object.assign(new Error(`refusing to replace a non-regular file or hard link: ${file}`), { code: 'E_INPROC_FILE_TYPE' satisfies SafeWriteCode })
  }
  if (!readFileSync(file).equals(expected)) {
    throw Object.assign(new Error(`the file changed while it was being audited: ${file}`), { code: 'E_INPROC_CHANGED' satisfies SafeWriteCode })
  }
}

/**
 * An ast-grep template placeholder landing in an identifier position means the rewrite was never
 * parsed and the raw pattern text was written back.
 *
 * This gate is the scar from a real incident: seven functions in `proc.js` were rewritten into
 * `function safeStr($$$) { try {`, flattened onto one line with `async` dropped, and the module failed
 * to load. A placeholder can only legitimately appear inside a string literal (the pattern array), so
 * finding one in a declaration name or a parameter position is contamination that cannot overlap any
 * valid source.
 */
const PLACEHOLDER_LEAK = /function\s+\$\$\$|class\s+\$\$\$|=>\s*\$\$\$|\(\s*\$\$\$\s*[,)]|(?:const|let|var)\s+\$\$\$\s*=/

/** Reject a rewrite whose text still contains an unresolved ast-grep placeholder. */
function assertResolved(file: string, after: string): void {
  if (PLACEHOLDER_LEAK.test(after)) {
    throw Object.assign(new Error(`the rewrite still contains an unresolved ast-grep placeholder ($$$): ${file}`), { code: 'E_INPROC_UNRESOLVED_PLACEHOLDER' satisfies SafeWriteCode })
  }
}

/** Write `after` over `file`, but only if the file still holds `expected`. */
export function checkedWrite(file: string, expected: Buffer, after: string): CheckedWriteResult {
  assertResolved(file, after)
  const lock = `${file}.ops-ptc.lock`
  const temp = `${file}.inproc-${randomUUID()}.tmp`

  let lockFd: number | undefined
  let tempFd: number | undefined
  let ownsTemp = false
  let failure: unknown
  const cleanupErrors: string[] = []

  const cleanup = (action: () => void): void => {
    try {
      action()
    } catch (error) {
      const problem = error as ErrnoLike
      cleanupErrors.push(`${problem.code ?? 'E_CLEANUP'}: ${problem.message ?? String(error)}`)
    }
  }

  try {
    lockFd = openSync(lock, 'wx', 0o600)
    verifySnapshot(file, expected)
    const mode = lstatSync(file).mode & 0o777
    tempFd = openSync(temp, 'wx', mode)
    ownsTemp = true
    writeFileSync(tempFd, after, 'utf8')
    closeSync(tempFd)
    tempFd = undefined
    chmodSync(temp, mode)
    // Second check: the lock only excludes other PTC writers, not an editor or another process.
    verifySnapshot(file, expected)
    renameSync(temp, file)
    ownsTemp = false
  } catch (error) {
    const problem = error as ErrnoLike
    failure = lockFd === undefined && problem.code === 'EEXIST'
      ? Object.assign(new Error(`another ops-ptc write is holding this file: ${file}`), { code: 'E_INPROC_LOCKED' satisfies SafeWriteCode })
      : error
    throw failure
  } finally {
    if (tempFd !== undefined) cleanup(() => closeSync(tempFd as number))
    if (ownsTemp) cleanup(() => unlinkSync(temp))
    if (lockFd !== undefined) {
      cleanup(() => closeSync(lockFd as number))
      cleanup(() => unlinkSync(lock))
    }
    if (failure && typeof failure === 'object' && cleanupErrors.length) {
      try {
        Object.assign(failure, { cleanupErrors })
      } catch { /* the original failure is the one worth reporting */ }
    }
  }

  return { cleanupErrors }
}
