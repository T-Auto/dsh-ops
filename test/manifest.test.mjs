/**
 * The dsh-std manifest: parsed by the pinned Community v0.15 parser, and
 * consistent with what the code actually does.
 *
 * `scripts/validate-manifest.mjs` owns the structural gate; this suite owns the
 * claim that the manifest is not a parallel fiction — every tool and section it
 * advertises must be one the policy module produces.
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  MODE_SECTION_ORDERS,
  TOOLING_SECTION,
  TOOL_PREFIX,
  modeSectionName,
  publicToolName,
  renderToolingPolicy,
} from '../lib/policy.js'
import { NATIVE_FILE_TOOLS } from '../lib/capabilities/registry.js'
import { COMPONENTS, componentEnabled, componentEntry } from '../lib/components/defaults.js'
import { assert, PACKAGE_ROOT, report, test } from './lib/harness.mjs'

const manifestFile = path.join(PACKAGE_ROOT, 'dsh-plugin.json')
const text = fs.readFileSync(manifestFile, 'utf8')
const raw = JSON.parse(text)
const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))

/** The pinned Community v0.15 parser, loaded once for the suite. */
const { parseManifest, projectManifest } = await import('@dsh-std/manifest')

await test('the manifest parses under the pinned dsh-std Community v0.15 parser', () => {
  const parsed = parseManifest(text, { source: 'dsh-plugin.json' })
  assert.equal(parsed.manifestVersion, '0.15')
  assert.equal(parsed.version, pkg.version)
})

await test('the host projection exposes the host facet at the package version', () => {
  const projection = projectManifest(parseManifest(text, { source: 'dsh-plugin.json' }))
  assert.deepEqual(projection.metadata.version, pkg.version)
  assert.ok(projection.spec.facets.some((facet) => facet.name === 'host'))
})

await test('the parser rejects a manifest whose version it does not implement', () => {
  const broken = text.replace('"manifestVersion": "0.15"', '"manifestVersion": "0.1.0"')
  assert.throws(() => parseManifest(broken, { source: 'dsh-plugin.json' }))
})

await test('$schema is an absolute URI matching the pinned manifest version', () => {
  assert.match(raw.$schema, /^https:\/\/raw\.githubusercontent\.com\/T-Auto\/dsh-std\/[0-9a-f]{40}\//)
  assert.match(raw.$schema, /dsh-plugin-0\.15\.schema\.json$/)
})

await test('every declared tool is one the policy actually names', () => {
  const namespaces = raw.contributes['x-tool-namespaces']
  // The policy as a deployment that resolved every rung renders it: a bundled
  // shell is named only when it resolved, and a level left off would hide a
  // declared tool from this check.
  const policy = renderToolingPolicy({
    mounted: true,
    levels: { files: true, bash: true, pwsh: true },
  })

  // Index 0 is the native file namespace.
  const hosted = namespaces[0]
  assert.deepEqual(
    [...hosted.tools].sort(),
    [...NATIVE_FILE_TOOLS].sort(),
    'the native namespace declares the owned file tools and Native result projection',
  )
  assert.equal(hosted.transport, 'in-process')
  for (const tool of hosted.tools) {
    assert.ok(policy.includes(publicToolName(tool)), `the policy never names ${publicToolName(tool)}`)
  }
  // The FastCtx background backend was removed: no namespace may still advertise it.
  assert.equal(namespaces.some((entry) => entry.serverName === 'fastctx' || entry.transport === 'stdio'), false)

  // Every further namespace is this plugin's own in-process surface, so its
  // names are checked against the shell capability and against the policy.
  for (const [offset, entry] of namespaces.slice(1).entries()) {
    const index = offset + 1
    assert.ok(
      Array.isArray(entry.tools) && entry.tools.length > 0,
      `the namespace at index ${index} must declare its tools`,
    )
    for (const tool of entry.tools) {
      assert.ok(
        ['bash', 'pwsh'].includes(tool),
        `the namespace at index ${index} declares ${tool}, which the plugin does not register itself`,
      )
      assert.ok(policy.includes(publicToolName(tool)), `the policy never names ${publicToolName(tool)}`)
    }
  }
})

await test('the declared namespace documents the upstream names and the public prefix', () => {
  const namespace = raw.contributes['x-tool-namespaces'][0]
  // `serverName` stays the bridge's own namespace: it is what the bridge
  // reserves and what this plugin intercepts, not what the model sees.
  assert.equal(namespace.serverName, 'dsh-ops')
  assert.equal(namespace.publicPrefix, TOOL_PREFIX)
  for (const tool of namespace.tools) {
    assert.ok(publicToolName(tool).startsWith(namespace.publicPrefix))
    assert.equal(publicToolName(tool).includes('__'), false, 'the published name carries no bridge vocabulary')
  }
})

await test('the declared prompt sections are the mode rows the policy registers', () => {
  const declared = raw.contributes['x-prompt-sections'].map((section) => section.name)
  const expected = Object.keys(MODE_SECTION_ORDERS).map((suffix) => modeSectionName(suffix))
  assert.deepEqual([...declared].sort(), [...expected].sort())
  // The legacy per-component sections are gone: rows publish routing text under
  // their mode suffix only, and the Minimal row publishes none at all.
  assert.equal(declared.some((name) => ['file', 'shell', 'ptc'].some((legacy) => name === `${TOOLING_SECTION}:${legacy}`)), false)
  assert.equal(declared.includes(`${TOOLING_SECTION}:mode-minimal`), false)
  // The background stub still loads for existing rows but is no longer a declared component.
  assert.equal(raw.contributes['x-components'].some((component) => component.entry === 'dsh-ops/background'), false)
})

await test('the manifest license matches the package and is MIT', () => {
  assert.equal(raw.license, 'MIT')
  assert.equal(pkg.license, raw.license)
  assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, 'LICENSE')))
  assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, 'NOTICE')))
  // FastCtx's license text and attribution are kept for the earlier releases that shipped it.
  assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, 'licenses', 'fastctx', 'LICENSE-APACHE')))
  assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, 'licenses', 'fastctx', 'NOTICE')))
  assert.ok(pkg.files.includes('licenses'), 'the license texts ship in the package')
})

await test('the bundle patch inserts exactly the one row and no removed FastCtx key', async () => {
  const { parse } = await import('yaml')
  const { LEGACY_FASTCTX_KEYS } = await import('../lib/config.js')
  const patch = parse(fs.readFileSync(path.join(PACKAGE_ROOT, pkg.dsh.bundle.patch), 'utf8'))
  const rows = patch.flatMap((entry) => entry.insert ?? [])
  assert.deepEqual(rows.map((row) => row.id), ['dsh-ops'])
  assert.deepEqual(rows.map((row) => row.name), ['dsh-ops'])
  // The legacy rows remain exported modules; they are not inserted into new profiles.
  for (const legacy of ['shell', 'file', 'ptc', 'hide-official', 'background']) {
    assert.equal(rows.some((row) => row.id === `dsh-ops-${legacy}`), false, `${legacy} must not be inserted`)
    assert.equal(rows.some((row) => row.name === `dsh-ops/${legacy}`), false, `${legacy} specifier must not be inserted`)
  }
  for (const row of rows) {
    for (const key of LEGACY_FASTCTX_KEYS) assert.equal(Object.hasOwn(row.config ?? {}, key), false, `${row.name} still writes ${key}`)
  }
  // Every legacy entry stays exported so profiles that still name the old row keep loading.
  for (const legacy of ['shell', 'file', 'ptc', 'hide-official', 'background']) assert.ok(pkg.exports[`./${legacy}`], legacy)
})

await test('the declared host entry is the shipped module', () => {
  assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, raw.facets.host.entry)))
  assert.equal(pkg.main, raw.facets.host.entry)
})

/** The display contribution the Plugin Manager reads without activating the plugin. */
const display = raw.contributes['x-display'][0]

await test('the card text is translated, not one string repeated across locales', () => {
  const read = (language) => JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'locale', `${language}.json`), 'utf8')).meta
  const english = read('en')
  const chinese = read('zh')
  assert.equal(english.title, display.title, 'the manifest and the English locale must not drift')
  assert.equal(english.title, pkg.name, 'the shared brand title is intentionally not translated')
  assert.equal(chinese.title, english.title)
  assert.notEqual(chinese.description, english.description, 'the Chinese card must not show the English description')
})

await test('the card icon is a self-contained PNG with bounded dimensions', () => {
  const icon = fs.readFileSync(path.join(PACKAGE_ROOT, display.icon))
  assert.equal(display.icon, './docs/assets/icon.png')
  assert.deepEqual(icon.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  assert.equal(icon.toString('ascii', 12, 16), 'IHDR')
  assert.equal(icon.readUInt32BE(16), 256)
  assert.equal(icon.readUInt32BE(20), 256)
  assert.ok(icon.length <= 256 * 1024)
})

await test('the icon and all component entries are shipped in the package whitelist', () => {
  assert.ok(pkg.files.includes('docs/assets/icon.png'))
  for (const component of COMPONENTS) {
    const directory = path.join(PACKAGE_ROOT, 'lib', 'components', component)
    assert.ok(fs.existsSync(path.join(directory, 'index.js')))
    assert.ok(pkg.exports[`./${component}`])
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
    assert.equal(path.isAbsolute(manifest.icon), false)
    const iconFile = fs.realpathSync(path.resolve(directory, manifest.icon))
    const relative = path.relative(fs.realpathSync(directory), iconFile)
    assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `${component}: icon must stay inside its manifest directory`)
    assert.ok(fs.statSync(iconFile).isFile() && fs.statSync(iconFile).size <= 256 * 1024)
  }
})

await test('the display manifest declares the one row, enabled by default', async () => {
  const components = raw.contributes['x-components']
  assert.deepEqual(components.map((component) => component.id), ['dsh-ops'])
  assert.equal(components[0].entry, 'dsh-ops')
  assert.equal(components[0].defaultEnabled, true)
  assert.ok(Array.isArray(components[0].tools) && components[0].tools.length > 0)
  for (const component of COMPONENTS) {
    assert.equal(components.some((entry) => entry.id === `dsh-ops-${component}`), false, `${component} must not be advertised as a row`)
  }
  // The per-feature defaults moved into the bundle config, which the host reads as
  // this row's settings; the display manifest only advertises the row itself.
  const { parse } = await import('yaml')
  const patch = parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8'))
  const config = patch.flatMap((entry) => entry.insert ?? [])[0].config
  for (const feature of ['minimal', 'standard', 'ptc', 'cordis', 'discovery']) assert.equal(config[feature].enabled, true, feature)
  for (const feature of ['panel', 'tui']) assert.equal(config[feature].enabled, false, feature)
})

report('manifest')
