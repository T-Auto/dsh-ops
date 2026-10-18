/**
 * A published file must be openable by the same process that published it.
 *
 * Every mutation that creates a destination (write, copy, move) reports
 * `status: "completed"` and then hands the caller a receipt. If the destination
 * cannot be opened afterwards, that receipt is a lie: `stat` still describes the
 * inode, so a caller that trusts metadata sees a file that every `open` path
 * rejects. The invariant is `INV-PATH-OPEN-STAT-CONSISTENCY`: when `stat` on a
 * path succeeds, `open` on the same path must succeed too.
 *
 * Publication is therefore asserted by reading the bytes back, never by trusting
 * the envelope or the metadata. A runtime that virtualises `link()` (proot's
 * link-to-symlink layer, for one) can publish a destination that satisfies every
 * metadata check while no reader can reach it, so this suite is what stops that
 * class of runtime defect from passing as success.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { callTool, envelopeOf, requireWorker } from './lib/boundary.mjs'
requireWorker('publication-openability')

const hash = bytes => createHash('sha256').update(bytes).digest('hex')

/** Run one tool and require a completed envelope. */
const completed = async (tool, args, root) => {
  const value = envelopeOf(await callTool(tool, args, { root }), assert)
  assert.equal(value.status, 'completed', JSON.stringify(value))
  return value
}

/**
 * The observation under test: the destination is a regular file that the same
 * process can open and read, and its bytes are exactly `expected`.
 *
 * `stat` is checked first so a missing destination reports as missing rather
 * than as unreadable, which keeps the two failures distinguishable.
 */
const openable = (target, expected) => {
  const stat = fs.statSync(target)
  assert.ok(stat.isFile(), `${target} is not a regular file`)
  let bytes
  try {
    bytes = fs.readFileSync(target)
  } catch (error) {
    assert.fail(`${target}: stat() succeeded (${stat.size} bytes) but open() failed with ${error.code}: the published destination is unreachable`)
  }
  assert.equal(bytes.length, stat.size, `${target}: read ${bytes.length} bytes but stat reports ${stat.size}`)
  assert.equal(bytes.toString('utf8'), expected)
}

await test('write_file publishes a destination the caller can open', async () => {
  await withTempDir('publication-write', async root => {
    const target = path.join(root, 'written.txt')
    await completed('write_file', { path: target, content: 'hello', expectedRevision: 'absent' }, root)
    openable(target, 'hello')
  })
})

await test('copy publishes a destination the caller can open and keeps the source readable', async () => {
  await withTempDir('publication-copy', async root => {
    const source = path.join(root, 'source.txt')
    const target = path.join(root, 'copied.txt')
    fs.writeFileSync(source, 'copied-bytes')
    const revision = hash(fs.readFileSync(source))
    await completed('copy', { path: source, to: target, expectedRevision: revision }, root)
    openable(target, 'copied-bytes')
    openable(source, 'copied-bytes')
  })
})

await test('move publishes a destination the caller can open and removes the source', async () => {
  await withTempDir('publication-move', async root => {
    const source = path.join(root, 'movable.txt')
    const target = path.join(root, 'moved.txt')
    fs.writeFileSync(source, 'moved-bytes')
    const revision = hash(fs.readFileSync(source))
    await completed('move', { path: source, to: target, expectedRevision: revision }, root)
    openable(target, 'moved-bytes')
    assert.equal(fs.existsSync(source), false, 'move left its source behind')
  })
})

await test('overwrite publishes an openable destination and leaves no staging sibling', async () => {
  await withTempDir('publication-overwrite', async root => {
    const target = path.join(root, 'overwritten.txt')
    fs.writeFileSync(target, 'first')
    const revision = hash(fs.readFileSync(target))
    await completed('write_file', { path: target, content: 'second', expectedRevision: revision }, root)
    openable(target, 'second')
    // The persistent update lock is not residue: only the transient
    // `.<name>.dsh-ops-<uuid>` staging sibling must be gone once published.
    const residue = fs.readdirSync(root).filter(name => /^\..*\.dsh-ops-[0-9a-f-]{36}$/.test(name))
    assert.deepEqual(residue, [], `staging siblings survived publication: ${residue.join(', ')}`)
  })
})

await test('a second create-only write to the same path is refused and leaves the first readable', async () => {
  await withTempDir('publication-conflict', async root => {
    const target = path.join(root, 'once.txt')
    await completed('write_file', { path: target, content: 'first', expectedRevision: 'absent' }, root)
    const second = envelopeOf(await callTool('write_file', { path: target, content: 'second', expectedRevision: 'absent' }, { root }), assert)
    assert.equal(second.status, 'error', JSON.stringify(second))
    openable(target, 'first')
    const residue = fs.readdirSync(root).filter(name => /^\..*\.dsh-ops-[0-9a-f-]{36}$/.test(name))
    assert.deepEqual(residue, [], `refused publication left a staging sibling: ${residue.join(', ')}`)
  })
})

report()
