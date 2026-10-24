import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { composeBundle } from '../scripts/lib/compose-bundle.mjs'
import { assert, test, report, PACKAGE_ROOT } from './lib/harness.mjs'

// The normal gate uses its locked host. An isolated published-host installation
// can run exactly the same assertions without replacing the repository's graph.
const boot = await import(process.env.DSH_OPS_TEST_HOST_BOOT
  ? pathToFileURL(path.resolve(process.env.DSH_OPS_TEST_HOST_BOOT)).href
  : '@deepseek-ai/dsh-app-boot')
const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))
const components = ['shell', 'file', 'background', 'ptc', 'discovery', 'panel', 'tui', 'hide-official']
const patch = parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8'))

await test(`explicit host compatibility is consistent and bounded (${boot.getDshRuntimeVersion()})`, () => {
  assert.equal(typeof pkg.engines.dsh, 'string')
  assert.equal(pkg.engines.dsh, pkg.peerDependencies['@deepseek-ai/dsh'])
  // Exercise each declared range through the actual host evaluator. Older hosts
  // read peers, newer hosts prefer engines, so test both independently.
  for (const range of [pkg.engines.dsh, pkg.peerDependencies['@deepseek-ai/dsh']]) {
    const candidate = { name: pkg.name, version: pkg.version, engines: { dsh: range }, peerDependencies: { '@deepseek-ai/dsh': range } }
    for (const version of ['0.2.0-rc.2', '0.2.1-rc.2']) assert.equal(boot.evaluatePluginCompatibility(candidate, {}, version), undefined)
    for (const version of ['0.2.0-rc.1', '0.2.1-rc.3', '0.3.0']) assert.ok(boot.evaluatePluginCompatibility(candidate, {}, version), `must not claim ${version}`)
  }
})

await test('component resources resolve and the host reads bilingual text plus icon bytes', () => {
  for (const component of components) {
    const name = `${pkg.name}/${component}`
    const iconFile = fileURLToPath(import.meta.resolve(`${name}/icon`))
    const icon = fs.readFileSync(iconFile)
    assert.ok(icon.length > 0 && icon.length <= 256 * 1024)
    assert.deepEqual(icon.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    const metadata = boot.readPluginMeta(name, import.meta.url)
    assert.ok(metadata, name)
    assert.ok(metadata.title.en && metadata.title.zh, name)
    assert.ok(metadata.description.en && metadata.description.zh, name)
    assert.match(metadata.icon, /^data:image\/png;base64,/)
    assert.deepEqual(Buffer.from(metadata.icon.split(',')[1], 'base64'), icon)
  }
})

await test('the host composes every shipped row and refuses a missing override target', () => {
  const rows = composeBundle([patch], boot.composeEntries)
  assert.deepEqual(rows.map(row => row.id), components.filter(name => name !== 'background').map(name => `dsh-ops-${name}`))
  const upstream = [{ insert: [{ id: 'upstream', name: 'cordis:fixture' }] }]
  const override = [{ id: 'upstream', config: { enabled: true } }]
  assert.equal(composeBundle([upstream, patch, override], boot.composeEntries).find(row => row.id === 'upstream').config.enabled, true)
  assert.throws(() => composeBundle([patch, override], boot.composeEntries), /entry.*upstream.*not found/)
})

report('host-metadata')
