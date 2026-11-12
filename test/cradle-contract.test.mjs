import { Buffer } from 'node:buffer'
import { Frames, encode, MAX_FRAME } from '../lib/execution/cradle/protocol.js'
import { OutputTail, SpillSpace } from '../lib/execution/cradle/output.js'
import { resolveConfig } from '../lib/config.js'
import { resolveModeConfig } from '../lib/presets/config.js'
import { assert, test, report } from './lib/harness.mjs'

await test('private frames survive arbitrary fragmentation and reject oversized allocation', () => {
  const parser = new Frames(), received = []
  const frame = { v: 1, type: 'output', id: 1, hex: Buffer.from('{"type":"settled"}').toString('hex') }
  for (const byte of encode(frame)) parser.feed(Buffer.from([byte]), value => received.push(value))
  assert.deepEqual(received, [frame])
  const invalid = Buffer.alloc(4); invalid.writeUInt32LE(MAX_FRAME + 1)
  assert.throws(() => new Frames().feed(invalid, () => {}), /length/)
})
await test('output tails remain bounded and discarded spills never claim complete recovery', async () => {
  const space = new SpillSpace()
  // Refuse disk allocation without touching the filesystem.
  space.create = async () => { throw new Error('disk full') }
  const stream = new OutputTail(space, 1, 'stdout')
  await stream.append(Buffer.alloc(64_000, 'a'))
  await stream.append(Buffer.from('tail'))
  await stream.finish()
  const read = stream.readFrom(0)
  assert.equal(Buffer.byteLength(read.text), 64_000)
  assert.equal(read.nextOffset, 64_004)
  assert.equal(read.lossy, true)
  assert.equal(read.spillPath, undefined)
  assert.equal(stream.readFrom(64_000).text, 'tail')
  await assert.rejects(() => stream.append(Buffer.from('late')), /settlement/)
})
await test('cradle selection is explicit and reaches built-in modes', () => {
  assert.equal(resolveConfig().executionBackend, 'host')
  assert.equal(resolveConfig({ executionBackend: 'cradle' }).executionBackend, 'cradle')
  assert.equal(resolveModeConfig({ executionBackend: 'cradle' }, 'ops-ptc').executionBackend, 'cradle')
  assert.throws(() => resolveConfig({ executionBackend: 'automatic' }), /executionBackend/)
})
report('cradle-contract')
