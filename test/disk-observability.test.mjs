import fs from 'node:fs'
import path from 'node:path'
import { diskStatus, renderDiskStatus } from '../lib/disk/status.js'
import { resolveDiskConfig } from '../lib/disk/ownership.js'
import { assert, report, test, withTempDir } from './lib/harness.mjs'

function fixture(root, config) {
  return diskStatus({ home: path.join(root, 'home'), tempRoot: path.join(root, 'tmp'), workspace: path.join(root, 'ws'), platform: 'linux', config })
}
const lineFor = (text, id) => text.split('\n').find(line => line.startsWith(id + ' '))

await test('disk text exposes bounded measurements and qualifies totals as partial', async () => {
  await withTempDir('disk-observability-budget', root => {
    const target = path.join(root, 'ws', '.dsh-ops', 'panel')
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'a.json'), '123')
    fs.writeFileSync(path.join(target, 'b.json'), '12345')
    const value = fixture(root, resolveDiskConfig({ status: { maxEntries: 1 } }))
    const row = value.resources.find(row => row.id === 'R6')
    assert.equal(row.truncated, true)
    assert.equal(row.skippedCount, 1)
    const text = renderDiskStatus(value)
    assert.match(lineFor(text, 'R6'), /partial/)
    assert.match(text, /truncated=true.*skipped=1/)
    assert.match(text, /entry-budget/)
    assert.ok(text.includes(target))
    assert.match(text, /totals[^\n]*partial/i)
  })
})

await test('zero count with unreadable evidence is not reported missing', async () => {
  await withTempDir('disk-observability-unreadable', root => {
    const target = path.join(root, 'tmp')
    fs.mkdirSync(target, { recursive: true })
    const original = fs.readdirSync
    let value
    fs.readdirSync = function (file, options) {
      if (path.resolve(file) === target) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' })
      return original.call(this, file, options)
    }
    try { value = fixture(root) } finally { fs.readdirSync = original }
    const row = value.resources.find(row => row.id === 'R1')
    assert.equal(row.count, 0)
    assert.equal(row.skippedCount, 1)
    const text = renderDiskStatus(value)
    assert.doesNotMatch(lineFor(text, 'R1'), /missing/)
    assert.match(lineFor(text, 'R1'), /partial/)
    assert.match(text, /unreadable.*EACCES/)
    assert.ok(text.includes(target))
  })
})

await test('skipped samples are identified as samples and do not hide total skip count', async () => {
  await withTempDir('disk-observability-skips', root => {
    const value = fixture(root)
    value.resources = [{ ...value.resources[0], count: 0, skippedCount: 12,
      skipped: [{ path: path.join(root, 'link'), reason: 'symlink', code: null }] }]
    const text = renderDiskStatus(value)
    assert.match(text, /skipped=12/)
    assert.match(text, /symlink/)
    assert.match(text, /11.*not shown/)
    assert.doesNotMatch(lineFor(text, 'R1'), /missing/)
  })
})

await test('complete absent and empty resources retain their existing meanings', async () => {
  await withTempDir('disk-observability-complete', root => {
    fs.mkdirSync(path.join(root, 'ws', '.dsh-ops', 'panel'), { recursive: true })
    const text = renderDiskStatus(fixture(root))
    assert.match(lineFor(text, 'R1'), /missing/)
    assert.doesNotMatch(lineFor(text, 'R6'), /missing|partial/)
    assert.doesNotMatch(text, /totals[^\n]*partial/i)
  })
})

report('disk-observability')
