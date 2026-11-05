/** A real full-plugin artifact must execute through production preparation and host confinement. */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { assert, test, report, skipSuite, withTempDir, PACKAGE_ROOT } from './lib/harness.mjs'
import { npm } from '../scripts/lib/build/util.js'
import { checkNiubashTarball } from '../scripts/lib/build/niubash-tar.mjs'

if (process.platform !== 'win32') skipSuite('niubash-consumer', 'requires the real Windows host sandbox')
if (!process.env.DSH_OPS_NIUBASH_ARCHIVE) skipSuite('niubash-consumer', 'requires explicit frozen DSH_OPS_NIUBASH_ARCHIVE')
await test('clean full-plugin pack consumer uses production prepare for repeated calls, scripts, Native/PTC and all three permission modes', async () => {
  await withTempDir('niu-full-consumer', async root => {
    const packed = npm(['pack', '--json', '--pack-destination', root], { cwd: PACKAGE_ROOT })
    assert.equal(packed.status, 0, packed.stderr)
    // Lifecycle output precedes --json on some npm versions; use the fresh destination,
    // not stdout parsing, while retaining the real prepack verification.
    const artifacts = fs.readdirSync(root).filter(name => name.endsWith('.tgz'))
    assert.equal(artifacts.length, 1, packed.stdout)
    const artifact = path.join(root, artifacts[0])
    checkNiubashTarball(artifact)
    const consumer = path.join(root, 'consumer')
    fs.mkdirSync(consumer)
    fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'ops-clean-consumer', private: true, version: '1.0.0' }))
    const install = npm(['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--package-lock=false', artifact], { cwd: consumer })
    assert.equal(install.status, 0, install.stderr)
    const installed = path.join(consumer, 'node_modules/dsh-ops')
    assert.equal(fs.lstatSync(installed).isSymbolicLink(), false, 'consumer is a real installed artifact, not a workspace link')
    assert.equal(fs.existsSync(path.join(installed, 'src')), false, 'consumer cannot import source')
    const home = path.join(root, 'host-home'); fs.mkdirSync(home)
    const run = spawnSync(process.execPath, [path.join(PACKAGE_ROOT, 'test/niubash-security-host.test.mjs')], {
      cwd: consumer, env: { ...process.env, DSH_HOME: home, DSH_OPS_NIUBASH_CONSUMER: installed, DSH_OPS_REQUIRE_RUNTIME: '1' },
      encoding: 'utf8', windowsHide: true, timeout: 540000, maxBuffer: 4 * 1024 * 1024,
    })
    console.log(run.stdout)
    assert.equal(run.status, 0, `${run.error ?? ''}\n${run.stderr}\n${run.stdout}`)
    assert.match(run.stdout, /all 10 checks passed/)
    assert.doesNotMatch(run.stdout, /SKIP|FAIL/)
  })
})
report('niubash-consumer')
