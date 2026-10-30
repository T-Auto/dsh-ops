/** The single row's small page: two bundle switches and four per preset. */
import { assert, test, report } from './lib/harness.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { companionVersion } from '../lib/settings/companion.js'
import { GROUPS, ROW_ID, groupsFor, bundleGates, changedFields, flatKey, readRowValues } from '../lib/client/row-schema.js'
import { hasStatus, statusView } from '../lib/client/detail.js'
import { en } from '../lib/client/locales.js'
import { Config, effectiveMode, resolveMergedConfig } from '../lib/settings/merged.js'
import { readRowValues as draftFor } from '../lib/client/row-schema.js'
const t = key => en[key]
const SWITCHES = ['bash', 'hidePwsh', 'hideOfficialTools', 'dynamicTools']

await test('the page matches the host descriptor, and the opt-in switches share one card', () => {
  assert.deepEqual(Object.keys(Config.dict), ['presets', 'global', 'minimal', 'standard', 'ptc', 'cordis', 'panel', 'tui', 'other'])
  const global = GROUPS.find(group => group.id === 'global')
  // The bundle section mirrors the presets' four switches, in the same order.
  assert.deepEqual(global.fields.map(spec => spec.path[1]), SWITCHES)
  assert.deepEqual(Object.keys(Config.dict.global.dict), SWITCHES)
  for (const section of ['minimal', 'standard', 'ptc', 'cordis']) {
    const group = GROUPS.find(entry => entry.id === section)
    const expected = section === 'minimal' ? SWITCHES : ['bash', 'hidePwsh', 'hideOfficialTools', 'residentTools', 'dynamicTools']
    assert.deepEqual(group.fields.map(spec => spec.path[1]), expected, section)
    assert.deepEqual([...group.fields.map(spec => spec.path[1]), 'enabled'].sort(), Object.keys(Config.dict[section].dict).sort(), section)
  }
  // compat/panel/tui used to be three single-switch cards; they are one card now.
  const other = GROUPS.find(group => group.id === 'other')
  assert.deepEqual(other.fields.map(spec => flatKey(spec.path)), ['panel.enabled', 'tui.enabled', 'other.pwsh7Link'])
  for (const section of ['panel', 'tui']) assert.deepEqual(Object.keys(Config.dict[section].dict), ['enabled'])
  assert.equal(ROW_ID, 'dsh-ops')
})

await test('every switch defaults on, and only the opt-in three start off', () => {
  const merged = resolveMergedConfig({})
  assert.deepEqual(merged.global, { bash: true, hidePwsh: true, hideOfficialTools: true, dynamicTools: true })
  for (const section of ['minimal', 'standard', 'ptc', 'cordis']) {
    for (const [key, value] of Object.entries(merged[section].config)) {
      if (['bash', 'hidePwsh', 'hideOfficialTools', 'dynamicTools'].includes(key)) assert.equal(value, true, `${section}.${key}`)
    }
  }
  const draft = readRowValues({})
  assert.equal(draft['standard.bash'], true)
  assert.equal(draft['panel.enabled'], false)
  assert.equal(draft['tui.enabled'], false)
})

await test('a preset switch only applies while its bundle switch is on', () => {
  const gates = bundleGates(readRowValues({ global: { dynamicTools: false, bash: false } }))
  assert.deepEqual(gates, { bash: false, hidePwsh: true, hideOfficialTools: true, dynamicTools: false })
  assert.deepEqual(bundleGates(readRowValues({})), { bash: true, hidePwsh: true, hideOfficialTools: true, dynamicTools: true })
  // The mode keeps the saved intent; only the effective slice is gated.
  const off = resolveMergedConfig({ global: { hideOfficialTools: false }, standard: { hideOfficialTools: true } })
  assert.equal(off.standard.config.hideOfficialTools, true)
})

await test('only changed switches are written, as nested paths', () => {
  const raw = { global: { hideOfficialTools: false }, standard: { dynamicTools: false }, tui: { enabled: true } }
  const draft = readRowValues(raw)
  assert.deepEqual(changedFields(draft, raw), [])
  draft['global.hideOfficialTools'] = true
  draft['standard.dynamicTools'] = true
  draft['ptc.enabled'] = false
  draft['tui.enabled'] = false
  assert.deepEqual(changedFields(draft, raw), [
    { op: 'set', path: ['global', 'hideOfficialTools'], value: true },
    { op: 'set', path: ['standard', 'dynamicTools'], value: true },
    { op: 'set', path: ['ptc', 'enabled'], value: false },
    { op: 'set', path: ['tui', 'enabled'], value: false },
  ])
})

await test('the status card reports host facts and says nothing it cannot verify', () => {
  assert.deepEqual(statusView(undefined, t), { summary: en.summaryNone, facts: [], note: en.runtimeHelp })
  const view = statusView({ platform: 'win32', managed: [{ version: '1.2', directory: 'C:/m', owned: true }], git: ['C:/Git/bash.exe'], powerShell: { supported: true, guidance: '' } }, t)
  assert.deepEqual(view.facts.map(fact => fact.value), ['win32', '1.2', 'C:/Git/bash.exe', en.statusPwshReady])
})

await test('the status section belongs to the bundle and to the one row', () => {
  const pkg = { name: 'dsh-ops', installed: true, enabled: true, rows: [] }
  // Other plugins' pages mount the same slot; the section must stay off them.
  assert.equal(hasStatus({ kind: 'bundle', pkg: { ...pkg, name: 'dsh-win-pwsh7' } }), false)
  assert.equal(hasStatus({ kind: 'row', pkg: { ...pkg, name: 'dsh-win-pwsh7' }, row: { rowId: 'dsh-ops', moduleName: 'dsh-ops', enabled: true } }), false)
  assert.equal(hasStatus({ kind: 'bundle', pkg }), true)
  assert.equal(hasStatus({ kind: 'row', pkg, row: { rowId: 'dsh-ops', moduleName: 'dsh-ops', enabled: true } }), true)
  assert.equal(hasStatus({ kind: 'row', pkg, row: { rowId: 'dsh-ops-panel', moduleName: 'dsh-ops/panel', enabled: true } }), false)
  assert.equal(hasStatus({ kind: 'item', id: 'official' }), false)
})

await test('the companion version is read from the profile package tree', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-'))
  fs.mkdirSync(path.join(dir, 'node_modules', 'dsh-win-pwsh7'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'node_modules', 'dsh-win-pwsh7', 'package.json'), JSON.stringify({ name: 'dsh-win-pwsh7', version: '9.9.9' }))
  assert.equal(companionVersion({ env: { DSH_PROFILE_DIR: dir }, now: () => Date.now() + 1e9 }), '9.9.9')
  assert.notEqual(companionVersion({ env: { DSH_PROFILE_DIR: `${dir}-missing` }, now: () => Date.now() + 2e9 }), '9.9.9', 'a missing root falls through to the other profiles')
})

await test('the companion linkage locks the host-shell hide switch off', () => {
  const gate = resolveMergedConfig({ standard: { hidePwsh: true }, other: { pwsh7Link: true } })
  const effective = effectiveMode(gate.standard, gate.global, gate.other.config.pwsh7Link)
  assert.equal(effective.hidePwsh, false, 'linked: the host shell stays visible')
  assert.equal(draftFor({ other: { pwsh7Link: true } })['other.pwsh7Link'], true)
  // Detection turns the link on until the operator sets it explicitly.
  assert.equal(draftFor({}, { pwsh7Installed: true })['other.pwsh7Link'], true)
  assert.equal(draftFor({}, { pwsh7Installed: false })['other.pwsh7Link'], false)
  assert.equal(draftFor({ other: { pwsh7Link: false } }, { pwsh7Installed: true })['other.pwsh7Link'], false, 'an explicit off wins')
  const free = resolveMergedConfig({ standard: { hidePwsh: true } })
  assert.equal(effectiveMode(free.standard, free.global).hidePwsh, true)
})

await test('custom preset switch paths preserve dotted identities and profile defaults', () => {
  const raw = { presets: { 'acme.chat': { profile: 'discovery', externalTools: ['acme_lookup'] } } }
  const draft = readRowValues(raw)
  assert.equal(draft['presets.acme.chat.files'], false)
  assert.equal(draft['presets.acme.chat.shell'], false)
  assert.equal(draft['presets.acme.chat.discovery'], true)
  draft['presets.acme.chat.discovery'] = false
  assert.deepEqual(changedFields(draft, raw), [{ op: 'set', path: ['presets', 'acme.chat', 'discovery'], value: false }])
  assert.equal(groupsFor(raw).find(group => group.labelText === 'acme.chat').togglePath[1], 'acme.chat')
})

report('settings-rows')
