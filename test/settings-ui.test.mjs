/** Browser interactions exercise real DOM events; the first fixture writes through the host. */
import { JSDOM } from 'jsdom'
import { assert, test, report } from './lib/harness.mjs'
import { profileFixture } from './lib/settings-profile.mjs'
import { shutdown } from './lib/host.mjs'
import { en } from '../lib/client/locales.js'
import { RowForm } from '../lib/client/row-form.js'
import { DiagnosticsSection } from '../lib/client/detail.js'
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
for (const name of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent']) globalThis[name] = dom.window[name]
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const t = (key, params) => String(en[key]).replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? `{${name}}`))
/** The native Switch stand-in: real DOM, same contract (`checked`, `label`, `onChange`). */
const TestSwitch = ({ checked, label, disabled, onChange }) => h('button', {
  type: 'button', role: 'switch', 'aria-checked': String(checked), 'aria-label': label, disabled: disabled === true,
  onClick: () => onChange(!checked),
})
const ready = (value, revision = 'v1') => ({ status: 'ready', writable: true, value, base: {}, user: {}, revision })
const snapshot = { platform: 'win32', managed: [], git: ['C:/Git/bin/bash.exe'], powerShell: { supported: true, guidance: 'Restart DSH.' } }
const ok = value => ({ ok: true, value })
const defaultApi = () => ({
  snapshot: async () => ok(snapshot),
  select: async () => ok({ bashPath: snapshot.git[0], restriction: 'Partial enforcement.' }),
  plan: async action => ok({ id: 'plan-id', action, available: true, details: ['Review installation first.'] }),
  execute: async () => ok({ status: 'completed', effectState: 'applied', message: 'Completed.' }),
})
async function mount(component, props) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const update = next => root.render(h(component, { view: 'page', t, ...next }))
  await act(async () => update(props))
  return { container, render: next => act(async () => update(next)), update, close: async () => { await act(async () => root.unmount()); container.remove() } }
}
const button = (container, text) => [...container.querySelectorAll('button')].find(node => node.textContent === text)
const group = (container, label) => [...container.querySelectorAll('section.ops-group')].find(node => node.querySelector('h4')?.textContent === label)
const switchIn = (node, label) => node.querySelector(`button[role=switch][aria-label="${label}"]`)
const disclosure = (node, label) => node.querySelector(`button[aria-label="${en.expandGroup} ${label}"], button[aria-label="${en.collapseGroup} ${label}"]`)
async function click(node) { assert.ok(node, 'DOM target exists'); await act(async () => node.click()) }
async function expand(container, label) { await click(disclosure(group(container, label), label)) }
const bundleSubject = { kind: 'bundle', pkg: { name: 'dsh-ops', version: '0.5.0', installed: true, enabled: true, rows: [] } }

await test('the page saves only changed switches with the host revision, then reloads with the next one', async () => {
  let observed, mounts = 0, revisions = [], writes = []
  const fixture = await profileFixture('browser-switches', {
    Config: (await import('../lib/settings/merged.js')).Config,
    apply(_ctx, value) { observed = value; mounts++ },
  }, {})
  let pending
  const form = {
    state: ready(fixture.snapshot().value, fixture.snapshot().revision),
    mutate(ops, revision) {
      revisions.push(revision); writes.push(ops)
      return pending = (async () => {
        await fixture.mutate(ops, revision); await fixture.ctx.loader.await()
        form.state = ready(fixture.snapshot().value, fixture.snapshot().revision)
        return true
      })()
    },
  }
  const view = await mount(RowForm, { form, Switch: TestSwitch })
  try {
    const initialMounts = mounts
    await click(switchIn(group(view.container, en.groupGlobal), en.hideOfficialTools))
    await expand(view.container, en.featureStandard)
    await click(switchIn(group(view.container, en.featureStandard), en.swHidePwsh))
    await click(button(view.container, en.save))
    await act(async () => { await pending })
    assert.equal(observed.global.hideOfficialTools, false)
    assert.equal(observed.standard.hidePwsh, false)
    assert.deepEqual(writes[0], [
      { op: 'set', path: ['global', 'hideOfficialTools'], value: false },
      { op: 'set', path: ['standard', 'hidePwsh'], value: false },
    ], 'untouched switches are not written')
    assert.equal(mounts, initialMounts + 1)
    assert.equal(revisions.length, 1)
    const second = []
    const nextForm = { state: ready(fixture.snapshot().value, 'next-revision'), mutate: async (ops, revision) => { second.push([ops, revision]); return true } }
    await view.render({ form: nextForm, Switch: TestSwitch })
    await expand(view.container, en.featurePtc)
    await click(switchIn(group(view.container, en.featurePtc), en.swBash))
    await click(button(view.container, en.save))
    assert.equal(second[0][1], 'next-revision')
    assert.deepEqual(second[0][0], [{ op: 'set', path: ['ptc', 'bash'], value: false }])
  } finally { await view.close(); await shutdown(fixture.ctx) }
})

await test('only non-minimal presets expose adjacent independent resident and dynamic switches', async () => {
  const writes = []
  const form = { state: ready({}), mutate: async ops => { writes.push(ops); return true } }
  const view = await mount(RowForm, { form, Switch: TestSwitch })
  try {
    for (const label of [en.featureMinimal, en.featureStandard, en.featurePtc, en.featureCordis]) {
      await expand(view.container, label)
      const card = group(view.container, label)
      assert.ok(switchIn(card, en.dynamicTools))
      if (label === en.featureMinimal) {
        assert.equal(switchIn(card, en.swResidentTools), null)
      } else {
        const switches = [...card.querySelectorAll('button[role=switch]')]
        const resident = switchIn(card, en.swResidentTools)
        assert.ok(resident)
        assert.equal(switches[switches.indexOf(resident) + 1], switchIn(card, en.dynamicTools))
      }
    }
    await click(switchIn(group(view.container, en.featureStandard), en.swResidentTools))
    assert.equal(switchIn(group(view.container, en.featureStandard), en.dynamicTools).getAttribute('aria-checked'), 'true')
    await click(button(view.container, en.save))
    assert.deepEqual(writes[0], [{ op: 'set', path: ['standard', 'residentTools'], value: false }])
  } finally { await view.close() }
})

await test('custom preset cards save exact nested paths through the real host without losing advanced options', async () => {
  let observed
  const fixture = await profileFixture('custom-preset-page', {
    Config: (await import('../lib/settings/merged.js')).Config, apply(_ctx, config) { observed = config },
  }, { presets: { 'acme.chat': { discovery: true, shell: false, residentNames: ['stat'], allowedTools: ['diff'], extraGuidance: 'Retain this guidance.' } } })
  let pending
  const form = { state: ready(fixture.snapshot().value, fixture.snapshot().revision), mutate(ops, revision) {
    return pending = fixture.mutate(ops, revision).then(() => true)
  } }
  const view = await mount(RowForm, { form, Switch: TestSwitch })
  try {
    await expand(view.container, 'acme.chat')
    const card = group(view.container, 'acme.chat')
    await click(switchIn(card, en.dynamicTools))
    await click(button(view.container, en.save)); await act(async () => { await pending })
    assert.equal(observed.presets['acme.chat'].discovery, false)
    assert.deepEqual(observed.presets['acme.chat'].residentNames, ['stat'])
    assert.deepEqual(observed.presets['acme.chat'].allowedTools, ['diff'])
    assert.equal(observed.presets['acme.chat'].extraGuidance, 'Retain this guidance.')
  } finally { await view.close(); await shutdown(fixture.ctx) }
})

await test('custom PTC files stay required and Shell off saves coherent dependent settings', async () => {
  let observed
  const fixture = await profileFixture('custom-dependent-page', {
    Config: (await import('../lib/settings/merged.js')).Config, apply(_ctx, config) { observed = config },
  }, { presets: { code: { profile: 'ptc' }, shell: { profile: 'shell', hidePwsh: true, bashPath: 'C:/selected/bash.exe', allowSystemShellFallback: true } } })
  let pending
  const form = { state: ready(fixture.snapshot().value, fixture.snapshot().revision), mutate(ops, revision) { return pending = fixture.mutate(ops, revision).then(() => true) } }
  const view = await mount(RowForm, { form, Switch: TestSwitch })
  try {
    await expand(view.container, 'code')
    assert.equal(switchIn(group(view.container, 'code'), en.swFiles).disabled, true)
    assert.match(group(view.container, 'code').textContent, /Typed PTC requires/)
    await expand(view.container, 'shell')
    await click(switchIn(group(view.container, 'shell'), en.swBash))
    await click(button(view.container, en.save)); await act(async () => { await pending })
    assert.equal(observed.presets.shell.shell, false)
    assert.equal(observed.presets.shell.hidePwsh, true, 'saved hiding intent is retained while Shell is disabled')
    assert.equal(observed.presets.shell.bashPath, 'C:/selected/bash.exe')
    assert.equal(observed.presets.shell.allowSystemShellFallback, true)
    assert.equal(observed.presets.code.profile, 'ptc')
  } finally { await view.close(); await shutdown(fixture.ctx) }
})

await test('a preset starts collapsed and reveals its switches on demand', async () => {
  const form = { state: ready({}), mutate: async () => true }
  const view = await mount(RowForm, { form, Switch: TestSwitch })
  try {
    const standard = () => group(view.container, en.featureStandard)
    assert.equal(switchIn(standard(), en.swBash), null, 'presets are collapsed by default')
    assert.equal(disclosure(standard(), en.featureStandard).getAttribute('aria-expanded'), 'false')
    await expand(view.container, en.featureStandard)
    assert.equal(switchIn(standard(), en.swBash)?.getAttribute('aria-checked'), 'true')
    assert.equal(standard().querySelectorAll('button[role=switch]').length, 6)
    await expand(view.container, en.featureStandard)
    assert.equal(switchIn(standard(), en.swBash), null, 'a second click collapses it again')
  } finally { await view.close() }
})

await test('disabling a preset greys its switches without closing the card', async () => {
  const form = { state: ready({}), mutate: async () => true }
  const view = await mount(RowForm, { form, Switch: TestSwitch })
  try {
    const standard = () => group(view.container, en.featureStandard)
    await expand(view.container, en.featureStandard)
    assert.equal(switchIn(standard(), en.swBash).disabled, false)
    await click(switchIn(standard(), en.featureStandard))
    assert.ok(switchIn(standard(), en.swBash), 'the body stays open')
    assert.equal(switchIn(standard(), en.swBash).disabled, true, 'its switches grey out')
    assert.equal(switchIn(standard(), en.swBash).getAttribute('aria-checked'), 'true', 'values are kept')
    await click(switchIn(standard(), en.featureStandard))
    assert.equal(switchIn(standard(), en.swBash).disabled, false, 're-enabling restores them')
  } finally { await view.close() }
})

await test('a bundle switch disables its gated mode switches without losing their value', async () => {
  const form = { state: ready({ global: { hideOfficialTools: true }, standard: { hideOfficialTools: true } }), mutate: async () => true }
  const view = await mount(RowForm, { form, Switch: TestSwitch })
  try {
    const standard = () => group(view.container, en.featureStandard)
    await expand(view.container, en.featureStandard)
    assert.equal(switchIn(standard(), en.hideOfficialTools).disabled, false)
    await click(switchIn(group(view.container, en.groupGlobal), en.hideOfficialTools))
    assert.equal(switchIn(standard(), en.hideOfficialTools).disabled, true, 'gated switch is disabled')
    assert.equal(switchIn(standard(), en.hideOfficialTools).getAttribute('aria-checked'), 'true', 'the saved intent is kept')
    assert.equal(switchIn(standard(), en.swBash).disabled, false, 'ungated switches stay editable')
  } finally { await view.close() }
})

await test('a ready document that does not accept writes is not editable', async () => {
  // The Host used to mark a foreign page with `mode`; rc.5 dropped that field, so
  // `writable: false` is the only signal left and has to gate the form on its own.
  const writes = []
  const form = { state: { status: 'ready', writable: false, value: { global: { hideOfficialTools: true } }, base: {}, user: {}, revision: 'v1' }, mutate: async ops => { writes.push(ops); return true } }
  const view = await mount(RowForm, { form, Switch: TestSwitch })
  try {
    assert.equal(view.container.querySelector('button[role=switch]'), null, 'a read-only document renders no switches')
    assert.equal(view.container.textContent.includes(en.unavailable), true, 'the read-only notice replaces the form')
    assert.deepEqual(writes, [])
  } finally { await view.close() }
})

await test('dirty drafts retain their revision and refused saves never claim success', async () => {
  const calls = [], form = { state: ready({}), mutate: async (...args) => { calls.push(args); return false } }
  const view = await mount(RowForm, { form, Switch: TestSwitch })
  try {
    await expand(view.container, en.featureMinimal)
    await click(switchIn(group(view.container, en.featureMinimal), en.swBash))
    form.state = ready({ standard: { hidePwsh: false } }, 'v2')
    await view.render({ form, Switch: TestSwitch })
    await click(button(view.container, en.save))
    assert.deepEqual(calls, [[[{ op: 'set', path: ['minimal', 'bash'], value: false }], 'v1']])
    assert.match(view.container.textContent, /refused/)
    assert.equal(view.container.textContent.includes(en.saved), false)
    await click(button(view.container, en.reset))
    assert.equal(switchIn(group(view.container, en.featureMinimal), en.swBash).getAttribute('aria-checked'), 'true')
    form.mutate = async () => { throw new Error('Profile is read-only') }
    await click(switchIn(group(view.container, en.featureMinimal), en.swBash))
    await click(button(view.container, en.save))
    assert.match(view.container.textContent, /Profile is read-only/)
  } finally { await view.close() }
})

await test('runtime actions require preview plus explicit execution and retain transport failures after refresh', async () => {
  const calls = [], api = defaultApi()
  api.plan = async action => { calls.push(['plan', action]); return ok({ id: 'reviewed-id', action, available: true, details: ['Standard host installation.'] }) }
  api.execute = async id => { calls.push(['execute', id]); return { ok: false, error: { message: 'Shell row became unavailable' } } }
  const view = await mount(DiagnosticsSection, { subject: bundleSubject, t, api })
  try {
    await click(button(view.container, en.installAction))
    assert.deepEqual(calls, [['plan', 'install-bash']])
    assert.match(view.container.querySelector('[role=region]').textContent, /Standard host installation/)
    await click(button(view.container, en.execute))
    assert.deepEqual(calls, [['plan', 'install-bash'], ['execute', 'reviewed-id']])
    assert.match(view.container.textContent, /Shell row became unavailable/)
    assert.match(view.container.textContent, /Changes may have occurred/)
    assert.equal(view.container.querySelector('[role=region]'), null)
  } finally { await view.close() }
})

await test('cancelled runtime execution preserves unknown effects and unavailable plans cannot execute', async () => {
  const api = defaultApi(); let signal, finish, executions = 0
  api.execute = async (_id, inputSignal) => { executions++; signal = inputSignal; return new Promise(resolve => { finish = () => resolve({ ok: false, error: { message: 'Remote call cancelled after launch.' } }); inputSignal.addEventListener('abort', finish, { once: true }) }) }
  const view = await mount(DiagnosticsSection, { subject: bundleSubject, t, api })
  try {
    await click(button(view.container, en.installAction)); await click(button(view.container, en.execute))
    assert.equal(executions, 1); assert.equal(signal.aborted, false)
    await click(button(view.container, en.cancel))
    assert.equal(signal.aborted, true); assert.match(view.container.textContent, /Changes may have occurred/)
    api.plan = async action => ok({ id: 'blocked', action, available: false, details: [], reason: 'Unsupported platform' })
    await click(button(view.container, en.installAction))
    assert.equal(button(view.container, en.execute).disabled, true)
    assert.equal(executions, 1)
  } finally { finish?.(); await view.close() }
})

await test('an older failed runtime refresh cannot replace a newer successful status', async () => {
  const pending = [], api = defaultApi()
  api.snapshot = () => new Promise((resolve, reject) => pending.push({ resolve, reject }))
  const view = await mount(DiagnosticsSection, { subject: bundleSubject, t, api })
  try {
    await click(button(view.container, en.redetect))
    await act(async () => pending[1].resolve(ok(snapshot)))
    await act(async () => pending[0].reject(new Error('obsolete network failure')))
    assert.equal(view.container.textContent.includes('obsolete network failure'), false)
    assert.equal(button(view.container, en.installAction).disabled, false)
  } finally { await view.close() }
})

await test('unavailable settings expose recovery instructions without an editable form', async () => {
  const view = await mount(RowForm, { form: { state: { status: 'unavailable', value: {} } }, Switch: TestSwitch })
  try { assert.equal(view.container.querySelector('form'), null); assert.match(view.container.textContent, /built-in switch/); assert.equal(view.container.querySelector('[role=switch]'), null) }
  finally { await view.close() }
})

await test('the status section renders only for a live row or a live bundle', async () => {
  const api = defaultApi()
  const cases = [
    [{ kind: 'item', id: 'official' }, false],
    [{ kind: 'row', pkg: bundleSubject.pkg, row: { rowId: 'dsh-ops-panel', moduleName: 'dsh-ops/panel', enabled: true } }, false],
    [{ kind: 'bundle', pkg: { ...bundleSubject.pkg, enabled: false } }, false],
    [{ kind: 'row', pkg: bundleSubject.pkg, row: { rowId: 'dsh-ops', moduleName: 'dsh-ops', enabled: false } }, false],
    [bundleSubject, true],
    [{ kind: 'row', pkg: bundleSubject.pkg, row: { rowId: 'dsh-ops', moduleName: 'dsh-ops', enabled: true } }, true],
  ]
  for (const [subject, rendered] of cases) {
    const view = await mount(DiagnosticsSection, { subject, t, api })
    try {
      assert.equal(view.container.textContent.includes(en.runtime), rendered, JSON.stringify(subject.kind))
      if (rendered) assert.match(view.container.textContent, /win32/)
      else assert.equal(view.container.textContent, '')
    } finally { await view.close() }
  }
})
await test('the companion install previews the resolved version before running', async () => {
  const calls = []
  const api = defaultApi()
  const plugins = {
    listPlugins: async () => [],
    inspect: async spec => { calls.push(['inspect', spec]); return { status: 'accepted', version: '2.3.2' } },
    installBundle: async spec => { calls.push(['install', spec]); return { status: 'completed' } },
  }
  const view = await mount(DiagnosticsSection, { subject: bundleSubject, t, api, plugins })
  try {
    await click(view.container.querySelector(`[aria-label="${en.installPwsh7}"]`))
    assert.deepEqual(calls, [['inspect', 'dsh-win-pwsh7']])
    assert.match(view.container.textContent, /2\.3\.2/)
    await click(button(view.container, en.execute))
    assert.deepEqual(calls, [['inspect', 'dsh-win-pwsh7'], ['install', 'dsh-win-pwsh7']])
    assert.match(view.container.textContent, new RegExp(en.pwsh7Installed.slice(0, 12)))
  } finally { await view.close() }
})

await test('the companion linkage locks the host-shell switches to off', async () => {
  const form = { state: ready({ other: { pwsh7Link: true } }), mutate: async () => true }
  const view = await mount(RowForm, { form, Switch: TestSwitch })
  try {
    const locked = switchIn(group(view.container, en.groupGlobal), en.swHidePwsh)
    assert.equal(locked.disabled, true)
    assert.equal(locked.getAttribute('aria-checked'), 'false')
    assert.equal(switchIn(group(view.container, en.groupGlobal), en.swBash).disabled, false, 'other switches stay editable')
  } finally { await view.close() }
})

await test('an explicit off is named when the companion is already installed', async () => {
  const form = { state: ready({ other: { pwsh7Link: false } }), mutate: async () => true }
  const view = await mount(RowForm, { form, Switch: TestSwitch, pwsh7Installed: true })
  try { assert.match(view.container.textContent, /已手动关闭|Manually turned off/) }
  finally { await view.close() }
})

dom.window.close()
report('settings-ui')
