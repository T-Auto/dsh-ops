/** Resolve only host-owned anchors; caller-selected descendants retain native no-follow checks. */
import type { SandboxExecutionPolicy } from './adapter/dsh/types.js'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

export function inside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export function canonicalAnchor(root: string): string {
  try { return fs.realpathSync.native(root) } catch { return path.resolve(root) }
}

/** Never realpath a model-selected parent or leaf, even if it already exists. */
export function anchoredPath(target: string, anchors: readonly string[]): string {
  const anchor = anchors.filter(root => inside(root, target)).sort((a, b) => b.length - a.length)[0]
  return anchor ? path.join(canonicalAnchor(anchor), path.relative(anchor, target)) : target
}

/** Explicit grants must name existing physical directories, matching DSH 0.2.2. */
export function additionalWriteRoots(policy: Pick<SandboxExecutionPolicy, 'additionalWritableRoots'>): string[] {
  return (policy.additionalWritableRoots ?? []).map(root => {
    const physical = fs.realpathSync.native(root)
    if (!fs.statSync(physical).isDirectory() || physical !== path.resolve(root)) {
      throw new Error(`SANDBOX_INVALID_ROOT: additional writable root must be an existing physical directory: ${JSON.stringify(root)}`)
    }
    return physical
  })
}

export function sessionAnchors(policy: Pick<SandboxExecutionPolicy, 'workspaceRoot' | 'additionalWritableRoots'>, cwd?: string): string[] {
  return [policy.workspaceRoot, ...additionalWriteRoots(policy), ...(cwd ? [cwd] : []), tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp'])]
}

/** Compare every host-owned authority field before admitting a prepared action. */
export function sameAuthority(left: SandboxExecutionPolicy, right: SandboxExecutionPolicy): boolean {
  return left.mode === right.mode && left.workspaceRoot === right.workspaceRoot
    && JSON.stringify(left.additionalWritableRoots ?? []) === JSON.stringify(right.additionalWritableRoots ?? [])
}

/** Trusted fixed file operations accept the workspace, explicit grants and private session temp. */
export function fileWriteRoots(policy: SandboxExecutionPolicy, privateTemp: string, cwd?: string): string[] {
  const anchors = sessionAnchors(policy, cwd)
  return [canonicalAnchor(policy.workspaceRoot), anchoredPath(privateTemp, anchors),
    ...additionalWriteRoots(policy)]
}
