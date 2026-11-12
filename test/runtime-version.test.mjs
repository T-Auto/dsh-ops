import fs from 'node:fs'
import path from 'node:path'
import { runtimeVersion } from '../lib/adapter/dsh/runtime-version.js'
import { assert, test, report, withTempDir } from './lib/harness.mjs'

await test('runtime version uses the installation-selected host API and preserves prerelease/build spelling', () => withTempDir('runtime-version', async root => {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-app-boot', version: '9.9.9', type: 'module', exports: './index.mjs',
  }))
  fs.writeFileSync(path.join(root, 'index.mjs'), 'export const getDshRuntimeVersion = () => "0.2.2-rc.1+host.7";')
  let reads = 0
  const ctx = { get(name) {
    assert.equal(name, 'pluginPackages'); reads++
    return { resolution: { entries: [{ name: '@deepseek-ai/dsh-app-boot', scope: 'installation', packageDir: root }] } }
  } }
  assert.equal(reads, 0, 'no host read before an explicit diagnostic query')
  assert.deepEqual(await runtimeVersion(ctx), {
    runtimeVersion: '0.2.2-rc.1+host.7', runtimeVersionSource: 'host:app-boot/getDshRuntimeVersion',
  })
  assert.equal(reads, 1)
}))

await test('missing, profile-only, ambiguous and broken host sources return unknown without local details', async () => {
  const previous = process.env.DSH_VERSION
  process.env.DSH_VERSION = '8.8.8-inherited'
  try {
    for (const value of [undefined, {}, { resolution: { entries: [] } },
      { resolution: { entries: [{ name: '@deepseek-ai/dsh-app-boot', scope: 'profile', packageDir: process.cwd() }] } },
      { resolution: { entries: [1, 2].map(() => ({ name: '@deepseek-ai/dsh-app-boot', scope: 'installation', packageDir: process.cwd() })) } },
      { resolution: { entries: [{ name: '@deepseek-ai/dsh-app-boot', scope: 'installation', packageDir: 'relative' }] } },
    ]) assert.deepEqual(await runtimeVersion({ get: () => value }), { runtimeVersion: 'unknown' })
    assert.deepEqual(await runtimeVersion({ get() { throw new Error('private configuration') } }), { runtimeVersion: 'unknown' })
  } finally {
    if (previous === undefined) delete process.env.DSH_VERSION
    else process.env.DSH_VERSION = previous
  }
})
await test('a missing or failing host version API never falls back to package metadata', async () => {
  for (const source of ['export const other = true;', 'export const getDshRuntimeVersion = () => { throw new Error("private path"); };',
    'export const getDshRuntimeVersion = () => "not-a-version";']) {
    await withTempDir('runtime-version-unavailable', async root => {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh-app-boot', version: '9.9.9', type: 'module', exports: './index.mjs',
      }))
      fs.writeFileSync(path.join(root, 'index.mjs'), source)
      const ctx = { get: () => ({ resolution: { entries: [{ name: '@deepseek-ai/dsh-app-boot', scope: 'installation', packageDir: root }] } }) }
      assert.deepEqual(await runtimeVersion(ctx), { runtimeVersion: 'unknown' })
    })
  }
})
report('runtime-version')
