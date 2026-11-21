/**
 * Activation-time host support boundary (#701).
 *
 * A host below the declared engines.dsh floor used to load anyway and fail
 * later: TypeError scope errors backstage, EXECUTOR_UNAVAILABLE in front.
 * The contract pinned here: the package's own engines.dsh names the floor, an
 * older host hears one explicit diagnosis at activation, and an unknown host
 * version is never refused (it cannot be proven below the floor). The host's
 * own behaviour while loading an unsupported plugin remains upstream.
 */
import fs from 'node:fs'
import path from 'node:path'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { apply } from '../lib/index.js'

await test('the declared engines.dsh floor is read from the package manifest', async () => {
  const { declaredHostFloor } = await import('../lib/adapter/dsh/host-floor.js')
  assert.equal(declaredHostFloor(), '0.2.2-rc.1')
})

await test('semver precedence decides below-floor, with prerelease rules kept', async () => {
  const { versionBelowFloor } = await import('../lib/adapter/dsh/host-floor.js')
  const floor = '0.2.2-rc.1'
  assert.equal(versionBelowFloor('0.2.1', floor), true, 'an older release is below')
  assert.equal(versionBelowFloor('0.2.2-rc.0', floor), true, 'an earlier prerelease is below')
  assert.equal(versionBelowFloor('0.1.9', floor), true, 'an older minor is below')
  assert.equal(versionBelowFloor('0.2.2-rc.1', floor), false, 'the floor itself is not below')
  assert.equal(versionBelowFloor('0.2.2', floor), false, 'a release outranks its prerelease')
  assert.equal(versionBelowFloor('0.2.2-rc.2', floor), false, 'a later prerelease is not below')
  assert.equal(versionBelowFloor('0.2.3', floor), false, 'a newer release is not below')
  assert.equal(versionBelowFloor('1.0.0', floor), false)
})

/** A fake host installation whose app-boot reports a fixed runtime version. */
function seedFakeInstallation(root, version) {
  const bootDir = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
  fs.mkdirSync(bootDir, { recursive: true })
  fs.writeFileSync(path.join(bootDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', main: 'index.js' }))
  fs.writeFileSync(path.join(bootDir, 'index.js'), `export const getDshRuntimeVersion = () => ${JSON.stringify(version)}\n`)
  fs.writeFileSync(path.join(root, 'package.json'), '{}\n')
  return root
}

await test('a host below the floor hears one named diagnosis at activation', () => withTempDir('host-floor', async root => {
  const { assertHostFloor } = await import('../lib/adapter/dsh/host-floor.js')
  const packageDir = seedFakeInstallation(path.join(root, 'old-host'), '0.2.1')
  const { ctx } = await bootHost({ withWorkingDirectory: true })
  try {
    ctx.provide('pluginPackages', { resolution: { entries: [
      { scope: 'installation', name: '@deepseek-ai/dsh-app-boot', packageDir }] } })
    await assert.rejects(assertHostFloor(ctx), /requires DSH 0\.2\.2-rc\.1 or newer/i)
    // The whole row answers with the same diagnosis instead of loading.
    await assert.rejects(apply(ctx, {}), /0\.2\.2-rc\.1/, 'apply must refuse an older host by the declared floor')
  } finally { await shutdown(ctx) }
}))

await test('the floor releases hosts at or above it, and an unknown version is never refused', () => withTempDir('host-floor-ok', async root => {
  const { assertHostFloor } = await import('../lib/adapter/dsh/host-floor.js')
  for (const version of ['0.2.2-rc.1', '0.2.3', '0.3.0']) {
    const packageDir = seedFakeInstallation(path.join(root, 'host-' + version), version)
    const { ctx } = await bootHost({ withWorkingDirectory: true })
    try {
      ctx.provide('pluginPackages', { resolution: { entries: [
        { scope: 'installation', name: '@deepseek-ai/dsh-app-boot', packageDir }] } })
      await assertHostFloor(ctx)
    } finally { await shutdown(ctx) }
  }
  // No readable host version: refusing it would punish hosts the probe cannot see.
  const { ctx } = await bootHost({ withWorkingDirectory: true })
  try { await assertHostFloor(ctx) } finally { await shutdown(ctx) }
}))

report('integration-host-floor')
