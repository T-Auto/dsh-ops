/** Narrow Windows/WSL translations. File contents and opaque native cursors are never rewritten. */
import path from 'node:path'
import { createHash } from 'node:crypto'
import { record } from './boundary.js'

export function wslPath(value: string): { distro: string; root: string; file: string } | undefined {
  const normalized = path.win32.normalize(value).replace(/^\\\\\?\\UNC\\/i, '\\\\')
  const match = /^\\\\(wsl\.localhost|wsl\$)\\([A-Za-z0-9][A-Za-z0-9._-]{0,63})(\\.*)?$/i.exec(normalized)
  if (!match) return undefined
  return { distro: match[2], root: `\\\\${match[1]}\\${match[2]}`, file: (match[3] ?? '\\').replaceAll('\\', '/') }
}
export function windowsDrive(value: string): string | undefined {
  const normalized = path.win32.normalize(value).replace(/^\\\\\?\\/, '')
  return /^[A-Za-z]:\\/.test(normalized) ? normalized.slice(0, 2).toUpperCase() : undefined
}
export function linuxPath(value: string, distro: string, drives: ReadonlyMap<string, string>): string | undefined {
  const unc = wslPath(value)
  if (unc) return unc.distro.toLowerCase() === distro.toLowerCase() ? unc.file : undefined
  const drive = windowsDrive(value), root = drive && drives.get(drive)
  if (!drive || !root) return undefined
  const tail = path.win32.relative(`${drive}\\`, value).replaceAll('\\', '/')
  if (tail.startsWith('../') || path.win32.isAbsolute(tail)) return undefined
  return path.posix.join(root, tail)
}
export function cursorIdentity(distro: string, digest: string): string {
  return createHash('sha256').update(JSON.stringify(['wsl1', distro.toLowerCase(), digest, 'windows-paths'])).digest('hex').slice(0, 32)
}
export function unwrapCursor(value: unknown, identity: string): string | undefined {
  if (typeof value !== 'string' || value.length > 254 || !value.startsWith(`w1:${identity}:`)) return undefined
  const inner = value.slice(36)
  return /^s1:[a-f0-9]{64}:[a-f0-9]{64}:[0-9]{1,20}:[a-f0-9]{64}$/.test(inner) ? inner : undefined
}
export function wrapCursor(value: string, identity: string): string {
  const wrapped = `w1:${identity}:${value}`
  if (!unwrapCursor(wrapped, identity)) throw new Error('Unsupported native WSL cursor')
  return wrapped
}
/** Only documented path slots are converted; grep text can contain arbitrary POSIX paths. */
export function windowsResult(value: Record<string, unknown>, uncRoot: string, tool: string): Record<string, unknown> {
  const convert = (item: unknown): unknown => {
    if (!record(item)) return item
    return { ...item, ...(typeof item.path === 'string' ? { path: toWindows(item.path) } : {}),
      ...(Array.isArray(item.items) ? { items: item.items.map(convert) } : {}) }
  }
  const toWindows = (file: string) => {
    if (!file.startsWith('/') || file.includes('\\') || file.includes('\0')) throw new Error('Unrepresentable WSL result path')
    return uncRoot + file.replaceAll('/', '\\')
  }
  const converted = convert(value) as Record<string, unknown>
  if (tool === 'glob' && Array.isArray(value.items)) converted.items = value.items.map(item => typeof item === 'string' ? toWindows(item) : convert(item))
  return converted
}
/** Inline range/page coverage may be partial; byte-clipped capture must stay on Windows storage. */
export function inlineWslResult(value: Record<string, unknown>, tool: string, maxBytes: number): boolean {
  const clipped = (item: unknown): boolean => record(item) && (item.truncatedInLine === true
    || item.truncatedBy === 'output-budget' || (tool === 'read_files' && item.truncated === true)
    || Array.isArray(item.items) && item.items.some(clipped))
  if (!['completed', 'partial'].includes(String(value.status)) || value.error || value.reference || value.referenceRoot || value.storageError
    || clipped(value) || Buffer.byteLength(JSON.stringify(value)) + 1 > maxBytes) return false
  return tool === 'read_files' ? value.pending === 0 && value.nextIndex === value.total
    : value.pageComplete === true
}
