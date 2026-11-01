/**
 * Path safety for the reader: component validation, the optional root fence, and link refusal.
 *
 * Three separate jobs, all of which exist because Windows resolves some names to *devices* rather than
 * files — `NUL` reads as empty, `CON` blocks waiting for input, `x.txt:stream` is an alternate data stream
 * that no directory listing shows. For an agent, "read something that does not exist" and "read something
 * you cannot see" are both silent errors, so all of them are refused.
 *
 * The lexical fence (`resolve` + `relative`) cannot see through a symlink or junction: a junction inside
 * the root produces `link/secret.txt`, which looks contained and reads outside. So the fence has a second
 * half that re-checks the real path — and opens the *real* path, because the thing checked and the thing
 * opened must be the same object.
 *
 * @module dsh-ops/file/reader/path-safety
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'

import { OpsError, type ReadOptions } from './core.cjs'

const RESERVED_NAMES = new Set(['CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$'])
const ILLEGAL_CHARS = /[:*?<>|"]/

/** The message a link refusal carries; the caller surfaces it verbatim. */
export const LINK_DENIED = 'Links, reparse points and special objects are not traversed; inspect the target path for the offending entry'

/** The memo a batch shares: the root's real path and the directory link checks. */
export interface ReaderMemo extends ReadOptions {
  rootReal?: Promise<string>
  linkCache?: Map<string, Promise<void>>
}

/** Refuse one path component that Windows would resolve to a device, or that is ambiguous. */
export function validateName(name: string): void {
  if (name === '') return
  if (name.includes('\u0000')) throw new OpsError('INVALID_PATH', `Invalid path component ${JSON.stringify(name)}`)
  if (name === '.' || name === '..') return
  if (process.platform !== 'win32') return
  const base = name.split('.')[0].trimEnd().toUpperCase()
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

/**
 * A fast negative: 99% of paths are dismissed by this one regex, with no split and no per-component work.
 * Anything that looks suspicious takes the slow path, which is the one that names the offending component.
 */
const SUSPECT_PATH = /[:*?<>|"\u0000]|(^|[\\/])(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|[\\/]|$)|[. ][\\/]|[. ]$/i

/** Validate every component; a drive letter passes as the first one. */
export function validatePath(raw: string): void {
  let value = String(raw)
  // Long-path handling produces verbatim forms: `\\?\K:\...` and `\\?\UNC\srv\shr\...`. The original
  // normalizes and accepts those, and refuses `\\.\` (device) outright — this follows it.
  if (value.startsWith('\\\\?\\')) {
    const rest = value.slice(4)
    if (/^UNC[\\/]/i.test(rest)) value = `\\\\${rest.slice(4)}`
    else if (/^[A-Za-z]:/.test(rest)) value = rest
    else throw new OpsError('INVALID_PATH', 'Device and verbatim paths are unsupported')
  } else if (value.startsWith('\\\\.\\')) {
    throw new OpsError('INVALID_PATH', 'Device and verbatim paths are unsupported')
  }
  if (process.platform !== 'win32' || !SUSPECT_PATH.test(value)) return
  const parts = value.split(/[\\/]+/)
  for (let i = 0; i < parts.length; i += 1) {
    if (i === 0 && /^[A-Za-z]:$/.test(parts[i])) continue
    validateName(parts[i])
  }
}

/**
 * The opt-in root fence.
 *
 * With a root, relative paths resolve against it and absolute paths must stay inside it; escaping returns
 * `ESCAPE_ROOT` instead of leaving the check to the caller.
 */
export function resolveTarget(filePath: string, root?: string | null): string {
  validatePath(filePath)
  if (!root) return filePath
  const base = path.resolve(root)
  const target = path.resolve(base, filePath)
  const rel = path.relative(base, target)
  // Three shapes mean "outside": '..', '..' plus a separator, or an absolute path (a different drive).
  // An empty rel means the target *is* the root — that is inside, so it falls through to fstat and
  // reports NOT_A_FILE rather than lying with ESCAPE_ROOT. `startsWith('..')` alone would be wrong:
  // a legitimate child named '..foo' yields rel='..foo' and would be killed as an escape.
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new OpsError('ESCAPE_ROOT', `path escapes the root fence: ${filePath}`)
  }
  return target
}

/**
 * Re-check the fence against the real path.
 *
 * The root's realpath is computed once per batch and memoized on the options object; a single file then
 * costs one extra syscall.
 */
export async function fenceRealPath(target: string, root: string, opts: ReaderMemo): Promise<string> {
  if (!opts.rootReal) {
    opts.rootReal = fsp.realpath(path.resolve(root))
    opts.rootReal.catch(() => { /* a failure must not become an unhandled rejection; the next call retries */ })
  }
  const realRoot = await opts.rootReal
  const realTarget = await fsp.realpath(target)
  const rel = path.relative(realRoot, realTarget)
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new OpsError('ESCAPE_ROOT', `path escapes the root fence (a reparse point points outside): ${target}`)
  }
  return realTarget
}

/**
 * One directory in the chain.
 *
 * The cache holds the *pending promise*, not a boolean: with 20 files in one directory, a boolean cache
 * still lets all 20 lstat the same chain before the first one fills it (measured 20×5 = 100 calls);
 * caching the promise costs the batch 5 calls in total.
 */
export function dirLinkCheck(dir: string, cache: Map<string, Promise<void>>): Promise<void> {
  let pending = cache.get(dir)
  if (!pending) {
    pending = fsp.lstat(dir).then(stats => {
      if (stats.isSymbolicLink()) throw new OpsError('PATH_RESTRICTED', LINK_DENIED)
    })
    // The main flow may already have failed and walked away; a rejection nobody awaits must not bubble.
    pending.catch(() => {})
    cache.set(dir, pending)
  }
  return pending
}

/** Check the whole directory chain up to the drive root, using the batch cache. */
export async function assertParentDirs(target: string, opts: ReaderMemo): Promise<void> {
  const cache = opts.linkCache ?? (opts.linkCache = new Map<string, Promise<void>>())
  const dirs: string[] = []
  let dir = path.dirname(target)
  for (;;) {
    dirs.push(dir)
    if (cache.has(dir)) break
    const up = path.dirname(dir)
    if (up === dir) break // the drive root still gets checked
    dir = up
  }
  await Promise.all(dirs.map(entry => dirLinkCheck(entry, cache)))
}

/**
 * The leaf check, started concurrently with `open` so it costs no wall-clock time.
 *
 * `open` already needs a syscall; the lstat lands in the same window. If the handle came back and the
 * lstat then says "link", the caller closes the handle and throws.
 */
export function startLeafCheck(target: string): ReturnType<typeof fsp.lstat> {
  const pending = fsp.lstat(target)
  pending.catch(() => { /* the main flow may throw first */ })
  return pending
}
