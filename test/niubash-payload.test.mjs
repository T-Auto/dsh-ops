/** Frozen full-payload distribution, independent of the shell execution backend. */
import fs from 'node:fs'
import path from 'node:path'
import { PACKAGE_ROOT, TEST_HOME, assert, report, test, withTempDir } from './lib/harness.mjs'
import { NIUBASH_PIN, NIUBASH_PACKAGE_PATH, NIUBASH_HOME_PATH, stageNiubashArchive,
  verifyNiubashTree, safeNiubashMember, readNiubashTar } from '../lib/cli/niubash-payload.js'
import { pinTable } from '../lib/cli/provision-shells.js'
import { describePackages } from '../scripts/lib/build/assemble.js'
import { assembleNiubash } from '../scripts/lib/build/niubash.mjs'

await test('clean installs and default release select full Niubash, never a Git Bash dependency', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  const lock = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package-lock.json'), 'utf8'))
  assert.equal(pkg.optionalDependencies?.['@dsh-ops/bash-win32-x64'], undefined)
  assert.equal(lock.packages['node_modules/@dsh-ops/bash-win32-x64'], undefined)
  assert.deepEqual(describePackages('win32', 'x64', TEST_HOME), [])
  assert.equal(describePackages('win32', 'x64', TEST_HOME, 'git-bash')[0].name, '@dsh-ops/bash-win32-x64')
  assert.equal(pinTable(undefined).some(pin => pin.name === 'bash'), false)
  assert.equal(NIUBASH_PACKAGE_PATH, 'runtime/win32-x64/niubash')
  assert.equal(NIUBASH_HOME_PATH, 'dsh-ops/shells/niubash')
  assert.equal(Object.keys(NIUBASH_PIN.files).length, 158)
  assert.equal(NIUBASH_PIN.directories.length, 35)
  assert.equal(NIUBASH_PIN.archiveSha256, 'da28cdc4e2e87f777ee0eae71386276f9c6a0ed135c1e2baad943acd8d349b87')
  assert.equal(NIUBASH_PIN.files['niu.exe'], '7ec3ec04ce91bae64c23d7150e6b16574e9d91df8fcf0df997006e2b37bf2f1e')
})
await test('archive traversal, Windows aliases and unsupported links fail before extraction', () => {
  for (const name of ['../x', '/tmp/x', 'C:/x', 'x\\y', 'x/../y', 'x:ads', 'x./y', 'x /y', 'AUX.txt', 'x//y']) {
    assert.throws(() => safeNiubashMember(name), /Unsafe/)
  }
  const header = (name, type = '0') => {
    const block = Buffer.alloc(512)
    block.write(name); block.write('00000000000\0', 124); block.write(type, 156)
    block.fill(32, 148, 156)
    block.write([...block].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148)
    return Buffer.concat([block, Buffer.alloc(1024)])
  }
  assert.throws(() => readNiubashTar(header('../outside')), /Unsafe/)
  assert.throws(() => readNiubashTar(header('link', '2')), /Unsupported/)
  assert.throws(() => readNiubashTar(Buffer.alloc(1)), /terminator/)
})
await test('missing/offline/tampered archives never download Git Bash or remove the previous target', async () => withTempDir('niu-missing', async root => {
  await assert.rejects(assembleNiubash({ dist: root, offline: true }), /Missing Niubash archive.*no Git Bash fallback/)
  const target = path.join(root, 'target'), archive = path.join(root, 'bad.tar.gz')
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'previous'), 'keep')
  fs.writeFileSync(archive, 'untrusted')
  assert.throws(() => stageNiubashArchive(archive, target), /checksum/)
  assert.equal(fs.readFileSync(path.join(target, 'previous'), 'utf8'), 'keep')
  assert.throws(() => verifyNiubashTree(path.join(root, 'absent')), /ENOENT/)
}))

report('niubash-payload')
