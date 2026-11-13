/** Copy terminal output before releasing the native record. Empty live tails are not EOF. */
import type { ShellCompleted, ShellFailure, ShellStream, ShellTransport } from './shell-protocol.js'
export interface ShellCapture { text: string; bytesTotal: number; lossy: boolean; error?: ShellFailure }
export interface ShellOutputPair { stdout: ShellCapture; stderr: ShellCapture; error?: ShellFailure }
const RETAINED_BYTES = 128 * 1024

export async function collectShellOutput(transport: ShellTransport, completed: ShellCompleted): Promise<ShellOutputPair> {
  async function collect(stream: ShellStream, total: number): Promise<ShellCapture> {
    let offset = 0, bytes = Buffer.alloc(0), lossy = false
    // Native retention is bounded; this also bounds malformed tiny-progress receipts.
    for (let reads = 0; reads < 256; reads++) {
      const value = await transport.read(completed.requestId, stream, offset, 65536)
      const block = Buffer.from(value.bytesBase64, 'base64')
      if (value.nextOffset > total || (!value.error && ((value.nextOffset === offset && !value.eof)
        || (value.eof && value.nextOffset !== total)))) throw new Error('Shell output disagrees with its terminal receipt')
      bytes = Buffer.concat([bytes, block])
      lossy ||= value.lossy || bytes.length > RETAINED_BYTES
      if (bytes.length > RETAINED_BYTES) bytes = bytes.subarray(bytes.length - RETAINED_BYTES)
      offset = value.nextOffset
      if (value.error) return { text: bytes.toString('utf8'), bytesTotal: total, lossy: true, error: value.error }
      if (value.eof) return { text: bytes.toString('utf8'), bytesTotal: total, lossy }
    }
    throw new Error('Shell output exceeded its bounded terminal read count')
  }
  const guarded = (stream: ShellStream, total: number) => collect(stream, total).catch(error => {
    // A contradictory terminal receipt is a protocol failure. Stop the owned
    // connection before joining the sibling reader, which might still be pending.
    transport.abort(error instanceof Error ? error : new Error(String(error)))
    throw error
  })
  const results = await Promise.allSettled([guarded('stdout', completed.stdoutTotal), guarded('stderr', completed.stderrTotal)])
  const failed = results.find(result => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
  const stdout = (results[0] as PromiseFulfilledResult<ShellCapture>).value
  const stderr = (results[1] as PromiseFulfilledResult<ShellCapture>).value
  return { stdout, stderr, ...(stdout.error ?? stderr.error ? { error: stdout.error ?? stderr.error } : {}) }
}
