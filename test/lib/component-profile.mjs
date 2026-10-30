/** Installed bundle/profile fixture using the pinned composition and Loader APIs. */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { readProfilePatches, mountRootInclude, reconcileProfilePatches, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { bootHost } from './host.mjs'
import { TEST_HOME, PACKAGE_ROOT, assert } from './harness.mjs'
export function componentProfile(label, bundleText, patches = []) {
  const home = path.join(TEST_HOME, label), dir = path.join(home, 'profiles/fixture')
  const packageDir = path.join(dir, 'node_modules/dsh-ops'), install = path.join(home, 'installation')
  fs.mkdirSync(packageDir, { recursive: true }); fs.mkdirSync(install, { recursive: true })
  fs.copyFileSync(path.join(PACKAGE_ROOT, 'package.json'), path.join(packageDir, 'package.json'))
  fs.symlinkSync(path.join(PACKAGE_ROOT, 'lib'), path.join(packageDir, 'lib'), process.platform === 'win32' ? 'junction' : 'dir')
  const bundlePath = path.join(packageDir, 'cordis.patch.yml')
  fs.writeFileSync(bundlePath, bundleText)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture-profile', private: true, dsh: { profile: { bundles: ['dsh-ops'] } } }))
  const patchPath = path.join(dir, 'cordis.patch.yml'), baseFile = path.join(dir, 'cordis.yml')
  fs.writeFileSync(patchPath, JSON.stringify(patches)); fs.writeFileSync(baseFile, '[]\n')
  const installAnchor = path.join(install, 'package.json'); fs.writeFileSync(installAnchor, '{"name":"fixture-installation"}')
  const profile = { home, dir, patchPath, installAnchor, overlays: [], startedBundles: ['dsh-ops'] }
  return { profile, bundlePath, baseFile, async boot(platform = process.platform) {
    const { ctx } = await bootHost()
    // A public Context value lets the real Loader evaluate the platform expression
    // for all target defaults. This tests composition, not another OS's sandbox.
    ctx.provide('process', { platform })
    await ctx.plugin(Loader, { baseUrl: pathToFileURL(baseFile).href })
    ctx.loader.builtins.fixtureTheme = { apply() {} }
    ctx.provide('profileContext', profile)
    const loaded = loadProfileDirectory('dsh', dir, installAnchor)
    assert.deepEqual(loaded.skippedBundles, [])
    await mountRootInclude(ctx, baseFile, readProfilePatches('dsh', profile))
    await ctx.loader.await()
    return { ctx, entries: () => [...ctx.loader.entries()].filter(entry => entry.options.id === 'dsh-ops' || entry.options.id.startsWith('dsh-ops-')),
      async refresh() { await reconcileProfilePatches(ctx, readProfilePatches('dsh', profile), 'dsh'); await ctx.loader.await() } }
  } }
}
