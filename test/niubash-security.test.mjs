import fs from 'node:fs'
import path from 'node:path'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { nativeShellTreeDigest, verifiedNiubash, NIUBASH_TREE_SHA256 } from '../lib/niubash/runtime.js'
import { resolveShells } from '../lib/shells/resolve.js'
import { confinedBash } from '../lib/bash-ipc.js'

await test('full-tree identity includes every file, directory and bytes, not mtime', async () => {
  await withTempDir('niu-inventory', async root => {
    const file = path.join(root, 'niu.exe')
    fs.writeFileSync(file, 'first')
    const before = nativeShellTreeDigest(root), stat = fs.statSync(file)
    fs.writeFileSync(file, 'other'); fs.utimesSync(file, stat.atime, stat.mtime)
    assert.notEqual(nativeShellTreeDigest(root), before, 'same size and timestamp cannot authorize changed bytes')
    fs.writeFileSync(file, 'first')
    assert.equal(nativeShellTreeDigest(root), before)
    fs.mkdirSync(path.join(root, 'empty'))
    assert.notEqual(nativeShellTreeDigest(root), before)
    assert.throws(() => verifiedNiubash(file), /full-tree SHA256 mismatch/)
    fs.writeFileSync(path.join(root, 'provenance.json'), JSON.stringify({ treeSha256: NIUBASH_TREE_SHA256, files: { 'niu.exe': before } }))
    assert.throws(() => verifiedNiubash(file), /full-tree SHA256 mismatch/, 'a writable receipt cannot authorize its tree')
    assert.throws(() => confinedBash(file, { platform: 'win32' }), /full-tree SHA256 mismatch/)
  })
})
await test('linked tree entries and linked ancestors are rejected', async () => {
  await withTempDir('niu-links', async root => {
    const tree = path.join(root, 'tree'); fs.mkdirSync(tree)
    const alias = path.join(root, 'alias'); fs.symlinkSync(tree, alias, 'junction')
    assert.throws(() => nativeShellTreeDigest(alias), /linked or non-directory ancestor/)
    fs.symlinkSync(tree, path.join(tree, 'nested'), 'junction')
    assert.throws(() => nativeShellTreeDigest(tree), /linked entry/)
  })
})
await test('a selected incomplete Niubash cannot silently fall back; custom Bash remains authoritative', async () => {
  await withTempDir('niu-resolution', async root => {
    const bundle = path.join(root, 'package'), home = path.join(root, 'home')
    const tree = path.join(bundle, 'runtime', 'win32-x64', 'niubash'); fs.mkdirSync(tree, { recursive: true })
    const options = { bundleRoot: bundle, env: { DSH_HOME: home }, platform: 'win32', arch: 'x64' }
    let result = resolveShells({ allowSystemShellFallback: true }, options).bash
    assert.equal(result.available, false); assert.equal(result.source, 'bundled')
    const custom = path.join(root, 'bash.exe'); fs.writeFileSync(custom, 'custom')
    result = resolveShells({ bashPath: custom }, options).bash
    assert.equal(result.available, true); assert.equal(result.file, custom); assert.equal(result.source, 'config')
    result = resolveShells({ bashPath: path.join(root, 'missing', 'niu.exe') }, options).bash
    assert.equal(result.available, false); assert.equal(result.source, 'config')
    const provisioned = path.join(home, 'dsh-ops', 'shells', 'niubash'); fs.mkdirSync(provisioned, { recursive: true })
    result = resolveShells({}, options).bash
    assert.equal(result.available, false); assert.equal(result.source, 'provisioned')
  })
})
report()
