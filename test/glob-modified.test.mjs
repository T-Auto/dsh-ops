/** Regression for #96/#137: file sizes must never stand in for modification times. */
import fs from 'node:fs'
import path from 'node:path'
import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { callTool, envelopeOf, requireWorker } from './lib/boundary.mjs'

requireWorker('glob-modified')

const OLD = Date.parse('2020-01-01T00:00:00Z')
const MID = Date.parse('2021-01-01T00:00:00Z')
const NEW = Date.parse('2026-01-01T00:00:00Z')

function file(root, name, size, millis) {
  const target = path.join(root, name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, 'x'.repeat(size))
  fs.utimesSync(target, new Date(millis), new Date(millis))
  return target
}

async function glob(root, args = {}) {
  const body = envelopeOf(await callTool('glob', {
    path: root, pattern: ['**/*.txt'], ...args,
  }, { root, readOnly: true, writeRoots: [] }), assert)
  assert.equal(body.status, 'completed', JSON.stringify(body))
  return body
}

const names = items => items.map(item => path.basename(typeof item === 'string' ? item : item.path))

await test('details.modified is Unix milliseconds, including empty files', async () => {
  await withTempDir('glob-modified-details', async root => {
    const targets = [
      file(root, 'a-small-old.txt', 10, OLD),
      file(root, 'b-large-new.txt', 20, NEW + 125),
      file(root, 'c-empty-mid.txt', 0, MID),
    ]
    const body = await glob(root, { outputMode: 'details' })
    assert.equal(body.items.length, targets.length)
    for (const item of body.items) {
      const stat = fs.statSync(item.path)
      assert.equal(item.bytes, stat.size)
      assert.equal(item.modified, Math.trunc(stat.mtimeMs))
    }
  })
})

await test('modified sorts newest first in both output modes, independently of size', async () => {
  await withTempDir('glob-modified-sort', async root => {
    file(root, 'a-small-old.txt', 10, OLD)
    file(root, 'b-large-new.txt', 20, NEW)
    file(root, 'c-tiny-mid.txt', 5, MID)
    for (const outputMode of ['paths', 'details']) {
      const body = await glob(root, { outputMode, sort: 'modified' })
      assert.deepEqual(names(body.items), ['b-large-new.txt', 'c-tiny-mid.txt', 'a-small-old.txt'])
    }
  })
})

await test('equal-size files still sort by time', async () => {
  await withTempDir('glob-modified-equal-size', async root => {
    file(root, 'a-old.txt', 8, OLD)
    file(root, 'b-new.txt', 8, NEW)
    assert.deepEqual(names((await glob(root, { sort: 'modified' })).items), ['b-new.txt', 'a-old.txt'])
  })
})

await test('timestamps before the Unix epoch stay negative and sort correctly', async () => {
  await withTempDir('glob-modified-before-epoch', async root => {
    const before = Date.parse('1960-01-01T00:00:00Z')
    file(root, 'a-before.txt', 20, before)
    file(root, 'b-after.txt', 1, MID)
    const body = await glob(root, { sort: 'modified', outputMode: 'details' })
    assert.deepEqual(names(body.items), ['b-after.txt', 'a-before.txt'])
    assert.equal(body.items[1].modified, before)
  })
})

await test('equal modification times use ascending paths across directories', async () => {
  await withTempDir('glob-modified-ties', async root => {
    file(root, 'a/z.txt', 1, MID)
    file(root, 'a.txt', 20, MID)
    file(root, 'b.txt', 5, MID)
    const body = await glob(root, { sort: 'modified' })
    assert.deepEqual(body.items, [path.join(root, 'a.txt'), path.join(root, 'a', 'z.txt'), path.join(root, 'b.txt')])
  })
})

await test('modified ordering is applied before paging', async () => {
  await withTempDir('glob-modified-page', async root => {
    file(root, 'a-old.txt', 10, OLD)
    file(root, 'b-new.txt', 20, NEW)
    file(root, 'c-mid.txt', 5, MID)
    const first = await glob(root, { sort: 'modified', outputMode: 'details', limit: 1 })
    assert.deepEqual(names(first.items), ['b-new.txt'])
    assert.equal(first.complete, false)
    assert.equal(first.total, 3)
    const second = await glob(root, { sort: 'modified', limit: 1, offset: first.nextOffset })
    assert.deepEqual(names(second.items), ['c-mid.txt'])
    const third = await glob(root, { sort: 'modified', limit: 1, offset: second.nextOffset })
    assert.deepEqual(names(third.items), ['a-old.txt'])
    assert.equal(third.complete, true)
  })
})

await test('the default and explicit path ordering stay unchanged', async () => {
  await withTempDir('glob-modified-path', async root => {
    file(root, 'a-old.txt', 10, OLD)
    file(root, 'b-new.txt', 20, NEW)
    file(root, 'c-mid.txt', 5, MID)
    for (const sort of [undefined, 'path']) {
      assert.deepEqual(names((await glob(root, sort ? { sort } : {})).items), ['a-old.txt', 'b-new.txt', 'c-mid.txt'])
    }
  })
})

report('glob-modified')
