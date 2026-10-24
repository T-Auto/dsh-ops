/** Optional Native projection of intact JSON in the host's existing output spill. */
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import path from 'node:path'
import type { ToolDefinition, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { HostBashResult, ShellCall } from './types.js'
import { renderHostBash } from './host-contract.js'

const MAX_BYTES = 2 * 1024 * 1024
const MIN_BYTES = 8192
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function preview(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > 160 ? { type: 'string', length: value.length, prefix: value.slice(0, 160) } : value
  if (typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) return { type: 'number', value: 'see original for exact representation' }
  if (Array.isArray(value)) return { type: 'array', length: value.length,
    ...(depth < 3 ? { sample: value.slice(0, 3).map(item => preview(item, depth + 1)), omitted: Math.max(0, value.length - 3) } : {}) }
  if (record(value)) {
    const keys = Object.keys(value)
    return { type: 'object', keyCount: keys.length, keys: keys.slice(0, 12),
      ...(depth < 3 ? { fields: Object.fromEntries(keys.slice(0, 8).map(key => [key, preview(value[key], depth + 1)])), omitted: Math.max(0, keys.length - 8) } : {}) }
  }
  return value
}

/** A bounded sample, explicitly not an exhaustive validation of application-level errors. */
function errorSamples(value: unknown) {
  const pending = [value], samples: unknown[] = []
  let visited = 0
  while (pending.length && visited++ < 10000 && samples.length < 3) {
    const item = pending.pop()
    if (record(item)) {
      if (item.error || Array.isArray(item.errors) && item.errors.length || item.status === 'error' || item.status === 'failed' || item.success === false) samples.push(preview(item, 1))
      for (const child of Object.values(item)) if (child !== null && typeof child === 'object') pending.push(child)
    } else if (Array.isArray(item)) {
      for (let i = item.length - 1; i >= 0; i--) if (item[i] !== null && typeof item[i] === 'object') pending.push(item[i])
    }
  }
  return samples
}

/** Pure digest construction: malformed, scalar, oversized or unhelpful input retains its old rendering. */
export function jsonDigest(text: string, fullPath: string): string | undefined {
  const bytes = Buffer.byteLength(text)
  if (bytes < MIN_BYTES || bytes > MAX_BYTES) return undefined
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined }
  if (!record(value) && !Array.isArray(value)) return undefined
  const facts = { preview: preview(value), errorSamples: errorSamples(value) }
  const summary = JSON.stringify(facts)
  if (Buffer.byteLength(summary) > 4096) return undefined
  return `[JSON summary; lossy samples, not an exhaustive error check]\n${summary}\n[full output: ${JSON.stringify(fullPath)}]`
}

/** Read only a settled, regular host spill, with bounded allocation and change detection. */
async function readSpill(file: string): Promise<string | undefined> {
  let handle
  try {
    if (!path.isAbsolute(file)) return undefined
    const entry = await lstat(file)
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size < MIN_BYTES || entry.size > MAX_BYTES) return undefined
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const before = await handle.stat()
    if (!before.isFile() || before.ino !== entry.ino || before.dev !== entry.dev || before.size !== entry.size) return undefined
    const data = Buffer.alloc(before.size + 1)
    let bytes = 0
    while (bytes < data.length) {
      const read = await handle.read(data, bytes, data.length - bytes, bytes)
      if (!read.bytesRead) break
      bytes += read.bytesRead
    }
    const after = await handle.stat(), current = await lstat(file)
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev) return undefined
    return new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, bytes))
  } catch { return undefined }
  finally { await handle?.close().catch(() => {}) }
}

/** Canonical/SDK values stay unchanged. Prepared text is attached only to a direct Native call. */
export function createJsonDigestProjection() {
  const prepared = new WeakMap<ToolExecutionToken, {
    value: string; content: string; projected: ReturnType<NonNullable<ToolDefinition['projectContent']>>
  }>()
  return {
    async prepare(value: HostBashResult, exec: ShellCall) {
      if (!exec.token || exec.parent || exec.signal?.aborted || value.kind !== 'foreground' || value.status !== 'completed'
        || value.exitCode !== 0 || value.signal !== null || value.aborted || value.stopped || !value.stdout.spillPath) return
      try {
        const text = await readSpill(value.stdout.spillPath)
        if (text === undefined || exec.signal?.aborted) return
        const summary = jsonDigest(text, value.stdout.spillPath)
        if (!summary) return
        const original = renderHostBash(value)
        const rendered = renderHostBash({ ...value, stdout: { ...value.stdout, text: summary, truncated: false } })
        if (Buffer.byteLength(rendered) > Buffer.byteLength(original) * 0.8) return
        prepared.set(exec.token, { value: JSON.stringify(value), content: JSON.stringify([{ type: 'text', text: original }]),
          projected: [{ type: 'text', text: rendered }] })
      } catch { /* Optional projection failures must preserve the command's original result. */ }
    },
    projectContent: ((exec, result) => {
      const candidate = prepared.get(exec.token)
      prepared.delete(exec.token)
      if (!candidate || result.isError || exec.signal.aborted || JSON.stringify(result.value) !== candidate.value
        || JSON.stringify(result.content) !== candidate.content) return undefined
      return candidate.projected
    }) satisfies NonNullable<ToolDefinition['projectContent']>,
  }
}
