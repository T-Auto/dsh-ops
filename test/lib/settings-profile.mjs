import fs from 'node:fs'
import path from 'node:path'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Settings from '@deepseek-ai/dsh-settings'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import { mountRootInclude, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import { bootHost } from './host.mjs'
import { TEST_HOME, PACKAGE_ROOT } from './harness.mjs'

export async function profileFixture(label, plugin, config) {
  const { ctx } = await bootHost()
  const home = path.join(TEST_HOME, label), dir = path.join(home, 'profiles/fixture')
  fs.mkdirSync(dir, { recursive: true })
  const patchPath = path.join(dir, 'cordis.patch.yml'), baseFile = path.join(home, 'base.yml')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', private: true, dsh: { profile: { bundles: [] } } }))
  fs.writeFileSync(baseFile, '[]\n')
  fs.writeFileSync(patchPath, JSON.stringify([{ insert: [{ id: label, name: 'cordis:fixture', config }] }]))
  const profile = { name: 'fixture', home, dir, patchPath, installAnchor: path.join(PACKAGE_ROOT, 'package.json'), cwd: dir, overlayPaths: [], startedBundles: [], telemetryDisabledEnv: undefined }
  await ctx.plugin(Loader, {})
  ctx.loader.builtins.fixture = plugin
  await ctx.plugin(inner => inner.provide('profileContext', profile))
  await mountRootInclude(ctx, baseFile, readProfilePatches('dsh', profile))
  await ctx.loader.await()
  await ctx.plugin(ConfigEditor)
  await ctx.plugin(Settings)
  return { ctx, patchPath, snapshot: () => ctx.settings.describe().find(value => value.ns === label),
    mutate: (operations, revision) => ctx.settings.mutate(label, operations, revision) }
}
