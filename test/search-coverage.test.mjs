/** Real worker search coverage, deterministic pages and state-bound cursor regressions. */
import fs from 'node:fs'
import path from 'node:path'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { callWorker, request, envelopeOf, requireWorker } from './lib/boundary.mjs'
requireWorker('search-coverage')
const run = async (root, tool, args, authority = {}) => envelopeOf(await callWorker(JSON.stringify({
  ...request(tool, { path: root, ...args }, { root, ...authority }),
  ...(authority.denyRoots ? { deny_roots: authority.denyRoots } : {}),
})), assert)
const grep = (root, args = {}, authority = {}) => run(root, 'grep', { pattern: 'hit', limit: 2, ...args }, authority)
const stale = value => { assert.equal(value.status, 'error', JSON.stringify(value)); assert.equal(value.error.code, 'SEARCH_STALE'); assert.equal(value.error.effectState, 'none') }

await test('complete scans separate full totals from bounded pages and report declared exclusions', async () => {
  await withTempDir('search-complete', async root => {
    for (const file of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(root, file), 'hit one\nhit two\n')
    fs.writeFileSync(path.join(root, 'other.log'), 'hit ignored\n')
    fs.writeFileSync(path.join(root, '.hidden'), 'hit hidden\n')
    fs.mkdirSync(path.join(root, 'node_modules')); fs.writeFileSync(path.join(root, 'node_modules', 'module.txt'), 'hit module\n')
    const query = { glob: ['*.txt'] }
    const first = await grep(root, query)
    assert.equal(first.scanComplete, true); assert.equal(first.pageComplete, true)
    assert.equal(first.matchedObserved, 6); assert.equal(first.matchedTotal, 6)
    assert.equal(first.scannedFiles, 4); assert.equal(first.skippedFiles, 2)
    assert.equal(first.skipReasons.pattern, 1); assert.equal(first.skipReasons.excluded, 2)
    assert.equal(first.truncatedBy, 'row-limit'); assert.equal(first.complete, false)
    assert.equal(typeof first.continuation, 'string')
    assert.deepEqual(await grep(root, query), first, 'repeated observation yields the same first page and cursor')
    const all = [...first.items]; let page = first
    while (page.continuation) {
      page = await grep(root, { ...query, continuation: page.continuation })
      all.push(...page.items)
    }
    assert.equal(all.length, 6); assert.equal(new Set(all.map(item => `${item.path}:${item.line}`)).size, 6)
    assert.equal(page.complete, true); assert.equal(page.truncatedBy, 'none')
    assert.equal(fs.existsSync(path.join(root, '.dsh-ops')), false, 'search paging never creates audit or reference storage')
  })
})

await test('continuations reject altered query, paging token and current authority', async () => {
  await withTempDir('search-cursor-binding', async root => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'hit\nhit\nhit\n')
    const first = await grep(root)
    const token = first.continuation
    for (const change of [{ pattern: 'other' }, { limit: 1 }, { outputMode: 'count' }, { offset: 1 }]) {
      stale(await grep(root, { continuation: token, ...change }))
    }
    for (const authority of [{ scope: 'different' }, { readOnly: true }, { writeRoots: [root] }, { denyRoots: [path.join(root, 'other')] }]) {
      stale(await grep(root, { continuation: token }, authority))
    }
    stale(await grep(root, { continuation: `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}` }))
    stale(await grep(root, { continuation: 's1:broken' }))
    assert.equal((await grep(root, { continuation: token })).items.length, 1)
  })
})

await test('changed file bytes invalidate cursors even when size and timestamp are restored', async () => {
  await withTempDir('search-cursor-content', async root => {
    const file = path.join(root, 'a.txt'); fs.writeFileSync(file, 'hit\nhit\nhit\n')
    const first = await grep(root); const before = fs.statSync(file)
    fs.writeFileSync(file, 'hot\nhit\nhit\n'); fs.utimesSync(file, before.atime, before.mtime)
    assert.equal(fs.statSync(file).size, before.size)
    stale(await grep(root, { continuation: first.continuation }))
    const current = await grep(root)
    assert.equal(current.matchedTotal, 2); assert.equal(current.complete, true)
  })
})

await test('glob pages bind path membership and metadata while retaining deterministic ordering', async () => {
  await withTempDir('search-cursor-tree', async root => {
    for (const file of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(root, file), file)
    const query = { pattern: ['*.txt'], outputMode: 'details', limit: 1, sort: 'path' }
    const first = await run(root, 'glob', query)
    assert.equal(first.scanComplete, true); assert.equal(first.matchedTotal, 3)
    assert.equal(path.basename(first.items[0].path), 'a.txt')
    const second = await run(root, 'glob', { ...query, continuation: first.continuation })
    assert.equal(path.basename(second.items[0].path), 'b.txt')
    fs.renameSync(path.join(root, 'c.txt'), path.join(root, 'd.txt'))
    stale(await run(root, 'glob', { ...query, continuation: first.continuation }))
    assert.equal((await run(root, 'glob', query)).matchedTotal, 3)
  })
})

await test('oversized and non-UTF8 files are coverage gaps with no invented total or continuation', async () => {
  await withTempDir('search-gaps', async root => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'hit\nhit\nhit\n')
    fs.writeFileSync(path.join(root, 'binary.bin'), Buffer.from([0xff, 0xfe]))
    const fd = fs.openSync(path.join(root, 'large.txt'), 'w')
    try { fs.ftruncateSync(fd, 32 * 1024 * 1024 + 1) } finally { fs.closeSync(fd) }
    for (const outputMode of ['content', 'count', 'summary']) {
      const value = await grep(root, { outputMode })
      assert.equal(value.status, 'completed'); assert.equal(value.scanComplete, false)
      assert.equal(value.pageComplete, true); assert.equal(value.complete, false)
      assert.equal(value.matchedObserved, 3); assert.equal(value.matchedTotal, undefined)
      assert.equal(value.total, undefined); assert.equal(value.omitted, undefined)
      assert.equal(value.skippedFiles, 2); assert.equal(value.failed, 0)
      assert.equal(value.skipReasons.oversized, 1); assert.equal(value.skipReasons['invalid-encoding'], 1)
      assert.equal(value.continuation, undefined); assert.match(value.nextAction, /Narrow path to a smaller readable subdirectory/)
    }
    const filtered = await grep(root, { glob: ['a.txt'], outputMode: 'summary' })
    assert.equal(filtered.scanComplete, true); assert.equal(filtered.matchedTotal, 3)
    assert.equal(filtered.skipReasons.pattern, 2)
  })
})

await test('a gap introduced after observation invalidates a continuation instead of silently omitting it', async () => {
  await withTempDir('search-cursor-gap', async root => {
    const file = path.join(root, 'a.txt'); fs.writeFileSync(file, 'hit\nhit\nhit\n')
    const first = await grep(root)
    fs.writeFileSync(file, Buffer.from([0xff]))
    stale(await grep(root, { continuation: first.continuation }))
  })
})

await test('output truncation preserves scan totals but never advances beyond an undisplayed match suffix', async () => {
  await withTempDir('search-output-gap', async root => {
    fs.writeFileSync(path.join(root, 'a.txt'), `hit${'\0"\\😀'.repeat(50000)}`)
    const value = await grep(root)
    assert.equal(value.scanComplete, true); assert.equal(value.matchedTotal, 1)
    assert.equal(value.pageComplete, false); assert.equal(value.truncatedBy, 'output-budget')
    assert.equal(value.complete, false); assert.equal(value.nextOffset, 0)
    assert.equal(value.continuation, undefined); assert.equal(value.items[0].truncatedInLine, true)
    assert.ok(value.items[0].bytesOmitted > 0)
    assert.ok(Buffer.byteLength(JSON.stringify(value)) < 128 * 1024)
    assert.match(value.nextAction, /nextOffset does not skip/)
  })
})

await test('streamed physical lines retain multiline anchors and before/after context', async () => {
  await withTempDir('search-context', async root => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'before\r\nhit one\r\nhit two\r\nafter\r\n')
    const value = await grep(root, { pattern: 'hit one\nhit two', multiline: true, beforeContext: 1, afterContext: 1 })
    assert.equal(value.matchedTotal, 0, 'literal LF never matches CRLF bytes')
    const whole = await grep(root, { pattern: 'hit one\r?\nhit two', multiline: true, beforeContext: 1, afterContext: 1 })
    assert.equal(whole.matchedTotal, 1); assert.equal(whole.items[0].line, 2)
    assert.equal(whole.items[0].text, 'before\nhit one\nhit two\nafter')
    const lines = await grep(root, { beforeContext: 1, afterContext: 1 })
    assert.equal(lines.matchedTotal, 2); assert.equal(lines.items[0].text, 'before\nhit one\nhit two')
    fs.writeFileSync(path.join(root, 'empty.txt'), '')
    const empty = await grep(root, { path: path.join(root, 'empty.txt'), pattern: '^', multiline: true })
    assert.equal(empty.matchedTotal, 0, 'an empty file has no physical line to match')
    const anchored = await grep(root, { pattern: '$', multiline: true, limit: 10 })
    assert.equal(anchored.matchedTotal, 4, 'a final LF never creates a phantom line')
  })
})
report('search-coverage')
