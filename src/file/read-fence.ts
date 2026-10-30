/**
 * Path fencing for the in-process reader.
 *
 * Two distinct jobs live here:
 *
 *  - `resolveTarget` is the lexical fence. With a root it rejects `..` escapes and cross-drive
 *    absolute paths; without one it only validates components, because the caller already resolved
 *    and anchored the path against the DSH policy.
 *  - `fenceRealPath` re-checks the *real* path and hands it back, so the file that was inspected is
 *    the file that is opened. A junction inside the root produces a lexically-inside path that
 *    reads outside it; this is the only place that can see the difference.
 *
 * `assertParentDirs` / `startLeafCheck` cover the other direction: reparse points are refused rather
 * than followed (matching the native `open_nofollow`), with the directory chain cached per batch and
 * the leaf stat raced against `open`.
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { OpsError } from './read-types.js'

export const LINK_DENIED = 'Links, reparse points and special objects are not traversed; inspect the target path for the offending entry'

const RESERVED_NAMES = new Set(['CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$'])
const ILLEGAL_CHARS = /[:*?<>|"]/
// Fast reject: 99% of paths never reach the per-component walk.
const SUSPECT_PATH = /[:*?<>|"\u0000]|(^|[\\/])(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|[\\/]|$)|[. ][\\/]|[. ]$/i

/** Reject Windows device names, alternate data streams and trailing dots/spaces. */
export function validateName(name: string): void {
  if (name === '') return
  if (name.includes('\u0000')) throw new OpsError('INVALID_PATH', `Invalid path component ${JSON.stringify(name)}`)
  if (name === '.' || name === '..') return
  if (process.platform !== 'win32') return
  const base = name.split('.')[0]?.trimEnd().toUpperCase() ?? ''
  const port = base.startsWith('COM') || base.startsWith('LPT') ? base.slice(3) : null
  if (
    name.endsWith('.') || name.endsWith(' ')
    || ILLEGAL_CHARS.test(name)
    || RESERVED_NAMES.has(base)
    || (port !== null && /^[1-9¹²³]$/.test(port))
  ) {
    throw new OpsError('INVALID_PATH', `Reserved, ambiguous or device path component ${JSON.stringify(name)}`)
  }
}

export function validatePath(raw: string): void {
  let value = String(raw)
  // Verbatim forms are canonicalised by the native path layer; device paths are refused.
  if (value.startsWith('\\\\?\\')) {
    const rest = value.slice(4)
    if (/^UNC[\\/]/i.test(rest)) value = '\\\\' + rest.slice(4)
    else if (/^[A-Za-z]:/.test(rest)) value = rest
    else throw new OpsError('INVALID_PATH', 'Device and verbatim paths are unsupported')
  } else if (value.startsWith('\\\\.\\')) {
    throw new OpsError('INVALID_PATH', 'Device and verbatim paths are unsupported')
  }
  if (process.platform !== 'win32' || !SUSPECT_PATH.test(value)) return
  const parts = value.split(/[\\/]+/)
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index] as string
    if (index === 0 && /^[A-Za-z]:$/.test(part)) continue
    validateName(part)
  }
}

/** Lexical fence. `root` is opt-in: without it the caller's anchoring is authoritative. */
export function resolveTarget(filePath: string, root: string | null): string {
  validatePath(filePath)
  if (!root) return filePath
  const base = path.resolve(root)
  const target = path.resolve(base, filePath)
  const relative = path.relative(base, target)
  // Three shapes mean escape: '..', '..' + separator, or an absolute remainder (another drive).
  // An empty remainder is the root itself — let fstat report NOT_A_FILE instead of pretending.
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new OpsError('ESCAPE_ROOT', `Path escapes the root fence: ${filePath}`)
  }
  return target
}

/**
 * Re-resolve through the real path; the returned path is what must be opened.
 * `memo` keeps the root's own `realpath` to one call per batch.
 */
export async function fenceRealPath(target: string, root: string, memo?: { rootReal?: Promise<string> }): Promise<string> {
  if (memo && !memo.rootReal) {
    memo.rootReal = fsp.realpath(path.resolve(root))
    memo.rootReal.catch(() => {})
  }
  const realRoot = await (memo?.rootReal ?? fsp.realpath(path.resolve(root)))
  const realTarget = await fsp.realpath(target)
  const relative = path.relative(realRoot, realTarget)
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new OpsError('ESCAPE_ROOT', `Path escapes the root fence (reparse point): ${target}`)
  }
  return realTarget
}

/** Directory chain check. The cache stores the in-flight promise, not the result. */
function dirLinkCheck(dir: string, cache: Map<string, Promise<void>>): Promise<void> {
  let pending = cache.get(dir)
  if (!pending) {
    pending = fsp.lstat(dir).then((stat) => {
      if (stat.isSymbolicLink()) throw new OpsError('PATH_RESTRICTED', LINK_DENIED)
    })
    pending.catch(() => {})
    cache.set(dir, pending)
  }
  return pending
}

export async function assertParentDirs(target: string, cache: Map<string, Promise<void>>): Promise<void> {
  const dirs: string[] = []
  let dir = path.dirname(target)
  for (;;) {
    dirs.push(dir)
    if (cache.has(dir)) break
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  await Promise.all(dirs.map((entry) => dirLinkCheck(entry, cache)))
}

/** Leaf check started alongside `open`; the caller awaits it after the handle exists. */
export function startLeafCheck(target: string): Promise<import('node:fs').Stats> {
  const pending = fsp.lstat(target)
  pending.catch(() => {})
  return pending
}
