/**
 * The ops-ptc preset is a runtime registration, not a bundle row.
 *
 * The host registry is the only owner of preset declarations, so this suite
 * drives the real registration module against a stubbed `agentPresets` service:
 * the fragment must yield the full host preset, disposal must release it, one
 * root must never register twice, and a broken fragment must only warn.
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { assert, PACKAGE_ROOT, report, test, waitFor, withTempDir } from './lib/harness.mjs'
import {
  FRAGMENT_FILE,
  PRESET_ID,
  PRESET_PLUGIN,
  appBootAnchors,
  definitionFromPatches,
  readOpsPtcDefinition,
  registerOpsPtcPreset,
  resolveAppBoot,
} from '../lib/presets/ops-ptc/register.js'

const boot = await import('@deepseek-ai/dsh-app-boot')

/** Write a fake `@deepseek-ai/dsh-app-boot` package under one node_modules tree. */
function fakeAppBoot(nodeModules, marker) {
  const dir = path.join(nodeModules, '@deepseek-ai', 'dsh-app-boot')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-app-boot', version: '0.0.0-fixture', type: 'module', main: 'index.js',
  }))
  fs.writeFileSync(path.join(dir, 'index.js'), `export const fixture = ${JSON.stringify(marker)}\nexport function loadOverlayPatches() { return [] }\n`)
  return path.join(dir, 'index.js')
}

/**
 * Copy the compiled registration module into a profile-like install tree that
 * carries no `@deepseek-ai` dependency of its own — the real failing layout.
 * @param {string} dir - the fixture root.
 * @returns {string} the installed `register.js` path.
 */
function installedDshOps(dir) {
  const packageDir = path.join(dir, 'installation', 'node_modules', 'dsh-ops')
  for (const relative of ['package.json', 'lib/adapter/dsh/host.js', 'lib/presets/ops-ptc/register.js']) {
    fs.mkdirSync(path.join(packageDir, path.dirname(relative)), { recursive: true })
    fs.copyFileSync(path.join(PACKAGE_ROOT, relative), path.join(packageDir, relative))
  }
  return path.join(packageDir, 'lib', 'presets', 'ops-ptc', 'register.js')
}

/**
 * A host tree that owns its boot package, reached through a bin symlink exactly
 * like the published `bin/dsh` → `lib/bin.js`.
 * @param {string} dir - the fixture root.
 * @returns {{entry: string, index: string, linked: boolean}} the anchor and the real package file.
 */
function fakeHost(dir) {
  const host = path.join(dir, 'host')
  fs.mkdirSync(path.join(host, 'lib'), { recursive: true })
  const real = path.join(host, 'lib', 'bin.js')
  fs.writeFileSync(real, '')
  const index = fakeAppBoot(path.join(host, 'node_modules'), 'host-entry')
  const linkDir = path.join(dir, 'bin')
  fs.mkdirSync(linkDir, { recursive: true })
  const link = path.join(linkDir, 'dsh')
  try {
    fs.symlinkSync(path.relative(linkDir, real), link)
    return { entry: link, index, linked: true }
  } catch {
    // Windows without symlink rights: the same fallback, anchored on the real file.
    return { entry: real, index, linked: false }
  }
}

await test('the running host copy resolves from the checkout before any fallback', async () => {
  const resolved = await resolveAppBoot()
  assert.ok(resolved !== undefined)
  assert.match(resolved.file, /@deepseek-ai[\\/]dsh-app-boot/)
  assert.equal(typeof resolved.load, 'function')
  const anchors = appBootAnchors()
  assert.match(anchors[0], /register\.js$/, 'the installed copy is always tried first')
})

/**
 * A context double that plays both the row root and the injected child.
 * @param {object} registry - the service the injected context exposes as `agentPresets`.
 * @returns {object} the stub root plus its recorded calls.
 */
function stubRoot(registry) {
  const events = { inject: [], effects: [], disposed: false }
  const root = {
    logger: { warn: () => {} },
    inject(deps, callback) {
      events.inject.push(deps)
      callback(root)
    },
    get(name) {
      return name === 'agentPresets' ? registry : undefined
    },
    effect(callback, label) {
      const cleanup = callback()
      events.effects.push({ label, cleanup })
      return () => {}
    },
  }
  return { root, events }
}

/** A registry double: records the definition and answers with a counting disposer. */
function stubRegistry() {
  const state = { definitions: [], disposed: 0, fail: undefined }
  return {
    state,
    register(definition) {
      state.definitions.push(definition)
      if (state.fail !== undefined) return Promise.reject(state.fail)
      return Promise.resolve(async () => { state.disposed += 1 })
    },
  }
}

await test('the shipped fragment resolves from the built module and yields the host preset', () => {
  assert.equal(PRESET_ID, 'ops-ptc')
  assert.equal(PRESET_PLUGIN, '@deepseek-ai/dsh-agent-preset')
  assert.equal(FRAGMENT_FILE, path.join(PACKAGE_ROOT, 'presets', 'ops-ptc.patch.yml'))
  assert.ok(fs.existsSync(FRAGMENT_FILE), 'the fragment ships beside the compiled module')
})

await test('a root registers the full ops-ptc definition through the host preset registry', async () => {
  const registry = stubRegistry()
  const { root } = stubRoot(registry)
  registerOpsPtcPreset(root)
  await waitFor(() => registry.state.definitions.length === 1, { what: 'the ops-ptc registration' })
  const definition = registry.state.definitions[0]
  assert.equal(definition.id, 'ops-ptc')
  assert.equal(definition.order, 6)
  assert.equal(definition.name, 'OPS (PTC)')
  assert.ok(definition.plugins.length >= 20, `the definition carries the upstream plugin list, got ${definition.plugins.length}`)
  const names = definition.plugins.map(plugin => plugin.name)
  assert.ok(names.includes('@deepseek-ai/dsh-tool-executor-ptc'), 'the PTC executor row is present')
  // The host dialect survives parsing: platform expressions stay unevaluated data.
  const bash = definition.plugins.find(plugin => plugin.id === 'tool-bash')
  assert.ok(bash !== undefined && typeof bash.disabled === 'object' && bash.disabled !== null, 'the !!js expression is preserved for the loader')
})

await test('the preset fragment is parsed by the host loader, not by this plugin', async () => {
  const definition = await readOpsPtcDefinition({}, { logger: { warn: () => {} } })
  assert.ok(definition !== undefined)
  assert.equal(definition.id, 'ops-ptc')
})

await test('disposing the injected fiber releases the registration', async () => {
  const registry = stubRegistry()
  const { root, events } = stubRoot(registry)
  registerOpsPtcPreset(root)
  await waitFor(() => registry.state.definitions.length === 1, { what: 'the ops-ptc registration' })
  const effect = events.effects.find(entry => entry.label === 'dsh-ops: ops-ptc preset')
  assert.ok(effect !== undefined, 'the registration is owned by a tracked effect')
  effect.cleanup()
  assert.equal(registry.state.disposed, 1)
})

await test('the real Cordis fiber owns the registration and releases it on disposal', async () => {
  const ctx = new Context()
  ctx.logger.level = 0
  const registry = stubRegistry()
  ctx.provide('agentPresets', registry)
  registerOpsPtcPreset(ctx)
  await waitFor(() => registry.state.definitions.length === 1, { what: 'the real injection' })
  assert.equal(registry.state.definitions[0].id, 'ops-ptc')
  await ctx.fiber.dispose()
  await waitFor(() => registry.state.disposed === 1, { what: 'the fiber disposal to release the preset' })
})

await test('one root never registers the preset twice', async () => {
  const registry = stubRegistry()
  const { root, events } = stubRoot(registry)
  registerOpsPtcPreset(root)
  registerOpsPtcPreset(root)
  await waitFor(() => registry.state.definitions.length === 1, { what: 'the ops-ptc registration' })
  assert.equal(events.inject.length, 1, 'the second call must not inject again')
  assert.equal(registry.state.definitions.length, 1)
})

await test('a deployment without the preset registry is left alone', () => {
  const { root, events } = stubRoot({ composedPreset: () => undefined })
  registerOpsPtcPreset(root)
  assert.equal(events.inject.length, 1)
  assert.deepEqual(events.effects, [])
})

await test('a missing fragment only warns; it never throws into apply', async () => {
  const warnings = []
  const definition = await readOpsPtcDefinition({ file: path.join(PACKAGE_ROOT, 'presets', 'missing.patch.yml'), warn: message => warnings.push(message) },
    { logger: { warn: () => {} } })
  assert.equal(definition, undefined)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /cannot read the ops-ptc preset fragment/)
})

await test('a malformed fragment only warns; it never throws into apply', async () => {
  await withTempDir('preset-registration', async dir => {
    const file = path.join(dir, 'broken.patch.yml')
    fs.writeFileSync(file, 'not-a-list: true\n')
    const warnings = []
    const definition = await readOpsPtcDefinition({ file, warn: message => warnings.push(message) }, { logger: { warn: () => {} } })
    assert.equal(definition, undefined)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /cannot read the ops-ptc preset fragment/)
  })
})

await test('a fragment without the preset row warns instead of registering something else', async () => {
  const warnings = []
  const load = () => [{ insert: [{ id: 'preset-other', name: PRESET_PLUGIN, config: { id: 'other', plugins: [] } }] }]
  const definition = await readOpsPtcDefinition({ load, warn: message => warnings.push(message) }, { logger: { warn: () => {} } })
  assert.equal(definition, undefined)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /declares no ops-ptc preset/)
  assert.throws(() => definitionFromPatches([{ insert: [{ name: PRESET_PLUGIN, config: { id: PRESET_ID, plugins: [] } }] }]),
    /declares no child plugins/)
})

await test('a rejected registration promise only warns', async () => {
  const registry = stubRegistry()
  registry.state.fail = new Error('activation failed')
  const warnings = []
  const { root } = stubRoot(registry)
  registerOpsPtcPreset(root, { load: boot.loadOverlayPatches, warn: message => warnings.push(message) })
  await waitFor(() => warnings.length === 1, { what: 'the registration failure warning' })
  assert.match(warnings[0], /cannot register the ops-ptc agent preset: activation failed/)
})

await test('the host entry anchor resolves app-boot when the install does not hoist it', async () => {
  await withTempDir('preset-registration-layout', async dir => {
    const registerFile = installedDshOps(dir)
    const host = fakeHost(dir)
    const installed = await import(pathToFileURL(registerFile).href)
    assert.equal(await installed.resolveAppBoot(path.join(dir, 'missing', 'host.js')), undefined,
      'the installed tree alone cannot see the host package')
    // The published bin is a symlink: anchored on it, require resolves from the
    // bin directory and misses the host package. That is the bug this fallback fixes.
    if (host.linked) {
      assert.throws(() => createRequire(host.entry).resolve('@deepseek-ai/dsh-app-boot'),
        /MODULE_NOT_FOUND|Cannot find module/)
    }
    const resolved = await installed.resolveAppBoot(host.entry)
    assert.ok(resolved !== undefined, 'the host entry anchor finds the host copy')
    assert.equal(fs.realpathSync(resolved.file), fs.realpathSync(host.index))
    assert.deepEqual(resolved.load('dsh-ops', 'ignored'), [])
  })
})

await test('a hoisted profile copy is used before any host fallback', async () => {
  await withTempDir('preset-registration-hoist', async dir => {
    const registerFile = installedDshOps(dir)
    const hoisted = fakeAppBoot(path.join(dir, 'installation', 'node_modules'), 'hoisted')
    const installed = await import(pathToFileURL(registerFile).href)
    const resolved = await installed.resolveAppBoot(path.join(dir, 'missing', 'host.js'))
    assert.ok(resolved !== undefined)
    assert.equal(fs.realpathSync(resolved.file), fs.realpathSync(hoisted), 'the first anchor wins when the profile hoists the package')
  })
})

await test('an unresolvable host package only warns; it never throws into apply', async () => {
  await withTempDir('preset-registration-unresolved', async dir => {
    const installed = await import(pathToFileURL(installedDshOps(dir)).href)
    const warnings = []
    const definition = await installed.readOpsPtcDefinition(
      { hostEntry: path.join(dir, 'missing', 'host.js'), warn: message => warnings.push(message) },
      { logger: { warn: () => {} } },
    )
    assert.equal(definition, undefined)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /cannot resolve @deepseek-ai\/dsh-app-boot/)
  })
})

report('preset-registration')
