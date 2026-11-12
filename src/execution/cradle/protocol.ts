/** Private pipe framing, bounded before allocation. Never fed command stdout. */
import { Buffer } from 'node:buffer'
export const MAX_FRAME = 1024 * 1024
export type Frame = Record<string, unknown> & { v: 1; type: string; id?: number }
export function encode(frame: Frame): Buffer {
  const bytes = Buffer.from(JSON.stringify(frame))
  if (bytes.length > MAX_FRAME) throw new Error('EXECUTOR_UNAVAILABLE: cradle request exceeds frame limit')
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32LE(bytes.length)
  return Buffer.concat([header, bytes])
}
export class Frames {
  private header = Buffer.alloc(4)
  private headerBytes = 0
  private body: Buffer | undefined
  private bodyBytes = 0
  feed(chunk: Buffer, consume: (frame: Frame) => void): void {
    let offset = 0
    while (offset < chunk.length) {
      if (!this.body) {
        const count = Math.min(4 - this.headerBytes, chunk.length - offset)
        chunk.copy(this.header, this.headerBytes, offset, offset + count)
        this.headerBytes += count; offset += count
        if (this.headerBytes !== 4) continue
        const length = this.header.readUInt32LE()
        if (!length || length > MAX_FRAME) throw new Error('Invalid cradle frame length')
        this.body = Buffer.allocUnsafe(length)
        this.bodyBytes = 0
      }
      const count = Math.min(this.body.length - this.bodyBytes, chunk.length - offset)
      chunk.copy(this.body, this.bodyBytes, offset, offset + count)
      this.bodyBytes += count; offset += count
      if (this.bodyBytes !== this.body.length) continue
      const value: unknown = JSON.parse(this.body.toString('utf8'))
      this.body = undefined; this.headerBytes = 0
      if (!value || typeof value !== 'object' || !('v' in value) || value.v !== 1 || !('type' in value) || typeof value.type !== 'string') throw new Error('Invalid cradle frame')
      consume(value as Frame)
    }
  }
}
