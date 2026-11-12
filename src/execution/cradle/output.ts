/** Bounded output tails and optional spill files, compatible with the existing ownership ledger. */
import { Buffer } from 'node:buffer'
import { mkdtemp, open, unlink, rmdir } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { SubprocessOutputRead } from '../../adapter/dsh/types.js'

const TAIL = 64_000
const SPILL = 64 * 1024 * 1024
const ACTIVE_DISK = 256 * 1024 * 1024
export class SpillSpace {
  private directory?: Promise<string>
  private bytes = 0
  reserve(bytes: number): boolean {
    if (this.bytes + bytes > ACTIVE_DISK) return false
    this.bytes += bytes
    return true
  }
  release(bytes: number): void { this.bytes -= bytes }
  async create(id: number, channel: string): Promise<{ file: FileHandle; name: string }> {
    this.directory ??= mkdtemp(path.join(tmpdir(), 'dsh-subprocess-'))
    const name = path.join(await this.directory, `dsh-subprocess-${process.pid}-${id}-${randomBytes(6).toString('hex')}-${channel}.log`)
    return { name, file: await open(name, 'wx', 0o600) }
  }
  async dispose(): Promise<void> {
    if (this.directory) await this.directory.then(dir => rmdir(dir)).catch(() => {})
    // Nonempty directories contain retained results and belong to the existing retention sweep.
  }
}
export class OutputTail {
  private tail = Buffer.alloc(0)
  private total = 0
  private spill?: { file: FileHandle; name: string }
  private spilled = 0
  private spillDisabled = false
  private finished = false
  constructor(private readonly space: SpillSpace, private readonly id: number, private readonly channel: string) {}
  async append(bytes: Buffer): Promise<void> {
    if (this.finished) throw new Error('Output after stream settlement')
    const previous = this.tail
    this.total += bytes.length
    this.tail = Buffer.concat([previous, bytes]).subarray(-TAIL)
    if (this.total <= TAIL || this.spillDisabled) return
    if (this.total > SPILL) { await this.discard(); return }
    try {
      if (!this.spill) {
        this.spill = await this.space.create(this.id, this.channel)
        await this.write(previous)
      }
      await this.write(bytes)
    } catch { await this.discard() }
  }
  private async write(bytes: Buffer): Promise<void> {
    if (!this.space.reserve(bytes.length)) throw new Error('Active cradle spill budget exhausted')
    this.spilled += bytes.length
    let offset = 0
    while (offset < bytes.length) {
      const { bytesWritten } = await this.spill!.file.write(bytes, offset, bytes.length - offset)
      if (!bytesWritten) throw new Error('Incomplete spill write')
      offset += bytesWritten
    }
  }
  private async discard(): Promise<void> {
    this.spillDisabled = true
    if (this.spill) {
      const spill = this.spill; this.spill = undefined
      await spill.file.close().catch(() => {})
      try { await unlink(spill.name) }
      catch { return } // Failed deletion still consumes the generation's reserved disk budget.
    }
    this.space.release(this.spilled); this.spilled = 0
  }
  async finish(): Promise<void> {
    if (this.finished) return
    this.finished = true
    if (this.spill) {
      try { await this.spill.file.close() } catch { await this.discard() }
    }
    // Retained spills continue to consume this generation's disk budget after task completion.
    // Discarded files release their reservation; retained files are reclaimed by the OPS ledger.
  }
  readFrom(offset: number): SubprocessOutputRead {
    const begin = this.total - this.tail.length
    const lossy = offset < begin
    return { text: this.tail.subarray(Math.max(0, offset - begin)).toString('utf8'),
      nextOffset: this.total, lossy, ...(this.spill ? { spillPath: this.spill.name } : {}) }
  }
}
