import fs from 'node:fs'
import path from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { tar, UNIX_WORKERS, fixUnixWorkerModes, checkUnixWorkerModes } from '../scripts/lib/build/tar-modes.js'
import { packDirectory, writeReleaseRecords } from '../scripts/lib/build/pack.js'
import { sha256File } from '../scripts/lib/build/util.js'
import { stepCheck } from '../scripts/lib/build/check.js'

const names = [...UNIX_WORKERS, 'package/runtime/win32-x64/dsh-ops-worker.exe', 'package/docs/中文.txt']
function archive(file, entries = names.map(name => ({ path: name }))) {
  const blocks = []
  for (const entry of entries) {
    const body = Buffer.from([0, 255, 1, 2, 3, 10, 128])
    const header = new tar.Header({ mode: 0o644, uid: 12, gid: 34, size: body.length,
      mtime: new Date(123456000), type: 'File', ...entry })
    header.encode()
    blocks.push(header.block, body, Buffer.alloc(512 - body.length))
  }
  fs.writeFileSync(file, gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])))
}

await test('0644 input becomes 0755 only for three Unix workers; every other tar byte survives', () =>
  withTempDir('tar-modes', async root => {
    const file = path.join(root, 'input.tgz')
    archive(file)
    await assert.rejects(checkUnixWorkerModes(file), /0755/u)
    const before = gunzipSync(fs.readFileSync(file))
    await fixUnixWorkerModes(file)
    await checkUnixWorkerModes(file)
    const after = gunzipSync(fs.readFileSync(file))
    assert.equal(after.length, before.length)
    for (let i = 0; i < 3; i++) {
      const offset = i * 1024
      assert.equal(new tar.Header(after.subarray(offset, offset + 512)).mode, 0o755)
      before.copy(after, offset + 100, offset + 100, offset + 108)
      before.copy(after, offset + 148, offset + 148, offset + 156)
    }
    assert.deepEqual(after, before)
    const fixed = fs.readFileSync(file)
    await fixUnixWorkerModes(file)
    assert.deepEqual(fs.readFileSync(file), fixed, 'repair must be idempotent')
  }))

await test('reject missing targets, duplicates, unknown runtime, traversal, links and corrupt archives without replacing input', () =>
  withTempDir('tar-invalid', async root => {
    const entries = names.map(name => ({ path: name }))
    const variants = [entries.slice(1), [...entries, entries[0]],
      [...entries, { path: 'package/runtime/linux-arm64/dsh-ops-worker' }],
      [...entries, { path: 'package/../escape' }],
      entries.map((e, i) => i === 0 ? { ...e, type: 'SymbolicLink', linkpath: 'elsewhere' } : e)]
    for (const variant of variants) {
      const file = path.join(root, 'bad.tgz')
      archive(file, variant)
      const before = fs.readFileSync(file)
      await assert.rejects(fixUnixWorkerModes(file))
      assert.deepEqual(fs.readFileSync(file), before)
    }
    const file = path.join(root, 'truncated.tgz')
    fs.writeFileSync(file, Buffer.from('not gzip'))
    await assert.rejects(fixUnixWorkerModes(file))
  }))

await test('actual npm pack hashes, provenance and SHA256SUMS describe repaired bytes', () =>
  withTempDir('tar-pack', async root => {
    const stage = path.join(root, 'stage')
    const dist = path.join(root, 'dist')
    fs.mkdirSync(stage)
    fs.mkdirSync(dist)
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({name:'dsh-ops',version:'0.0.0',files:['runtime']}))
    for (const name of names.slice(0, 4)) {
      const file = path.join(stage, name.slice('package/'.length))
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, 'worker bytes', {mode:0o644})
    }
    const packed = await packDirectory(stage, dist)
    await checkUnixWorkerModes(packed.path)
    assert.equal(packed.sha256, await sha256File(packed.path))
    assert.equal(packed.bytes, fs.statSync(packed.path).size)
    await writeReleaseRecords({dist, packages:[], plan:{mainTarball:packed.path,
      mainTarballSha256:packed.sha256,mainTarballBytes:packed.bytes}}, [])
    const provenance = JSON.parse(fs.readFileSync(path.join(dist, 'provenance.json')))
    assert.equal(provenance.mainPackage.tarballSha256, packed.sha256)
    assert.equal(provenance.mainPackage.bytes, packed.bytes)
    assert.equal(fs.readFileSync(path.join(dist, 'SHA256SUMS'), 'utf8'), packed.sha256 + '  ' + packed.tarball + '\n')
  }))

await test('release check rejects 0644 even when SHA256SUMS matches the bad artifact', () =>
  withTempDir('tar-gate', async dist => {
    const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)))
    const name = manifest.name + '-' + manifest.version + '.tgz'
    const file = path.join(dist, name)
    archive(file)
    fs.writeFileSync(path.join(dist, 'SHA256SUMS'), await sha256File(file) + '  ' + name + '\n')
    const output = []
    const log = console.log
    console.log = (...args) => output.push(args.join(' '))
    try {
      assert.ok(await stepCheck({dist,packages:[]}) > 0)
    } finally { console.log = log }
    assert.ok(output.some(line => line.includes('MISSING modes') && line.includes('0755')), output.join('\n'))
  }))

report('release-tar-modes')
