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
  assert.equal(NIUBASH_PIN.archiveSha256, 'f1e429b32987052ffeda18872b52f1e4fd399c06d15e14a8d067ee74e5db5b06')
  assert.equal(NIUBASH_PIN.files['niu.exe'], '8d37b48e6f5694ee2c9f4af53cad2d0921ac5132d3196d86fdd91c7f017c05c4')
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
