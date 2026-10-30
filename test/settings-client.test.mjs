/** The real host SlotRegistry owns the loaded browser contribution and its teardown. */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'
import * as Cordis from '@deepseek-ai/cordis'
import * as slots from '@deepseek-ai/dsh-client-ui-slots'
import Registry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import { RuntimeActions } from '../lib/settings/runtime-actions.js'
import { RUNTIME_DESCRIPTORS } from '../lib/settings/runtime-contract.js'
import { bundleClient } from '../scripts/lib/build/client.mjs'
import { assert, test, report, PACKAGE_ROOT, TEST_HOME, withTempDir } from './lib/harness.mjs'
import { shutdown } from './lib/host.mjs'
const require = createRequire(import.meta.url)
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>')
globalThis.document = dom.window.document
function capture(file) {
  let definition
  globalThis.window = { __ModuleLoader__: { load: value => { definition = value } } }
  vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file })
  assert.ok(definition); return definition
}
// The Host answers this module name itself (it is not a package on disk); the stub
// only has to exist so the shipped bundle resolves, because this suite never renders.
const primitives = { Switch: () => null }
const external = name => name === '@deepseek-ai/cordis' ? Cordis
  : name === '@deepseek-ai/dsh-client-ui-slots' ? slots
    : name === '@deepseek-ai/dsh-client-ui-primitives' ? primitives
      : require(name)

await test('shipped browser entry stays lazy and binds the one row page plus one detail section to the real host registry', async () => {
  const definition = capture(path.join(PACKAGE_ROOT, 'lib/client.js')), imports = []
  assert.equal(definition.id, 'dsh-ops'); assert.equal(typeof definition.factory, 'function')
  assert.deepEqual(imports, [])
  const plugin = definition.factory(name => { imports.push(name); return external(name) })
  assert.deepEqual([...new Set(imports)].sort(), ['@deepseek-ai/dsh-client-ui-primitives', 'react', 'react/jsx-runtime'])
  const Renderer = capture(path.join(PACKAGE_ROOT, 'node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js')).factory(external)
  const ctx = new Cordis.Context(); ctx.logger.level = 0
  let dictionaries, disposed = false, calls = 0, markStarted
  const started = new Promise(resolve => { markStarted = resolve })
  try {
    await ctx.plugin(Renderer.SlotRegistry)
    await ctx.plugin(Registry); await ctx.plugin(Gateway, {})
    const ClientGateway = capture(path.join(PACKAGE_ROOT, 'node_modules/@deepseek-ai/dsh-api-gateway/lib/client.js')).factory(external)
    await ctx.plugin({ inject: ['typert'], apply(inner) {
      const service = new RuntimeActions({ env: { DSH_HOME: path.join(TEST_HOME, 'client-runtime') }, platform: 'win32', arch: 'x64', run: async (_argv, signal) => {
        calls++; markStarted(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
        return { started: true, exitCode: null, signal: 'aborted' }
      } })
      inner.provide('opsSettings', service)
      inner.typert.register({ package: 'dsh-ops', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: RUNTIME_DESCRIPTORS })
      inner.effect(() => () => service.dispose())
      inner.provide('connection', { registerGenerationSource: () => () => {}, start: () => ({ stop() {} }), generation: { getSnapshot: () => undefined, subscribe: () => () => {} }, rpc: {
        open() { throw new Error('No streams in this fixture') },
        async call(prefix, endpoint, payload, signal) {
          assert.equal(prefix, '/api')
          const [namespace, method] = endpoint.split('/')
          return { ok: true, value: await ctx.typertGateway.invoke({ namespace, method, args: payload.args, signal }) }
        },
      } })
    } })
    await ctx.plugin(ClientGateway)
    await ctx.plugin({ inject: ['slots'], apply(inner) {
      inner.provide('locale', { register(namespace, values) { dictionaries = { namespace, values }; return () => { disposed = true } } })
      inner.slots.register({ name: 'root', children: {
        'plugins.row.config': { kind: 'keyed', scope: 'root' },
        'plugins.detail.section': { kind: 'list', scope: 'root' },
      } }, () => null)
    } })
    const fiber = await ctx.plugin(plugin)
    const plan = await ctx.get('remote').opsSettings.plan('install-bash')
    assert.equal(plan.ok, true); assert.equal(calls, 0)
    const controller = new AbortController()
    const execution = ctx.get('remote').opsSettings.execute(plan.value.id, controller.signal)
    await Promise.race([started, execution.then(value => { throw new Error(`Execution ended before spawn: ${JSON.stringify(value)}`) })])
    assert.equal(calls, 1); controller.abort()
    const result = await execution
    assert.equal(result.ok, false); assert.match(result.error.message, /abort/i)
    assert.equal(dictionaries.namespace, 'dshOps')
    assert.deepEqual(Object.keys(dictionaries.values.en).sort(), Object.keys(dictionaries.values.zh).sort())
    assert.deepEqual(ctx.get('slots').entries('plugins.row.config').map(value => value.options.key), ['dsh-ops#dsh-ops'])
    assert.deepEqual(ctx.get('slots').entries('plugins.detail.section').map(value => value.options.id), ['dsh-ops.diagnostics'])
    assert.equal(ctx.get('slots').entries('plugins.detail.section')[0].options.order, 50)
    assert.equal(document.querySelectorAll('style[data-dsh-ops-settings]').length, 1)
    await fiber.dispose()
    assert.equal(ctx.get('slots').entries('plugins.row.config').length, 0)
    assert.equal(ctx.get('slots').entries('plugins.detail.section').length, 0)
    assert.equal(document.querySelectorAll('style[data-dsh-ops-settings]').length, 0)
    assert.equal(disposed, true)
  } finally { await shutdown(ctx) }
})

await test('browser bundler rejects Node externals and dynamic imports before writing an entry', () => withTempDir('browser-build-boundaries', root => {
  const directory = path.join(root, 'lib/client'); fs.mkdirSync(directory, { recursive: true })
  for (const source of ["import fs from 'node:fs'; export const value=fs", "export async function value(name) { return import(name) }"]) {
    fs.writeFileSync(path.join(directory, 'index.js'), source)
    assert.throws(() => bundleClient(root), /Unsupported browser external|Dynamic browser import/)
    assert.equal(fs.existsSync(path.join(root, 'lib/client.js')), false)
  }
  fs.writeFileSync(path.join(directory, 'index.js'), "import { answer } from './answer.js'; export const value=answer")
  fs.writeFileSync(path.join(directory, 'answer.js'), 'export const answer=42')
  bundleClient(root)
  const loaded = capture(path.join(root, 'lib/client.js')).factory(() => { throw new Error('unexpected external') })
  assert.equal(loaded.value, 42)
}))

await test('browser package declares its client facet and the bundle keeps the single row', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json')))
  assert.equal(pkg.exports['./client'].default, './lib/client.js')
  assert.equal(pkg.dsh.client.platform, 'web')
  // The bundle page reads this bundle's slot entries, so the browser half must be
  // materialized at boot rather than on first use.
  assert.equal(pkg.dsh.client.immediately, true)
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-plugin-manager'))
  // The row pages bind the host's native Switch, so the module must be declared.
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-primitives'))
  // The bundle inserts one row named like the package, so the browser half mounts
  // there and no carrier bundle is needed.
  assert.match(fs.readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8'), /- id: dsh-ops\s+name: dsh-ops\s/)
  for (const component of ['mode-minimal', 'mode-standard', 'mode-ptc', 'mode-cordis']) {
    assert.equal(pkg.exports[`./${component}`].default, `./lib/components/${component}/index.js`, component)
  }
  // A saved legacy row stays loadable even though the bundle no longer inserts it.
  assert.equal(pkg.exports['./file'].default, './lib/components/file/index.js')
})
dom.window.close()
report('settings-client')
