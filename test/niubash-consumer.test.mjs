/** A real full-plugin artifact must execute through production preparation and host confinement. */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { assert, test, report, skipSuite, withTempDir, PACKAGE_ROOT } from './lib/harness.mjs'
import { npm } from '../scripts/lib/build/util.js'
import { checkNiubashTarball } from '../scripts/lib/build/niubash-tar.mjs'

if (process.platform !== 'win32') skipSuite('niubash-consumer', 'requires the real Windows host sandbox')
if (!process.env.DSH_OPS_NIUBASH_ARCHIVE) skipSuite('niubash-consumer', 'requires explicit frozen DSH_OPS_NIUBASH_ARCHIVE')
// CI allows 600s per full-payload suite; its measured artifact setup is below 60s.
// Keep that reserve when a loaded host explicitly selects a larger outer budget.
const rawBudget = process.env.DSH_OPS_SUITE_TIMEOUT_MS
const suiteBudget = rawBudget === undefined || rawBudget === '' ? 600_000 : Number(rawBudget)
if (!Number.isFinite(suiteBudget) || suiteBudget <= 0) throw new Error('DSH_OPS_SUITE_TIMEOUT_MS must be a positive finite number')
const securityBudget = Math.floor(suiteBudget - 60_000)
if (securityBudget <= 0) throw new Error('Niubash consumer requires a suite budget greater than its 60000ms artifact setup reserve')
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
    const pnpm = process.env.DSH_OPS_TEST_PNPM_CLI
    const install = pnpm ? spawnSync(process.execPath, [pnpm, 'add', '--offline', '--ignore-scripts',
      '--store-dir', path.join(root, 'store'), '--package-import-method=hardlink', artifact], {
      cwd: consumer, env: process.env, encoding: 'utf8', windowsHide: true, timeout: 120000,
    }) : npm(['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--package-lock=false', artifact], { cwd: consumer })
    assert.equal(install.status, 0, `${install.error ?? ''}\n${install.stderr}`)
    // pnpm's public package entry is a link into its physical virtual store. The
    // verifier receives the real package root, never a relaxed no-link policy.
    const installed = fs.realpathSync.native(path.join(consumer, 'node_modules/dsh-ops'))
    if (pnpm) assert.ok(fs.statSync(path.join(installed, 'runtime/win32-x64/niubash/niu.exe')).nlink > 1,
      'exercise actual pnpm store hardlink imports, not copy/reflink fallback')
    assert.equal(fs.lstatSync(installed).isSymbolicLink(), false, 'consumer is a real installed artifact, not a workspace link')
    assert.equal(fs.existsSync(path.join(installed, 'src')), false, 'consumer cannot import source')
    const home = path.join(root, 'host-home'); fs.mkdirSync(home)
    const run = spawnSync(process.execPath, [path.join(PACKAGE_ROOT, 'test/niubash-security-host.test.mjs')], {
      // The child owns this canonical scratch root. Windows runner TEMP may use
      // an alias/short spelling unlike the physical parent fixture; keep its home
      // and tmpdir identical instead of weakening the harness's isolation guard.
      cwd: consumer, env: { ...process.env, TEMP: home, TMP: home, DSH_HOME: home,
        DSH_OPS_NIUBASH_CONSUMER: installed, DSH_OPS_REQUIRE_RUNTIME: '1' },
      encoding: 'utf8', windowsHide: true, timeout: securityBudget, maxBuffer: 4 * 1024 * 1024,
    })
    console.log(run.stdout)
    assert.equal(run.status, 0, `${run.error ?? ''}\n${run.stderr}\n${run.stdout}`)
    assert.match(run.stdout, /all 10 checks passed/)
    assert.doesNotMatch(run.stdout, /SKIP|FAIL/)
  })
})
report('niubash-consumer')
