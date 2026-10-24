/** Opt-in bounded grep must keep prefix rows without inventing exhaustive totals. */
import fs from 'node:fs'
import path from 'node:path'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { callWorker, request, envelopeOf, requireWorker } from './lib/boundary.mjs'
requireWorker('search-early-exit')
const grep = async (root, args = {}) => envelopeOf(await callWorker(JSON.stringify(
  request('grep', { path: root, pattern: 'hit', limit: 2, ...args }, { root }),
)), assert)
const seed = root => {
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(root, `${i}.txt`), 'before\nhit one\nhit two\nhit three\nafter\n')
}
const incomplete = value => {
  assert.equal(value.status, 'completed', JSON.stringify(value))
  assert.equal(value.scanComplete, false)
  assert.equal(value.complete, false)
  assert.equal(value.truncatedBy, 'row-limit')
  for (const field of ['matchedTotal', 'total', 'omitted', 'continuation']) assert.equal(value[field], undefined, field)
  assert.match(value.nextAction, /exactTotal=true/)
  assert.match(value.nextAction, /lower bound/)
}

await test('bounded content stops within the first file and returns the same contextual prefix', async () => {
  await withTempDir('grep-early-content', async root => {
    seed(root)
    for (const extra of [{}, { multiline: true }, { offset: 1, beforeContext: 1, afterContext: 1 }]) {
      const full = await grep(root, extra), bounded = await grep(root, { ...extra, exactTotal: false })
      incomplete(bounded)
      assert.deepEqual(bounded.items, full.items)
      assert.equal(bounded.pageComplete, true)
      assert.equal(bounded.scannedFiles, 1)
      assert.equal(full.scannedFiles, 8)
      assert.equal(bounded.matchedObserved, (extra.offset ?? 0) + 2)
      assert.equal(full.matchedTotal, 24)
    }
  })
})

await test('bounded file/count modes stop at file rows and retain exact per-file counts', async () => {
  await withTempDir('grep-early-file-modes', async root => {
    seed(root)
    for (const outputMode of ['count', 'files_with_matches']) {
      const args = { outputMode, offset: 1 }
      const full = await grep(root, args), bounded = await grep(root, { ...args, exactTotal: false })
      incomplete(bounded)
      assert.deepEqual(bounded.items, full.items)
      assert.equal(bounded.scannedFiles, 3)
      assert.equal(bounded.matchedObserved, 9)
      assert.equal(bounded.nextOffset, 3)
      if (outputMode === 'count') assert.deepEqual(bounded.items.map(item => item.count), [3, 3])
    }
  })
})

await test('summary and exhausted bounded scans still report actual exact totals', async () => {
  await withTempDir('grep-early-exhausted', async root => {
    seed(root)
    for (const extra of [{ outputMode: 'summary' }, { limit: 50 }, { outputMode: 'files_with_matches', limit: 50 }, { pattern: 'absent' }]) {
      const full = await grep(root, extra), bounded = await grep(root, { ...extra, exactTotal: false })
      assert.equal(bounded.scanComplete, true)
      assert.equal(bounded.matchedTotal, full.matchedTotal)
      assert.equal(bounded.total, full.total)
      assert.deepEqual(bounded.items, full.items)
      assert.equal(bounded.scannedFiles, full.scannedFiles)
    }
  })
})

await test('exact-total defaults and current continuation binding remain enforced', async () => {
  await withTempDir('grep-early-cursor', async root => {
    seed(root)
    const omitted = await grep(root), explicit = await grep(root, { exactTotal: true })
    assert.equal(omitted.matchedTotal, explicit.matchedTotal)
    assert.deepEqual(omitted.items, explicit.items)
    const next = await grep(root, { exactTotal: true, continuation: explicit.continuation })
    assert.equal(next.scanComplete, true)
    assert.equal(next.matchedTotal, 24)
    const stale = await grep(root, { exactTotal: false, continuation: explicit.continuation })
    assert.equal(stale.error.code, 'SEARCH_STALE')
    const invalid = await grep(root, { exactTotal: 'false' })
    assert.equal(invalid.status, 'error')
  })
})

await test('invalid encoding can hide matching ASCII and stays a gap unless filtered out', async () => {
  await withTempDir('grep-early-encoding', async root => {
    fs.writeFileSync(path.join(root, 'a.txt'), Buffer.concat([Buffer.from('hit hidden\n'), Buffer.from([0xff])]))
    fs.writeFileSync(path.join(root, 'b.txt'), 'hit visible\nhit again\nhit last\n')
    fs.writeFileSync(path.join(root, 'excluded.bin'), Buffer.from([0xff]))
    const full = await grep(root, { glob: ['*.txt'] })
    assert.equal(full.scanComplete, false)
    assert.equal(full.matchedTotal, undefined)
    assert.equal(full.matchedObserved, 3)
    assert.equal(full.skipReasons['invalid-encoding'], 1)
    assert.equal(full.skipReasons.pattern, 1)
    assert.equal(full.failed, 0)
    const bounded = await grep(root, { exactTotal: false, glob: ['*.txt'] })
    incomplete(bounded)
    assert.equal(bounded.skipReasons['invalid-encoding'], 1)
    assert.match(bounded.nextAction, /reported scan gaps/)
    const filtered = await grep(root, { glob: ['b.txt'] })
    assert.equal(filtered.scanComplete, true)
    assert.equal(filtered.matchedTotal, 3)
  })
})

await test('bounded partial-line output never suggests advancing past the missing suffix', async () => {
  await withTempDir('grep-early-output', async root => {
    fs.writeFileSync(path.join(root, 'a.txt'), `hit${'\\"😀'.repeat(100000)}\nhit next\n`)
    const value = await grep(root, { exactTotal: false, limit: 1 })
    incomplete(value)
    assert.equal(value.pageComplete, false)
    assert.equal(value.nextOffset, 0)
    assert.equal(value.items[0].truncatedInLine, true)
    assert.match(value.nextAction, /partly displayed/)
  })
})

report('search-early-exit')
