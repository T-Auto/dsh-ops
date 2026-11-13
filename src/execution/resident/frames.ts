/** Bounded NDJSON transport over the host's private duplex pipe. */
import type { Duplex } from 'node:stream'

export const ENVELOPE_BYTES = 2 * 1024 * 1024
export const FRAME_BYTES = ENVELOPE_BYTES + 256
const QUEUED_FRAMES = 65 // 32 executions, one cancellation each, one shutdown.
interface Queued { bytes: Buffer; sending(): void }

export function encodeFrame(value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`)
  if (bytes.length > FRAME_BYTES) throw new Error('Resident control frame exceeds its byte budget')
  return bytes
}

export class ResidentFrames {
  private buffered = Buffer.alloc(0)
  private readonly queue: Queued[] = []
  private writing = false
  private stopped = false
  constructor(private readonly pipe: Duplex, receive: (value: unknown) => void, private readonly failed: (error: Error) => void) {
    pipe.on('error', error => failed(error))
    pipe.on('end', () => failed(new Error('Resident control channel ended')))
    pipe.on('close', () => failed(new Error('Resident control channel closed')))
    pipe.on('data', (bytes: Buffer) => {
      if (this.stopped) return
      let remaining = bytes
      try {
        while (remaining.length) {
          const end = remaining.indexOf(10)
          const length = end < 0 ? remaining.length : end
          if (this.buffered.length + length + 1 > FRAME_BYTES) throw new Error('Resident response exceeds its frame budget')
          this.buffered = Buffer.concat([this.buffered, remaining.subarray(0, length)])
          if (end < 0) break
          const text = this.buffered.toString('utf8')
          this.buffered = Buffer.alloc(0)
          receive(JSON.parse(text))
          if (this.stopped) return
          remaining = remaining.subarray(end + 1)
        }
      } catch (error) { failed(error instanceof Error ? error : new Error(String(error))) }
    })
  }
  /** Return a remover for a frame that has not reached the writable stream yet. */
  send(bytes: Buffer, sending: () => void = () => {}): () => boolean {
    if (this.stopped) throw new Error('Resident control channel is closed')
    if (this.queue.length >= QUEUED_FRAMES) throw new Error('Resident control queue is full')
    const entry = { bytes, sending }
    this.queue.push(entry)
    this.pump()
    return () => {
      const index = this.queue.indexOf(entry)
      if (index < 0) return false
      this.queue.splice(index, 1)
      return true
    }
  }
  private pump(): void {
    if (this.writing || this.stopped) return
    const entry = this.queue.shift()
    if (!entry) return
    this.writing = true
    try {
      entry.sending()
      // A single outstanding write respects backpressure; further accepted
      // frames stay in the bounded consumer queue instead of the stream buffer.
      this.pipe.write(entry.bytes, error => {
        this.writing = false
        if (error) this.failed(error)
        else this.pump()
      })
    } catch (error) {
      this.writing = false
      this.failed(error instanceof Error ? error : new Error(String(error)))
    }
  }
  stop(): void { this.stopped = true; this.queue.length = 0; this.buffered = Buffer.alloc(0) }
}
