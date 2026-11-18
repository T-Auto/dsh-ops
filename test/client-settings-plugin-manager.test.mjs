/**
 * The settings page must actually ask the host's own installer (#750).
 *
 * The row's pwsh7 detection reads the `remote.pluginManager` service. A traced
 * registry value may only be read through a context that declares the
 * dependency, so a page that resolves it without one reported "not installed"
 * forever while every other part kept working. This suite mounts the shipped
 * browser bundle on a real Cordis host and witnesses the installer roundtrip.
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'
import * as Cordis from '@deepseek-ai/cordis'
import * as slots from '@deepseek-ai/dsh-client-ui-slots'
import { assert, test, report, waitFor, PACKAGE_ROOT } from './lib/harness.mjs'
import { shutdown } from './lib/host.mjs'

const require = createRequire(import.meta.url)
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>')
globalThis.document = dom.window.document

/** Load one browser bundle the way the host's ModuleLoader does. */
function capture(file) {
  let definition
  globalThis.window = { __ModuleLoader__: { load: value => { definition = value } } }
  vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file })
  assert.ok(definition)
  return definition
}

/**
 * Resolve one package's `./client` condition to the file a Client row loads.
 * @param {string} name - the package whose Client entry is wanted.
 * @returns {string} absolute path of the entry file.
 */
const clientEntry = name => {
  const exported = require(`${name}/package.json`).exports['./client']
  const file = typeof exported === 'string' ? exported : exported.default
  return path.join(PACKAGE_ROOT, 'node_modules', name, file)
}

const primitives = { Switch: () => null }
const external = name => name === '@deepseek-ai/cordis' ? Cordis
  : name === '@deepseek-ai/dsh-client-ui-slots' ? slots
    : name === '@deepseek-ai/dsh-client-ui-primitives' ? primitives
      : require(name)

await test('the shipped settings bundle asks the host installer about dsh-win-pwsh7 (#750)', async () => {
  const definition = capture(path.join(PACKAGE_ROOT, 'lib/client.js'))
  const plugin = definition.factory(external)
  const Renderer = capture(clientEntry('@deepseek-ai/dsh-client-ui-renderer')).factory(external)
  const ctx = new Cordis.Context()
  ctx.logger.level = 0
  let listCalls = 0
  try {
    await ctx.plugin(Renderer.SlotRegistry)
    // The gateway-less minimal remote: mounting still succeeds and the status
    // card reports the miss instead of pretending the runtime is fine.
    ctx.provide('remote', { async $mount() { return undefined } })
    // The host's own installer, as the plugin-manager face provides it.
    ctx.provide('remote.pluginManager', {
      async listPlugins() {
        listCalls += 1
        return [{ entryId: 'dsh-win-pwsh7', moduleName: 'dsh-win-pwsh7' }]
      },
      async installBundle() { return { ok: true } },
    })
    await ctx.plugin({ inject: ['slots'], apply(inner) {
      inner.provide('locale', { register: () => () => {} })
      inner.slots.register({ name: 'root', children: {
        'plugins.row.config': { kind: 'keyed', scope: 'root' },
        'plugins.detail.section': { kind: 'list', scope: 'root' },
      } }, () => null)
    } })
    const fiber = await ctx.plugin(plugin)
    try {
      await waitFor(() => listCalls === 1, { what: 'the pwsh7 detection roundtrip' })
      assert.equal(listCalls, 1, 'the detection asks the host installer exactly once')
    } finally { await fiber.dispose() }
  } finally { await shutdown(ctx) }
})

report('client-settings-plugin-manager')
