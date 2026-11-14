/** The single row's small page: the bundle switches and four per preset. */
import { assert, test, report } from './lib/harness.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { companionVersion } from '../lib/settings/companion.js'
import { GROUPS, ROW_ID, groupsFor, bundleGates, changedFields, executorDiffers, executorOps, flatKey, readExecutor, readRowValues } from '../lib/client/row-schema.js'
import { hasStatus, statusView } from '../lib/client/detail.js'
import { en } from '../lib/client/locales.js'
import { Config, effectiveMode, resolveMergedConfig } from '../lib/settings/merged.js'
import { readRowValues as draftFor } from '../lib/client/row-schema.js'
const t = key => en[key]
const SWITCHES = ['bash', 'hidePwsh', 'hideOfficialTools', 'dynamicTools']
/** The bundle card: the four gates plus the default-preset force switch. */
const GLOBAL_SWITCHES = [...SWITCHES, 'forceDefaultOpsPtc']

await test('the page matches the host descriptor, and the opt-in switches share one card', () => {
  assert.deepEqual(Object.keys(Config.dict), ['presets', 'global', 'minimal', 'standard', 'ptc', 'ops-ptc', 'cordis', 'panel', 'tui', 'other'])
  const global = GROUPS.find(group => group.id === 'global')
  // The bundle section mirrors the presets' four switches, then adds the
  // default-preset force switch that has no per-preset counterpart.
  assert.deepEqual(global.fields.map(spec => spec.path[1]), GLOBAL_SWITCHES)
  assert.deepEqual(Object.keys(Config.dict.global.dict), GLOBAL_SWITCHES)
  for (const section of ['minimal', 'standard', 'ptc', 'ops-ptc', 'cordis']) {
    const group = GROUPS.find(entry => entry.id === section)
    const expected = section === 'minimal' ? SWITCHES : ['bash', 'hidePwsh', 'hideOfficialTools', 'residentTools', 'dynamicTools']
    assert.deepEqual(group.fields.map(spec => spec.path[1]), expected, section)
    // bashPath belongs to the executor card rather than the boolean switch grid.
    assert.deepEqual([...group.fields.map(spec => spec.path[1]), 'enabled', 'bashPath'].sort(), Object.keys(Config.dict[section].dict).sort(), section)
    assert.equal(Config.dict[section].dict.bashPath.meta.volatile, true)
  }
  // compat/panel/tui used to be three single-switch cards; they are one card now.
  const other = GROUPS.find(group => group.id === 'other')
  assert.deepEqual(other.fields.map(spec => flatKey(spec.path)), ['panel.enabled', 'tui.enabled', 'other.pwsh7Link'])
  for (const section of ['panel', 'tui']) assert.deepEqual(Object.keys(Config.dict[section].dict), ['enabled'])
  assert.equal(ROW_ID, 'dsh-ops')
})

await test('built-in presets hide PowerShell by default and preserve explicit opt-out', () => {
  const merged = resolveMergedConfig({})
  assert.deepEqual(merged.global, { bash: true, hidePwsh: true, hideOfficialTools: true, dynamicTools: true, forceDefaultOpsPtc: false })
  for (const section of ['minimal', 'standard', 'ptc', 'ops-ptc', 'cordis']) {
    assert.equal(merged[section].config.bash, true, `${section}.bash`)
    assert.equal(merged[section].config.hidePwsh, true, `${section}.hidePwsh`)
    assert.equal(resolveMergedConfig({ [section]: { hidePwsh: false } })[section].config.hidePwsh, false)
    assert.equal(readRowValues({ [section]: { hidePwsh: false } })[`${section}.hidePwsh`], false)
    assert.equal(merged[section].config.hideOfficialTools, true, `${section}.hideOfficialTools`)
    assert.equal(merged[section].config.dynamicTools, true, `${section}.dynamicTools`)
  }
  const draft = readRowValues({})
  assert.equal(draft['global.forceDefaultOpsPtc'], false, 'the default-preset force switch ships off')
  assert.equal(readRowValues({ global: { forceDefaultOpsPtc: false } })['global.forceDefaultOpsPtc'], false)
  assert.equal(draft['standard.bash'], true)
  assert.equal(draft['standard.hidePwsh'], true)
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

await test('the status card reports the resolved executor and its candidates', () => {
  assert.deepEqual(statusView(undefined, t), { summary: en.summaryNone, facts: [], note: en.runtimeHelp })
  const bundled = { id: 'ptc', enabled: true, publishesBash: true, available: true, source: 'bundled',
    engine: 'niubash', file: 'C:/pkg/runtime/win32-x64/niubash/niu.exe', detail: 'verified' }
  const { id: _id, enabled: _enabled, publishesBash: _publishesBash, ...bash } = bundled
  const base = { platform: 'win32', git: [], managed: [], powerShell: { supported: true, guidance: '' } }
  const view = statusView({ ...base, bash, modes: [bundled], git: ['C:/Git/bin/bash.exe'] }, t)
  // A payload shipped in the package is a working executor even without an install.
  assert.equal(view.summary, en.summaryNiubashBundled)
  // The optional `<DSH_HOME>` copy is not a fact of the running executor.
  assert.deepEqual(view.facts.map(fact => fact.value), ['win32', `${en.engineNiubash}（${en.sourceBundled}）`,
    bundled.file, 'C:/Git/bin/bash.exe', en.statusPwshReady])
  // An explicit path is reported as such, with its engine.
  const git = { ...bundled, source: 'config', engine: 'msys', file: 'C:/Git/bin/bash.exe' }
  const configured = statusView({ ...base, modes: [git], bash: { available: true, source: 'config', engine: 'msys', file: git.file, detail: 'configured bash executable' } }, t)
  assert.equal(configured.summary, en.summaryGitConfigured)
  assert.ok(configured.facts.some(fact => fact.value === `${en.engineMsys}（${en.sourceConfig}）`))
  // Modes that disagree are named, never reduced to one favourite.
  const mixed = statusView({ ...base, modes: [bundled, { ...git, id: 'standard' }] }, t)
  assert.equal(mixed.summary, en.summaryMixed)
  assert.ok(mixed.facts.some(fact => fact.value.includes('ptc=') && fact.value.includes('standard=')))
  // Nothing publishes Bash: the card asks for an executor instead of claiming one.
  assert.equal(statusView({ ...base, modes: [{ ...bundled, enabled: false }] }, t).summary, en.summaryNoShell)
  // A mode that publishes Bash but resolves nothing missing is the actionable case.
  assert.equal(statusView({ ...base, modes: [{ ...bundled, available: false, source: 'missing', engine: 'none', file: undefined }],
    bash: { available: false, source: 'missing', engine: 'none', detail: 'no payload' } }, t).summary, en.summaryMissing)
})

await test('the executor card reads the saved rows and writes exactly one choice', () => {
  assert.deepEqual(readExecutor({}), { engine: 'niubash', path: '' })
  assert.deepEqual(readExecutor({ ptc: { bashPath: 'C:/Git/bin/bash.exe' }, standard: { bashPath: 'C:/Git/bin/bash.exe' } }),
    { engine: 'git', path: 'C:/Git/bin/bash.exe' })
  // An explicitly pinned Niubash tree is the default rung again, not a second engine.
  assert.deepEqual(readExecutor({ ptc: { bashPath: 'C:/dsh-ops/shells/niubash/niu.exe' } }), { engine: 'niubash', path: '' })
  assert.equal(readExecutor({ ptc: { bashPath: 'C:/a/bash.exe' }, minimal: { bashPath: 'C:/b/bash.exe' } }).engine, 'mixed')
  // Selecting the packaged payload removes only the keys that actually exist.
  assert.deepEqual(executorOps({ ptc: { bashPath: 'C:/Git/bin/bash.exe' }, minimal: {} }, { clear: true }),
    [{ op: 'unset', path: ['ptc', 'bashPath'] }])
  // Selecting Git Bash writes every mode row and never invents a preset field.
  assert.deepEqual(executorOps({ presets: { 'acme.chat': { profile: 'native' } } }, { clear: false, file: 'C:/Git/bin/bash.exe' }), [
    { op: 'set', path: ['minimal', 'bashPath'], value: 'C:/Git/bin/bash.exe' },
    { op: 'set', path: ['standard', 'bashPath'], value: 'C:/Git/bin/bash.exe' },
    { op: 'set', path: ['ptc', 'bashPath'], value: 'C:/Git/bin/bash.exe' },
    { op: 'set', path: ['ops-ptc', 'bashPath'], value: 'C:/Git/bin/bash.exe' },
    { op: 'set', path: ['cordis', 'bashPath'], value: 'C:/Git/bin/bash.exe' },
  ])
  // A custom preset that already opted in follows the same choice.
  assert.deepEqual(executorOps({ presets: { acme: { bashPath: 'C:/old/bash.exe' } } }, { clear: true }),
    [{ op: 'unset', path: ['presets', 'acme', 'bashPath'] }])
  assert.equal(executorDiffers({ engine: 'git', path: 'C:/x/bash.exe' }, {}), true)
  assert.equal(executorDiffers({ engine: 'niubash', path: '' }, {}), false)
  assert.equal(executorDiffers({ engine: 'git', path: 'C:/a/bash.exe' }, { ptc: { bashPath: 'C:/a/bash.exe' } }), false)
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
  assert.equal(resolveMergedConfig({ global: { hidePwsh: true }, standard: {} }).standard.config.hidePwsh, true)
  assert.equal(effectiveMode(resolveMergedConfig({ global: { hidePwsh: false }, standard: { hidePwsh: true } }).standard,
    resolveMergedConfig({ global: { hidePwsh: false } }).global).hidePwsh, false)
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

await test('the companion is detected from the profile that holds the loaded package', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-origin-'))
  fs.mkdirSync(path.join(dir, 'node_modules', 'dsh-win-pwsh7'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'node_modules', 'dsh-win-pwsh7', 'package.json'), JSON.stringify({ name: 'dsh-win-pwsh7', version: '9.9.8' }))
  // The host process gets no DSH_PROFILE_DIR (only shell calls do), so the install
  // path is what has to answer there. A sweep would also find the developer's own
  // profiles, which is why the test pins sweep off.
  const from = path.join(dir, 'node_modules', 'dsh-ops', 'lib', 'index.js')
  assert.equal(companionVersion({ env: {}, from, sweep: false, now: () => Date.now() + 3e9 }), '9.9.8')
  assert.equal(companionVersion({ env: {}, from: path.join(dir, 'node_modules', 'dsh-ops', 'lib', 'index.js'), sweep: false, now: () => Date.now() + 4e9 }), '9.9.8')
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-bare-'))
  assert.equal(companionVersion({ env: {}, from: path.join(bare, 'node_modules', 'dsh-ops', 'lib', 'index.js'), sweep: false, now: () => Date.now() + 5e9 }), undefined)
})

await test('an unsaved companion link is never written by saving another switch', () => {
  const raw = {}
  const seen = { pwsh7Installed: true }
  const draft = draftFor(raw, seen)
  assert.equal(draft['other.pwsh7Link'], true, 'the page shows detection')
  assert.deepEqual(changedFields(draft, raw, seen), [], 'an untouched page writes nothing')
  // The operator only changes data capture; the detected link must stay absent.
  assert.deepEqual(changedFields({ ...draft, 'panel.enabled': true }, raw, seen), [{ op: 'set', path: ['panel', 'enabled'], value: true }])
})

await test('a link the operator flips is always written', () => {
  // Installed and detected on, turned off: the explicit off must be saved.
  const installed = draftFor({}, { pwsh7Installed: true })
  assert.deepEqual(changedFields({ ...installed, 'other.pwsh7Link': false }, {}, { pwsh7Installed: true }), [{ op: 'set', path: ['other', 'pwsh7Link'], value: false }])
  // Not installed, turned on: the explicit on must be saved.
  const absent = draftFor({}, { pwsh7Installed: false })
  assert.deepEqual(changedFields({ ...absent, 'other.pwsh7Link': true }, {}, { pwsh7Installed: false }), [{ op: 'set', path: ['other', 'pwsh7Link'], value: true }])
  // A saved value wins over detection and is not rewritten on every save.
  const savedOff = { other: { pwsh7Link: false } }
  const reloaded = draftFor(savedOff, { pwsh7Installed: true })
  assert.equal(reloaded['other.pwsh7Link'], false)
  assert.deepEqual(changedFields(reloaded, savedOff, { pwsh7Installed: true }), [])
})

await test('a linked development install still finds the profile that mounts it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-home-'))
  const pkg = path.join(home, 'checkout', 'dsh-ops')
  fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'dsh-ops', version: '0.0.0' }))
  const profile = path.join(home, 'profiles', 'work')
  const modules = path.join(profile, 'node_modules')
  fs.mkdirSync(path.join(modules, 'dsh-win-pwsh7'), { recursive: true })
  fs.writeFileSync(path.join(modules, 'dsh-win-pwsh7', 'package.json'), JSON.stringify({ name: 'dsh-win-pwsh7', version: '9.9.7' }))
  // A `link:` install is a junction from the profile to the checkout, so the module
  // URL sits outside every profile; matching the mounted package names it anyway.
  // A junction is the Windows spelling of a directory link.
  fs.symlinkSync(pkg, path.join(modules, 'dsh-ops'), process.platform === 'win32' ? 'junction' : 'dir')
  const from = path.join(pkg, 'lib', 'index.js')
  assert.equal(companionVersion({ env: { DSH_HOME: home }, from, sweep: false, now: () => Date.now() + 6e9 }), '9.9.7')
  // A profile that mounts a different copy does not answer for this one.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-other-'))
  fs.mkdirSync(path.join(other, 'profiles', 'work', 'node_modules', 'dsh-win-pwsh7'), { recursive: true })
  fs.writeFileSync(path.join(other, 'profiles', 'work', 'node_modules', 'dsh-win-pwsh7', 'package.json'), JSON.stringify({ name: 'dsh-win-pwsh7', version: '9.9.6' }))
  assert.equal(companionVersion({ env: { DSH_HOME: other }, from, sweep: false, now: () => Date.now() + 7e9 }), undefined)
})

report('settings-rows')
