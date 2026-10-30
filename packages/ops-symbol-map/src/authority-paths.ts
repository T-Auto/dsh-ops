/** Resolve only host-owned anchors; caller-selected descendants retain native no-follow checks. */
import type { SandboxExecutionPolicy } from './adapter/dsh/types.js'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

export function inside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/**
 * How long a resolved anchor is trusted.
 *
 * The anchors are host-owned (workspace root, session cwd, tmp), so nothing a caller passes can
 * change them — but a directory can be re-pointed by a junction or a mount between calls, which is
 * the one way a memoised value goes stale without its input changing. Five seconds bounds that
 * window the same way the credential fence bounds its own root list, and {@link resetAnchorCache}
 * drops it outright.
 */
const ANCHOR_TTL_MS = 5_000

/** Ceiling on the memo. Anchors are a handful per session; this only stops a pathological caller. */
const ANCHOR_CACHE_MAX = 64

interface AnchorEntry { value: string, at: number }

const anchors = new Map<string, AnchorEntry>()

/** Drop the memoised anchor resolutions. Tests use it; a host may call it after moving a root. */
export function resetAnchorCache(): void {
  anchors.clear()
}

/**
 * The canonical spelling of a host-owned anchor.
 *
 * `realpathSync.native` is the single most expensive call on the file-tool hot path — measured at
 * 0.07 ms on Windows, which is more than the rest of a warm `symbol_map` call put together, and it
 * is paid on every anchored read of every file tool. The result only depends on the root, so it is
 * resolved once per root per {@link ANCHOR_TTL_MS} instead of once per call.
 *
 * A failed resolution is cached too: a workspace root that does not exist yet resolves to its
 * absolute form, and re-probing it on every call would cost the same 0.07 ms to learn nothing.
 */
export function canonicalAnchor(root: string): string {
  const now = Date.now()
  const cached = anchors.get(root)
  if (cached !== undefined && now - cached.at < ANCHOR_TTL_MS) return cached.value
  let value: string
  try { value = fs.realpathSync.native(root) } catch { value = path.resolve(root) }
  if (anchors.size >= ANCHOR_CACHE_MAX) anchors.clear()
  anchors.set(root, { value, at: now })
  return value
}

/**
 * Never realpath a model-selected parent or leaf, even if it already exists.
 *
 * Only the *anchor* is canonicalised: the part below it is joined verbatim, so a symlink the
 * caller planted inside the workspace is still followed by the OS at open time rather than being
 * silently rewritten here.
 */
export function anchoredPath(target: string, anchors: readonly string[]): string {
  const anchor = anchors.filter(root => inside(root, target)).sort((a, b) => b.length - a.length)[0]
  return anchor ? path.join(canonicalAnchor(anchor), path.relative(anchor, target)) : target
}

export function sessionAnchors(policy: Pick<SandboxExecutionPolicy, 'workspaceRoot'>, cwd?: string): string[] {
  return [policy.workspaceRoot, ...(cwd ? [cwd] : []), tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp'])]
}
