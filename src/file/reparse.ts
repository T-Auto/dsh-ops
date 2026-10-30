/**
 * Reparse-point refusal for the in-process file tools.
 *
 * The native worker opens every path with `open_nofollow`, so a symlink or a directory junction
 * planted inside the workspace is never traversed. An in-process reader that calls
 * `fs.readFileSync(name)` has no such protection: `ws/link/leak.ts` is lexically inside the
 * workspace, passes the credential fence (the *name* carries no credential), passes the
 * workspace anchor, and then the OS resolves `link` to somewhere else.
 *
 * One `lstat` per path component is what the native side pays as well, but only *below* the
 * anchor: the anchors themselves are host-owned and already canonicalised by `anchoredPath`, and
 * a host whose profile directory is itself a junction must keep working.
 *
 * @module dsh-ops/file/reparse
 */
import fs from 'node:fs'
import path from 'node:path'

/** Message shape shared with the native worker, so a caller sees one wording for one refusal. */
export const REPARSE_DENIED =
  'Links, reparse points and special objects are not traversed; inspect the target path for the offending entry'

/**
 * The first component at or below `abs` that is a reparse point, or `undefined`.
 *
 * Stops at the volume root, or at the first entry of `stops` (inclusive: the anchor itself is
 * checked, its parents are not). A path that does not exist returns `undefined` so the read can
 * report `NOT_FOUND` instead of borrowing a policy code for a missing file.
 */
export function reparseEscape(abs: string, stops: readonly string[] = []): string | undefined {
  const halt = new Set(
    stops.filter((entry): entry is string => typeof entry === 'string' && entry !== '').map((entry) => path.resolve(entry).toLowerCase()),
  )
  let current = path.resolve(abs)
  for (;;) {
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(current)
    } catch {
      return undefined
    }
    if (stat.isSymbolicLink()) return current
    if (halt.has(current.toLowerCase())) return undefined
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}
