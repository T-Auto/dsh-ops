/** Bounded synchronous views for the public Jobs pump; capture and spill belong to native. */
import type { SubprocessOutputReader } from '../../adapter/dsh/types.js'
import type { TaskOutput, TaskFailure } from './task-protocol.js'
const MEMORY_BYTES = 64000
function pendingUtf8(bytes: Buffer): number {
  let lead = bytes.length - 1
  while (lead >= 0 && bytes.length - lead <= 4 && (bytes[lead]! & 0xc0) === 0x80) lead--
  if (lead < 0) return 0 // The retained window starts mid-codepoint; loss is already explicit.
  const byte = bytes[lead]!, width = byte >= 0xc2 && byte <= 0xdf ? 2 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xf0 && byte <= 0xf4 ? 4 : 1
  return bytes.length - lead < width ? bytes.length - lead : 0
}

export class TaskOutputView implements SubprocessOutputReader {
  private bytes = Buffer.alloc(0)
  private offset = 0
  total = 0
  eof = false
  error?: TaskFailure
  spillPath?: string
  spillOrigin?: 'ops-native-v1'
  spillPid?: number
  spillSealed?: boolean
  spillError?: string
  private incomplete = false
  update(value: TaskOutput): void {
    const bytes = Buffer.from(value.bytesBase64, 'base64')
    if (value.nextOffset < this.total || bytes.length > MEMORY_BYTES
      || (!value.error && value.retainedOffset + bytes.length !== value.nextOffset)) throw new Error('Task snapshot is not a complete bounded tail')
    this.bytes = bytes; this.offset = value.retainedOffset; this.total = value.nextOffset
    this.eof = value.eof; this.error ??= value.error; this.spillPath = this.error ? undefined : value.spillPath
    this.spillOrigin = this.spillPath ? value.spillOrigin : undefined
    this.spillPid = this.spillPath ? value.spillPid : undefined
    this.spillSealed = this.spillPath ? value.spillSealed : undefined
    this.spillError ??= value.spillError
    this.incomplete ||= value.error !== undefined
  }
  fail(error: TaskFailure, total = this.total): void {
    this.error ??= error; this.incomplete = true; this.spillPath = undefined; this.total = Math.max(total, this.total)
    this.spillOrigin = undefined; this.spillPid = undefined; this.spillSealed = undefined
  }
  readFrom(fromByte: number) {
    const from = Math.max(0, Number.isFinite(fromByte) ? Math.floor(fromByte) : 0)
    // A public Jobs cursor must not advance through half a live UTF-8 sequence.
    // Actual EOF/error flushes remaining invalid bytes with normal replacement decoding.
    const suffix = this.eof || this.error || this.incomplete ? 0 : pendingUtf8(this.bytes)
    return { text: this.bytes.subarray(Math.max(0, from - this.offset), this.bytes.length - suffix).toString('utf8'),
      nextOffset: this.total - suffix, lossy: this.incomplete || from < this.offset,
      ...(this.spillPath ? { spillPath: this.spillPath } : {}) }
  }
}
