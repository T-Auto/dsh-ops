/** Frozen full-payload distribution, independent of the shell execution backend. */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { PACKAGE_ROOT, TEST_HOME, assert, report, test, withTempDir, skipSuite } from './lib/harness.mjs'
import { NIUBASH_PIN, NIUBASH_PACKAGE_PATH, NIUBASH_HOME_PATH, stageNiubashArchive,
verifyNiubashTree } from '../lib/cli/niubash-payload.js'
import { managedBashInventory, removeManagedBash, selectBashRuntime } from '../lib/shells/manager.js'
import { provisionNiubash } from '../lib/cli/provision-shells.js'
import { tar } from '../scripts/lib/build/tar-modes.js'
import { checkNiubashTarball } from '../scripts/lib/build/niubash-tar.mjs'
import { npm } from '../scripts/lib/build/util.js'

const archive = process.env.DSH_OPS_NIUBASH_ARCHIVE
if (!archive) skipSuite('niubash-payload-integration', 'requires frozen official archive via DSH_OPS_NIUBASH_ARCHIVE; no download or Git fallback')

await test('verified archive stages atomically; receipt cannot authorize tampering, omissions or extra members', async () => withTempDir('niu-stage', root => {
  const target = path.join(root, 'niu')
  stageNiubashArchive(archive, target)
  assert.equal(verifyNiubashTree(target), path.join(target, 'niu.exe'))
  const exe = path.join(target, 'niu.exe'), original = fs.readFileSync(exe)
  fs.appendFileSync(exe, 'tamper')
  const receipt = path.join(target, 'provenance.json'), saved = fs.readFileSync(receipt)
  const fake = JSON.parse(saved); fake.files['niu.exe'] = '0'.repeat(64)
  fs.writeFileSync(receipt, JSON.stringify(fake))
  assert.throws(() => verifyNiubashTree(target), /checksum/)
  fs.writeFileSync(exe, original); fs.writeFileSync(receipt, saved)
  const missing = path.join(target, 'README.md'), readme = fs.readFileSync(missing)
  fs.unlinkSync(missing); assert.throws(() => verifyNiubashTree(target), /Incomplete/); fs.writeFileSync(missing, readme)
  const extra = path.join(target, 'unlisted'); fs.writeFileSync(extra, 'extra')
  assert.throws(() => verifyNiubashTree(target), /checksum/); fs.unlinkSync(extra)
  fs.mkdirSync(extra); assert.throws(() => verifyNiubashTree(target), /Unknown.*directory/); fs.rmdirSync(extra)
  fs.symlinkSync(path.join(target, 'licenses'), extra, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => verifyNiubashTree(target), /Unsafe/); fs.unlinkSync(extra)
  stageNiubashArchive(archive, target)
  assert.equal(verifyNiubashTree(target), exe)
}))
await test('default provision uses fixed Niubash home, verifies reuse, rejects corruption without Git fallback', () => {
  // macOS aliases /var to /private/var. Use the physical test home rather than
  // weakening the Windows payload's no-link ancestor validation for a POSIX fixture.
  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = fs.realpathSync(TEST_HOME)
  try {
  assert.equal(provisionNiubash({ force: false, dryRun: true }), true)
  assert.equal(provisionNiubash({ force: true, dryRun: false }), true)
  const target = path.join(process.env.DSH_HOME, NIUBASH_HOME_PATH)
  assert.equal(provisionNiubash({ force: false, dryRun: false }), true)
  fs.appendFileSync(path.join(target, 'niu.exe'), 'bad')
  assert.equal(provisionNiubash({ force: false, dryRun: false }), false)
  assert.equal(provisionNiubash({ force: true, dryRun: false }), true)
  verifyNiubashTree(target)
  const inventory = managedBashInventory()
  assert.equal(inventory.find(entry => entry.backend === 'niubash')?.owned, true)
  const selected = selectBashRuntime('niubash', { platform: 'win32', arch: 'x64' })
  assert.equal(selected.clear, true)
  assert.equal(selected.engine, 'niubash')
  assert.equal(selected.file, path.join(target, 'niu.exe'))
  assert.match(selected.restriction, /verified|sandbox/i)
  assert.equal(removeManagedBash().action, 'preview'); assert.equal(fs.existsSync(target), true)
  removeManagedBash({ yes: true })
  assert.equal(fs.existsSync(target), false); assert.deepEqual(managedBashInventory(), [])
  // The choice itself never throws: with no copy left it either reports the packaged
  // payload or states that none is installed, instead of pinning a stale path.
  const afterRemoval = selectBashRuntime('niubash', { platform: 'win32', arch: 'x64' })
  assert.equal(afterRemoval.clear, true)
  assert.ok(afterRemoval.file === undefined || /niu\.exe$/i.test(afterRemoval.file))
  if (afterRemoval.file === undefined) assert.match(afterRemoval.detail, /bash-runtime install/)
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
  }
})
await test('npm pack carries every frozen file; consumer verifies and runs Niubash and bundled tools', async () => withTempDir('niu-pack', async root => {
  const source = path.join(root, 'source'), runtime = path.join(source, NIUBASH_PACKAGE_PATH)
  stageNiubashArchive(archive, runtime)
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'niubash-payload-test', version: '1.0.0', files: ['runtime'] }))
  const result = npm(['pack', '--ignore-scripts', '--json', '--pack-destination', root], { cwd: source })
  assert.equal(result.status, 0, result.stderr)
  // npm's JSON report differs across versions. Inspect the one fresh artifact
  // and its actual members, retaining the full frozen-byte verification.
  const artifacts = fs.readdirSync(root).filter(name => name.endsWith('.tgz'))
  assert.equal(artifacts.length, 1, result.stdout)
  const artifact = path.join(root, artifacts[0])
  checkNiubashTarball(artifact)
  const listed = new Set()
  tar.list({ file: artifact, sync: true, strict: true, onentry(entry) { listed.add(entry.path.replace(/^package\//u, '')) } })
  for (const name of Object.keys(NIUBASH_PIN.files)) assert(listed.has(`${NIUBASH_PACKAGE_PATH}/${name}`), name)
  const consumer = path.join(root, 'consumer'); fs.mkdirSync(consumer)
  await tar.x({ file: artifact, cwd: consumer, strict: true })
  const deployed = path.join(consumer, 'package', NIUBASH_PACKAGE_PATH)
  const executable = verifyNiubashTree(deployed)
  if (process.platform === 'win32') {
    const { prepareNiubash } = await import('../lib/niubash/runtime.js')
    for (let n = 0; n < 2; n++) {
      const execution = await prepareNiubash(executable, '', new AbortController().signal)
      try {
        const run = spawnSync(execution.file, ['-c', "printf 'niu-ok\n'; printf '2\n' | awk '{print $1+1}'; printf packed | cat"], { cwd: root, env: { ...process.env, ...execution.env }, encoding: 'utf8', timeout: 30000, windowsHide: true })
        assert.equal(run.status, 0, `${run.stdout}
${run.stderr}`)
        assert.match(run.stdout, /niu-ok/); assert.match(run.stdout, /3/); assert.match(run.stdout, /packed/)
      } finally { await execution.dispose() }
    }
    verifyNiubashTree(deployed)
  }
}))

report('niubash-payload-integration')
