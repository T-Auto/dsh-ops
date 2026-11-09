import fs from 'node:fs'
import path from 'node:path'
import { preparedNiubashEntries, reclaimPreparedNiubash } from '../lib/niubash/prepared-cache.js'
import { assert, test, report, withTempDir } from './lib/harness.mjs'

await test('retirement matches only prepared directories, preserves current and renames before every deletion', async () => withTempDir('niu-retire', async root => {
  const current = path.join(root, 'a'.repeat(64))
  const obsolete = ['b'.repeat(64), `${'a'.repeat(64)}.broken-old`, `${'a'.repeat(64)}.stage-old`, `${'b'.repeat(64)}.retired-old`]
  const unrelated = ['notes', `${'c'.repeat(63)}.stage-old`, `${'c'.repeat(64)}.stage-`, `${'c'.repeat(64)}.other-old`]
  const otherStage = `${'b'.repeat(64)}.stage-live`
  for (const name of [path.basename(current), otherStage, ...obsolete, ...unrelated]) {
    fs.mkdirSync(path.join(root, name)); fs.writeFileSync(path.join(root, name, 'payload'), 'data')
  }
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside)
  const alias = path.join(root, 'd'.repeat(64)); fs.symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const plainFile = path.join(root, 'e'.repeat(64)); fs.writeFileSync(plainFile, 'not a directory')
  assert.deepEqual(preparedNiubashEntries(current).map(file => path.basename(file)).sort(), [...obsolete, otherStage].sort())
  const rename = fs.renameSync, remove = fs.rmSync, renamed = []
  fs.renameSync = (from, to) => { renamed.push([from, to]); return rename(from, to) }
  fs.rmSync = (file, options) => {
    assert.ok(renamed.some(([, to]) => to === file), 'no prepared sibling is deleted in place')
    return remove(file, options)
  }
  try { reclaimPreparedNiubash(current) } finally { fs.renameSync = rename; fs.rmSync = remove }
  assert.equal(renamed.length, obsolete.length)
  for (const [from, to] of renamed) assert.ok(to.startsWith(`${from}.retired-`))
  for (const name of obsolete) assert.equal(fs.existsSync(path.join(root, name)), false)
  for (const name of [path.basename(current), ...unrelated]) assert.equal(fs.readFileSync(path.join(root, name, 'payload'), 'utf8'), 'data')
  assert.ok(fs.lstatSync(alias).isSymbolicLink()); assert.equal(fs.readFileSync(plainFile, 'utf8'), 'not a directory')
}))
await test('busy retirement is attempted once and failed deletion leaves a retired sibling for the next selection', async () => withTempDir('niu-retire-busy', async root => {
  const current = path.join(root, 'a'.repeat(64)), busy = path.join(root, 'b'.repeat(64)), pending = path.join(root, 'c'.repeat(64))
  for (const directory of [current, busy, pending]) fs.mkdirSync(directory)
  const rename = fs.renameSync, remove = fs.rmSync
  let busyAttempts = 0
  fs.renameSync = (from, to) => {
    if (from === busy) { busyAttempts++; throw Object.assign(Error('image in use'), { code: 'EBUSY' }) }
    return rename(from, to)
  }
  fs.rmSync = () => { throw Object.assign(Error('scanner still holds a file'), { code: 'EPERM' }) }
  try { reclaimPreparedNiubash(current) } finally { fs.renameSync = rename; fs.rmSync = remove }
  assert.equal(busyAttempts, 1); assert.ok(fs.existsSync(busy)); assert.ok(fs.existsSync(current))
  assert.equal(fs.existsSync(pending), false)
  assert.ok(preparedNiubashEntries(current).some(file => file.startsWith(`${pending}.retired-`)))
  reclaimPreparedNiubash(current)
  assert.deepEqual(fs.readdirSync(root), [path.basename(current)])
}))
report('niubash-prepared-cache')
