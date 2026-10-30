import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { assert, test, report, PACKAGE_ROOT } from './lib/harness.mjs'
import { platformSurface } from '../lib/official-tool-catalog.js'
import { componentProfile } from './lib/component-profile.mjs'
import { shutdown } from './lib/host.mjs'
import { PTC_LOADABLE_TOOLS } from '../lib/ptc/config.js'
import { resolveMergedConfig, MODES } from '../lib/settings/merged.js'
const patch = fs.readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')
const rows = parse(patch).flatMap(entry => entry.insert ?? [])
const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'dsh-plugin.json'), 'utf8'))
await test('one merged row and manifest agree on every platform', () => {
  assert.deepEqual(rows.map(row => [row.id, row.name]), [['dsh-ops', 'dsh-ops']])
  assert.deepEqual(manifest.contributes['x-components'].map(row => [row.id, row.entry, row.defaultEnabled]), [['dsh-ops', 'dsh-ops', true]])
  assert.equal(rows[0].disabled ?? false, false)
  const resolved = resolveMergedConfig(rows[0].config)
  for (const feature of [...MODES, 'discovery']) assert.equal(resolved[feature].enabled, true, feature)
  for (const feature of ['panel', 'tui', 'other']) assert.equal(resolved[feature].enabled, false, feature)
  assert.deepEqual(resolved.global, { bash: true, hidePwsh: true, hideOfficialTools: true, dynamicTools: true })
  for (const platform of ['win32', 'linux', 'darwin']) assert.equal(platformSurface(platform).shellDefaultEnabled, true)
})
for (const platform of ['win32', 'linux', 'darwin']) await test('real Loader applies fresh single-row ' + platform + ' defaults', async () => {
  const fixture = componentProfile('defaults-' + platform, patch)
  const { ctx, entries } = await fixture.boot(platform)
  try {
    assert.equal(entries().length, 1)
    assert.equal(entries()[0].options.id, 'dsh-ops')
    const config = resolveMergedConfig(entries()[0].options.config)
    assert.equal(config.panel.enabled, false, 'capture stays opt-in')
    assert.equal(config.tui.enabled, false, 'TUI stays opt-in')
    assert.deepEqual(config.ptc.config.allowedTools, PTC_LOADABLE_TOOLS)
    assert.ok(config.ptc.config.allowedTools.includes('read_table'))
    assert.equal(config.standard.config.promptPolicy, true)
    assert.equal(config.cordis.enabled, true)
    assert.equal(fs.readFileSync(fixture.profile.patchPath, 'utf8'), '[]', 'startup does not write a composed tree')
  } finally { await shutdown(ctx) }
})
await test('saved explicit merged PTC pools survive bundle refresh and a fresh profile boot', async () => {
  const choices = [{ id: 'dsh-ops', name: 'dsh-ops', config: { ptc: { enabled: true, allowedTools: ['stat'], alwaysLoaded: [] } } }]
  const fixture = componentProfile('defaults-saved-ptc', patch, choices)
  const original = fs.readFileSync(fixture.profile.patchPath, 'utf8')
  let host = await fixture.boot('linux')
  const check = () => {
    assert.equal(host.entries().length, 1)
    assert.deepEqual(resolveMergedConfig(host.entries()[0].options.config).ptc.config.allowedTools, ['stat'])
    assert.equal(fs.readFileSync(fixture.profile.patchPath, 'utf8'), original)
  }
  try {
    check(); await host.refresh(); check()
    await shutdown(host.ctx); host = await fixture.boot('linux'); check()
  } finally { await shutdown(host.ctx) }
})
await test('the shipped merged mode configs are what validators resolve', () => {
  const resolved = resolveMergedConfig(rows[0].config)
  for (const mode of MODES) {
    assert.deepEqual(rows[0].config[mode].alwaysLoaded ?? [], resolved[mode].config.alwaysLoaded, mode)
    assert.equal(resolved[mode].enabled, true)
    assert.equal(resolved[mode].config.residentTools, mode !== 'minimal')
  }
  assert.equal(resolved.minimal.config.required, false)
  assert.equal(resolved.minimal.config.publishBashTool, true)
})
report('platform-defaults')
