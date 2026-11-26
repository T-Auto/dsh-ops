/** Exercise the separately mounted plugin manager through the shipped settings bundle (#750). */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'
import * as Cordis from '@deepseek-ai/cordis'
import * as slots from '@deepseek-ai/dsh-client-ui-slots'
import { assert, test, report, PACKAGE_ROOT } from './lib/harness.mjs'
import { shutdown } from './lib/host.mjs'
import { en } from '../lib/client/locales.js'

const require = createRequire(import.meta.url)
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
for (const name of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event']) globalThis[name] = dom.window[name]
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, Fragment, act } = await import('react')
const { createRoot } = await import('react-dom/client')

/** Load one browser bundle the way the host's ModuleLoader does. */
function capture(file) {
  let definition
  window.__ModuleLoader__ = { load: value => { definition = value } }
  try { vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file }) }
  finally { delete window.__ModuleLoader__ }
  assert.ok(definition)
  return definition
}

const clientEntry = name => {
  const exported = require(name + '/package.json').exports['./client']
  const file = typeof exported === 'string' ? exported : exported.default
  return path.join(PACKAGE_ROOT, 'node_modules', name, file)
}

const primitives = { Switch: () => null }
const external = name => name === '@deepseek-ai/cordis' ? Cordis
  : name === '@deepseek-ai/dsh-client-ui-slots' ? slots
    : name === '@deepseek-ai/dsh-client-ui-primitives' ? primitives
      : require(name)

const ok = value => ({ ok: true, value })
const installed = { entryId: 'include:win-pwsh7', moduleName: 'dsh-win-pwsh7', version: '0.2.10' }
const subject = { kind: 'bundle', pkg: { name: 'dsh-ops', enabled: true, rows: [] } }
const snapshot = { platform: 'win32', modes: [], managed: [], git: [], powerShell: { supported: true } }
const t = key => String(en[key] ?? key)

async function withSettings(body, initialInstaller) {
  const plugin = capture(path.join(PACKAGE_ROOT, 'lib/client.js')).factory(external)
  const renderer = capture(clientEntry('@deepseek-ai/dsh-client-ui-renderer')).factory(external)
  const ctx = new Cordis.Context()
  ctx.logger.level = 0
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const form = {
    state: { value: {}, revision: 1, status: 'ready', writable: true },
    async mutate() { throw new Error('Unexpected write') },
  }
  let listCalls = 0
  try {
    await ctx.plugin(renderer.SlotRegistry)
    ctx.provide('remote', { async $mount() { return undefined } })
    ctx.provide('remote.opsSettings', { async snapshot() { return ok(snapshot) } })
    if (initialInstaller) ctx.provide('remote.pluginManager', initialInstaller)
    await ctx.plugin({ inject: ['slots'], apply(inner) {
      inner.provide('locale', { register: () => () => {} })
      inner.slots.register({ name: 'root', children: {
        'plugins.row.config': { kind: 'keyed', scope: 'root' },
        'plugins.detail.section': { kind: 'list', scope: 'root' },
      } }, () => null)
    } })
    await ctx.plugin(plugin)
    const [section] = ctx.get('slots').entries('plugins.detail.section')
    const [config] = ctx.get('slots').entries('plugins.row.config')
    await act(async () => root.render(h(Fragment, null,
      h(section.component, { subject, t }), h(config.component, { form, view: 'page', t }))))
    const installButton = () => container.querySelector('[aria-label="' + en.installPwsh7 + '"]')
    const companion = () => [...container.querySelectorAll('dt')].find(node => node.textContent === en.pwsh7Plugin)?.nextElementSibling
    const mountManager = async (reply) => {
      const before = listCalls
      let remove
      await act(async () => {
        remove = ctx.provide('remote.pluginManager', {
          listPlugins() {
            listCalls += 1
            return typeof reply === 'function' ? reply() : Promise.resolve(reply)
          },
          async installBundle() { throw new Error('Unexpected install') },
        })
      })
      assert.ok(listCalls > before, 'the mounted settings views must query the late namespace')
      return () => act(async () => { await remove() })
    }
    await body({ container, companion, installButton, mountManager })
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await shutdown(ctx)
  }
}

await test('a late installer refreshes the mounted card and preserves the executor draft', () => withSettings(async fixture => {
  assert.ok(fixture.container.querySelector('form'), 'the row is editable before the manager mounts')
  assert.equal(fixture.installButton(), null)
  const git = fixture.container.querySelectorAll('input[name="ops-executor"]')[1]
  await act(async () => git.click())
  const input = fixture.container.querySelector('.ops-input[type=text]')
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, 'C:/draft/bash.exe')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  assert.equal(fixture.container.querySelector('button[type=submit]').disabled, false)
  const remove = await fixture.mountManager(ok([installed]))
  assert.equal(fixture.companion().textContent, 'Available（0.2.10）')
  assert.equal(fixture.installButton(), null)
  assert.equal(fixture.container.querySelector('.ops-input[type=text]'), input, 'late injection must keep the form mounted')
  assert.equal(input.value, 'C:/draft/bash.exe')
  await remove()
  assert.equal(fixture.companion().textContent, 'Plugin status unavailable')
  assert.equal(input.value, 'C:/draft/bash.exe')
}))

await test('only a successful inventory without the companion offers installation', () => withSettings(async fixture => {
  const release = await fixture.mountManager({ ok: false, error: { message: 'inventory unavailable' } })
  assert.equal(fixture.companion().textContent, 'Plugin status unavailable')
  assert.equal(fixture.installButton(), null)
  await release()
  await fixture.mountManager(ok([]))
  assert.ok(fixture.installButton())
  assert.match(fixture.companion().textContent, /^Not installed/)
}))

await test('a synchronous installer failure leaves both settings views available', () => withSettings(async fixture => {
  await fixture.mountManager(() => { throw new Error('installer unloaded') })
  assert.equal(fixture.companion().textContent, 'Plugin status unavailable')
  assert.equal(fixture.installButton(), null)
  assert.ok(fixture.container.querySelector('form'))
}))

await test('an already mounted installer with a pending inventory leaves the rest of settings editable', async () => {
  let finish
  const inventory = new Promise(resolve => { finish = resolve })
  await withSettings(async fixture => {
    const form = fixture.container.querySelector('form')
    assert.ok(form, 'only the companion status waits for the inventory')
    assert.equal(fixture.installButton(), null)
    await act(async () => finish(ok([])))
    assert.equal(fixture.container.querySelector('form'), form)
    assert.ok(fixture.installButton())
  }, { listPlugins: () => inventory })
})

await test('installer detection follows the module package, including its exported rows', () => withSettings(async fixture => {
  const removeOther = await fixture.mountManager(ok([{ entryId: 'include:dsh-win-pwsh7', patchId: 'dsh-win-pwsh7',
    moduleName: 'dsh-win-pwsh7-preview' }]))
  assert.ok(fixture.installButton(), 'a different module with a similar name is not the companion')
  await removeOther()
  const removeInvalid = await fixture.mountManager(ok([{}]))
  assert.equal(fixture.companion().textContent, en.pwsh7Unknown)
  assert.equal(fixture.installButton(), null)
  await removeInvalid()
  await fixture.mountManager([{ moduleName: 'dsh-win-pwsh7/client' }])
  assert.equal(fixture.companion().textContent, en.pwsh7Present)
}))

dom.window.close()
report('client-settings-plugin-manager')
