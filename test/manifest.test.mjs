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
  FILE_TOOLS,
  HOST_SHELL_SECTION,
  IN_PROCESS_TOOLS,
  SHELL_TOOLS,
  TOOLING_SECTION,
  TOOL_PREFIX,
  publicToolName,
  renderToolingPolicy,
} from '../lib/policy.js'
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
    enableShellTools: true,
    mounted: true,
    levels: { fastctx: true, bash: true, pwsh: true },
  })

  // Index 0 is the hosted FastCtx namespace: exactly the FastCtx tools.
  const hosted = namespaces[0]
  assert.deepEqual(
    [...hosted.tools].sort(),
    [...FILE_TOOLS, ...SHELL_TOOLS].sort(),
    'the hosted namespace declares every FastCtx tool and nothing else',
  )
  for (const tool of hosted.tools) {
    assert.ok(policy.includes(publicToolName(tool)), `the policy never names ${publicToolName(tool)}`)
  }

  // Every further namespace is this plugin's own in-process surface, so its
  // names are checked against `IN_PROCESS_TOOLS` and against the policy, never
  // against the FastCtx list. Vacuously true while no such entry exists, so the
  // suite is green before and after that entry lands.
  for (const [offset, entry] of namespaces.slice(1).entries()) {
    const index = offset + 1
    assert.ok(
      Array.isArray(entry.tools) && entry.tools.length > 0,
      `the namespace at index ${index} must declare its tools`,
    )
    for (const tool of entry.tools) {
      assert.ok(
        IN_PROCESS_TOOLS.includes(tool),
        `the namespace at index ${index} declares ${tool}, which the plugin does not register itself`,
      )
      assert.ok(policy.includes(publicToolName(tool)), `the policy never names ${publicToolName(tool)}`)
    }
  }

  // The other direction: every tool this plugin registers itself is named
  // somewhere, so a new in-process tool cannot land without policy text.
  for (const tool of IN_PROCESS_TOOLS) {
    assert.ok(policy.includes(publicToolName(tool)), `the policy never names ${publicToolName(tool)}`)
  }
})

await test('the declared namespace documents the upstream names and the public prefix', () => {
  const namespace = raw.contributes['x-tool-namespaces'][0]
  // `serverName` stays the bridge's own namespace: it is what the bridge
  // reserves and what this plugin intercepts, not what the model sees.
  assert.equal(namespace.serverName, 'fastctx')
  assert.equal(namespace.publicPrefix, TOOL_PREFIX)
  for (const tool of namespace.tools) {
    assert.ok(publicToolName(tool).startsWith(namespace.publicPrefix))
    assert.equal(publicToolName(tool).includes('__'), false, 'the published name carries no bridge vocabulary')
  }
})

await test('the declared prompt sections are the registered ones', () => {
  const declared = raw.contributes['x-prompt-sections'].map((section) => section.name)
  assert.deepEqual([...declared].sort(), [HOST_SHELL_SECTION, TOOLING_SECTION].sort())
})

await test('the manifest license states the composite this repository ships', () => {
  assert.equal(raw.license, 'MIT AND Apache-2.0')
  assert.equal(pkg.license, raw.license)
  assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, 'LICENSE')))
  assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, 'NOTICE')))
  assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, 'vendor', 'fastctx', 'LICENSE-APACHE')))
  assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, 'vendor', 'fastctx', 'NOTICE')))
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
  assert.notEqual(english.title, pkg.name, 'a card title is display copy, not the package name')
  assert.notEqual(chinese.title, english.title, 'the Chinese card must not show the English title')
  assert.notEqual(chinese.description, english.description, 'the Chinese card must not show the English description')
})

await test('the card icon is one self-contained SVG document', () => {
  const icon = fs.readFileSync(path.join(PACKAGE_ROOT, display.icon), 'utf8')
  assert.match(icon, /^<svg\b/u, 'the icon must be a single root SVG element')
  const viewBox = /viewBox="([^"]+)"/u.exec(icon)?.[1].trim().split(/\s+/u).map(Number)
  assert.equal(viewBox?.length, 4, 'the icon must declare a viewBox to scale into a card slot')
  assert.ok(viewBox.every((value) => Number.isFinite(value) && value >= 0))
  // The client inlines the icon as a data URL inside a card that owns the page
  // styles: it may not depend on a stylesheet, a script, a font, or another file.
  for (const forbidden of ['<style', '<script', '<image', '<text', 'href']) {
    assert.equal(icon.includes(forbidden), false, `the icon must not carry ${forbidden}`)
  }
})

await test('the card icon paints exactly one ink color, so it reads on either theme', () => {
  const icon = fs.readFileSync(path.join(PACKAGE_ROOT, display.icon), 'utf8')
  const colors = new Set()
  for (const match of icon.matchAll(/(?:fill|stroke)="([^"]*)"/gu)) {
    if (match[1] !== 'none') colors.add(match[1].toLowerCase())
  }
  assert.equal(colors.size, 1, `expected one ink color, got ${[...colors].join(', ') || '(none)'}`)
})

report('manifest')
