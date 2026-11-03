import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assert, test, report } from './lib/harness.mjs'
import { INDEX_CACHE_MODE, indexCacheDir, indexCacheRequest } from '../lib/execution/protocol.js'
import { indexCachePath } from '../lib/paths.js'

/** A private DSH home under the system temp directory. */
function home(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-ops-index-cache-${tag}-`))
}

function modeOf(target) {
  return fs.statSync(target).mode & 0o777
}

await test('the cache is prepared only when the operator enabled it', () => {
  const root = home('disabled')
  try {
    assert.equal(indexCacheDir({ enabled: false, home: root }), null)
    assert.deepEqual(indexCacheRequest({ enabled: false, home: root }), {})
    assert.equal(fs.existsSync(indexCachePath(root)), false, 'a disabled cache creates no directory')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

await test('an enabled cache is created once with mode 0700', () => {
  const root = home('enabled')
  try {
    const first = indexCacheDir({ enabled: true, home: root })
    assert.equal(first, indexCachePath(root))
    assert.equal(first, path.join(root, 'dsh-ops', 'index-cache'))
    assert.equal(fs.existsSync(first), true)
    assert.equal(modeOf(first), 0o700, 'the cache directory must be private')
    assert.equal(indexCacheDir({ enabled: true, home: root }), first, 'preparation is idempotent')
    assert.deepEqual(indexCacheRequest({ enabled: true, home: root }), { cache_dir: first })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

await test('an existing wider directory is narrowed to 0700', () => {
  const root = home('narrow')
  try {
    const dir = indexCachePath(root)
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
    fs.chmodSync(dir, 0o755)
    assert.equal(indexCacheDir({ enabled: true, home: root }), dir)
    assert.equal(modeOf(dir), 0o700)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

await test('an unusable cache falls back to the walk without failing the call', () => {
  const root = home('unusable')
  try {
    const denied = {
      mkdir() { const error = new Error('EACCES'); error.code = 'EACCES'; throw error },
      chmod() {},
      lstat() { return { isDirectory: () => true, isSymbolicLink: () => false } },
      realpath: (value) => value,
    }
    assert.equal(indexCacheDir({ enabled: true, home: root, fs: denied }), null)
    assert.deepEqual(indexCacheRequest({ enabled: true, home: root, fs: denied }), {}, 'no cache_dir reaches the worker')

    const full = {
      mkdir() { const error = new Error('ENOSPC'); error.code = 'ENOSPC'; throw error },
      chmod() {},
      lstat() { return { isDirectory: () => true, isSymbolicLink: () => false } },
      realpath: (value) => value,
    }
    assert.equal(indexCacheDir({ enabled: true, home: root, fs: full }), null, 'a full disk is not an error')

    const noChmod = {
      mkdir() {},
      chmod() { const error = new Error('EPERM'); error.code = 'EPERM'; throw error },
      lstat() { return { isDirectory: () => true, isSymbolicLink: () => false } },
      realpath: (value) => value,
    }
    assert.equal(indexCacheDir({ enabled: true, home: root, fs: noChmod }), null, 'an unenforceable mode is not usable')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

await test('a symlinked cache path is refused and nothing is sent', () => {
  const root = home('symlink')
  const outside = home('symlink-target')
  try {
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    fs.mkdirSync(path.join(root, 'dsh-ops'), { recursive: true })
    fs.chmodSync(outside, 0o755)
    const linked = path.join(root, 'dsh-ops', 'index-cache')
    fs.symlinkSync(outside, linked, linkType)
    assert.equal(indexCacheDir({ enabled: true, home: root }), null, 'a symlinked cache entry is not usable')
    assert.deepEqual(indexCacheRequest({ enabled: true, home: root }), {})
    assert.equal(modeOf(outside), 0o755, 'the link target must not be chmod-ed')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

await test('a symlinked dsh-ops directory is refused', () => {
  const root = home('symlink-parent')
  const outside = home('symlink-parent-target')
  try {
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    fs.chmodSync(outside, 0o755)
    fs.symlinkSync(outside, path.join(root, 'dsh-ops'), linkType)
    assert.equal(indexCacheDir({ enabled: true, home: root }), null, 'a symlinked parent is not usable')
    assert.equal(modeOf(outside), 0o755, 'the link target must not be chmod-ed')
    assert.equal(fs.existsSync(path.join(outside, 'index-cache')), false, 'nothing is created behind the link')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

await test('a regular file where the cache directory belongs is refused', () => {
  const root = home('file-collision')
  try {
    fs.writeFileSync(path.join(root, 'dsh-ops'), 'not a directory')
    assert.equal(indexCacheDir({ enabled: true, home: root }), null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

await test('the documented mode constant is 0700', () => {
  assert.equal(INDEX_CACHE_MODE, 0o700)
})

report('index-cache')
