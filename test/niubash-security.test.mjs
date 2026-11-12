import fs from 'node:fs'
import path from 'node:path'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { selectNiubash } from '../lib/niubash/runtime.js'
import { resolveShells } from '../lib/shells/resolve.js'
import { confinedBash, restrictedCompatibility } from '../lib/bash-ipc.js'
import { syntheticNiubashTree } from './lib/niubash-distribution-fixture.mjs'

await test('a local receipt cannot stand in for the pinned inventory', async () => {
  await withTempDir('niu-inventory', async root => {
    const file = path.join(root, 'niu.exe')
    fs.writeFileSync(file, 'untrusted')
    fs.writeFileSync(path.join(root, 'provenance.json'), JSON.stringify({ files: { 'niu.exe': 'fake' } }))
    assert.throws(() => selectNiubash(file), /EXECUTOR_UNAVAILABLE:.*(Incomplete|size mismatch)/)
    assert.equal(restrictedCompatibility(file, { platform: 'win32' }).compatible, false)
  })
})
await test('Niubash never reaches the MSYS IPC runtime, even when complete', async () => {
  await withTempDir('niu-ipc', async root => {
    const file = path.join(syntheticNiubashTree(path.join(root, 'niubash')), 'niu.exe')
    assert.equal(restrictedCompatibility(file, { platform: 'win32' }).compatible, true)
    assert.throws(() => confinedBash(file, { platform: 'win32' }), error => error.code === 'bash-runtime-incompatible' && /runs natively/.test(error.message))
  })
})
await test('linked tree ancestors are rejected', async () => {
  await withTempDir('niu-links', async root => {
    const tree = path.join(root, 'tree'); fs.mkdirSync(tree)
    const alias = path.join(root, 'alias'); fs.symlinkSync(tree, alias, 'junction')
    assert.throws(() => selectNiubash(path.join(alias, 'niu.exe')), /link/)
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
    fs.rmSync(tree, { recursive: true }); fs.rmSync(provisioned, { recursive: true })
    result = resolveShells({ allowSystemShellFallback: true }, options).bash
    assert.equal(result.available, false); assert.equal(result.source, 'missing')
  })
})
report('niubash-security')
