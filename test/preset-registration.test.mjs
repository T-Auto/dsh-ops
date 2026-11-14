/**
 * The ops-ptc preset is a runtime registration, not a bundle row.
 *
 * The host registry is the only owner of preset declarations, so this suite
 * drives the real registration module against a stubbed `agentPresets` service:
 * the fragment must yield the full host preset, disposal must release it, one
 * root must never register twice, and a broken fragment must only warn.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { assert, PACKAGE_ROOT, report, test, waitFor, withTempDir } from './lib/harness.mjs'
import { componentProfile } from './lib/component-profile.mjs'
import { shutdown } from './lib/host.mjs'
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
 * A registry double: records the definition, answers with a counting disposer,
 * and exposes the `config`/`defaultId` pair the default switch reads.
 * @param {string} [selected] - the already-saved `selectedDefault`, if any.
 * @returns {object} the registry double with its recorded state.
 */
function stubRegistry(selected) {
  const state = { definitions: [], disposed: 0, fail: undefined, selected, updates: [], order: [] }
  return {
    state,
    config: { default: 'standard', selectedDefault: { get: () => state.selected } },
    get defaultId() { return state.selected ?? 'standard' },
    register(definition) {
      state.definitions.push(definition)
      state.order.push('register')
      if (state.fail !== undefined) return Promise.reject(state.fail)
      return Promise.resolve(async () => { state.disposed += 1 })
    },
  }
}

/**
 * A settings-service double: records each update and applies the volatile write
 * to the registry state, exactly as the host hot-applies it.
 * @param {object} registry - the registry the written default belongs to.
 * @param {Error} [fail] - make the write reject, for the failure path.
 * @returns {object} the settings service.
 */
function stubSettings(registry, fail) {
  return {
    async update(namespace, patch) {
      registry.state.updates.push({ namespace, patch: { ...patch } })
      registry.state.order.push('default')
      if (fail !== undefined) throw fail
      if (typeof patch.selectedDefault === 'string') registry.state.selected = patch.selectedDefault
    },
  }
}

/**
 * A context double that plays both the row root and the injected child.
 * @param {object} registry - the service the injected context exposes as `agentPresets`.
 * @param {object|null} [settings] - the service exposed as `settings`; defaults to a recording writer.
 * @returns {object} the stub root plus its recorded calls.
 */
function stubRoot(registry, settings) {
  const events = { inject: [], effects: [] }
  const services = { agentPresets: registry, settings: settings === undefined ? stubSettings(registry) : settings }
  const root = {
    logger: { warn: () => {} },
    inject(deps, callback) {
      events.inject.push(deps)
      callback(root)
    },
    get(name) {
      return services[name]
    },
    effect(callback, label) {
      const cleanup = callback()
      events.effects.push({ label, cleanup })
      return () => {}
    },
  }
  return { root, events }
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
  await effect.cleanup()
  await waitFor(() => registry.state.disposed === 1, { what: 'the released registration' })
})

await test('the real Cordis fiber owns the registration and releases it on disposal', async () => {
  const ctx = new Context()
  ctx.logger.level = 0
  const registry = stubRegistry()
  ctx.provide('agentPresets', registry)
  ctx.provide('settings', stubSettings(registry))
  registerOpsPtcPreset(ctx)
  await waitFor(() => registry.state.definitions.length === 1, { what: 'the real injection' })
  assert.equal(registry.state.definitions[0].id, 'ops-ptc')
  await waitFor(() => registry.state.selected === 'ops-ptc', { what: 'the forced default through the real fiber' })
  assert.deepEqual(registry.state.order, ['register', 'default'])
  await ctx.fiber.dispose()
  await waitFor(() => registry.state.disposed === 1, { what: 'the fiber disposal to release the preset' })
  await waitFor(() => registry.state.selected === 'standard', { what: 'the restored official default' })
})

await test('one injected activation never registers the preset twice', async () => {
  const registry = stubRegistry()
  const { root } = stubRoot(registry)
  registerOpsPtcPreset(root)
  registerOpsPtcPreset(root)
  await waitFor(() => registry.state.definitions.length === 1, { what: 'the ops-ptc registration' })
  await new Promise(resolve => setImmediate(resolve))
  // The Loader reuses the row context across a remount, so the guard lives on
  // the injected activation; a repeated call on the same one stays a no-op.
  assert.equal(registry.state.definitions.length, 1, 'one registration per activation')
})

/** Wait for a registration to settle, then confirm nothing else writes the default. */
async function settle(registry) {
  await waitFor(() => registry.state.definitions.length === 1, { what: 'the ops-ptc registration' })
  await new Promise(resolve => setImmediate(resolve))
}

await test('force=true writes ops-ptc only after the registration succeeded', async () => {
  const registry = stubRegistry()
  const { root } = stubRoot(registry)
  registerOpsPtcPreset(root, { forceDefault: true })
  await waitFor(() => registry.state.updates.length === 1, { what: 'the forced default' })
  assert.deepEqual(registry.state.updates[0], { namespace: 'agent-preset-registry', patch: { selectedDefault: 'ops-ptc' } })
  assert.deepEqual(registry.state.order, ['register', 'default'], 'the preset is registered before the default changes')
  assert.equal(registry.defaultId, 'ops-ptc')
})

await test('force=true with ops-ptc already default writes nothing', async () => {
  const registry = stubRegistry('ops-ptc')
  const { root } = stubRoot(registry)
  registerOpsPtcPreset(root, { forceDefault: true })
  await settle(registry)
  assert.deepEqual(registry.state.updates, [])
})

await test('force=false restores the official default when ops-ptc is the leftover', async () => {
  const registry = stubRegistry('ops-ptc')
  const { root } = stubRoot(registry)
  registerOpsPtcPreset(root, { forceDefault: false })
  await waitFor(() => registry.state.updates.length === 1, { what: 'the restore write' })
  assert.deepEqual(registry.state.updates[0], { namespace: 'agent-preset-registry', patch: { selectedDefault: 'standard' } })
  assert.equal(registry.defaultId, 'standard')
})

await test('force=false leaves a default the operator chose alone', async () => {
  const registry = stubRegistry('ptc')
  const { root } = stubRoot(registry)
  registerOpsPtcPreset(root, { forceDefault: false })
  await settle(registry)
  assert.deepEqual(registry.state.updates, [])
  assert.equal(registry.defaultId, 'ptc')
})

await test('disposal restores the selection captured before forcing', async () => {
  const registry = stubRegistry('ptc')
  const { root, events } = stubRoot(registry)
  registerOpsPtcPreset(root, { forceDefault: true })
  await waitFor(() => registry.state.selected === 'ops-ptc', { what: 'the forced default' })
  const effect = events.effects.find(entry => entry.label === 'dsh-ops: ops-ptc preset')
  await effect.cleanup()
  await waitFor(() => registry.state.selected === 'ptc', { what: 'the operator default restored on teardown' })
  assert.deepEqual(registry.state.updates.map(entry => entry.patch.selectedDefault), ['ops-ptc', 'ptc'])
})

await test('disposal with no saved selection restores the official default', async () => {
  const registry = stubRegistry()
  const { root, events } = stubRoot(registry)
  registerOpsPtcPreset(root, { forceDefault: true })
  await waitFor(() => registry.state.selected === 'ops-ptc', { what: 'the forced default' })
  const effect = events.effects.find(entry => entry.label === 'dsh-ops: ops-ptc preset')
  await effect.cleanup()
  await waitFor(() => registry.state.selected === 'standard', { what: 'the official default restored on teardown' })
})

await test('a remount teardown restore is settled by the replacement activation', async () => {
  const registry = stubRegistry()
  const first = stubRoot(registry)
  registerOpsPtcPreset(first.root, { forceDefault: true })
  await waitFor(() => registry.state.selected === 'ops-ptc', { what: 'the forced default' })
  const effect = first.events.effects.find(entry => entry.label === 'dsh-ops: ops-ptc preset')
  await effect.cleanup()
  // The Loader mounts a replacement fiber from the same row; it awaits the
  // teardown restore, then re-forces from the saved switch.
  const second = stubRoot(registry)
  registerOpsPtcPreset(second.root, { forceDefault: true })
  await waitFor(() => registry.state.definitions.length === 2, { what: 'the replacement registration' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(registry.state.selected, 'ops-ptc', 'the replacement activation owns the final default')
  assert.equal(registry.state.updates.at(-1).patch.selectedDefault, 'ops-ptc')
})

await test('a disabled row restores the default on teardown', async () => {
  const registry = stubRegistry()
  const { root, events } = stubRoot(registry)
  registerOpsPtcPreset(root, { forceDefault: true })
  await waitFor(() => registry.state.selected === 'ops-ptc', { what: 'the forced default' })
  const effect = events.effects.find(entry => entry.label === 'dsh-ops: ops-ptc preset')
  await effect.cleanup()
  await waitFor(() => registry.state.selected === 'standard', { what: 'the default restored by a disabled row' })
})

await test('a failed registration never forces the default', async () => {
  const registry = stubRegistry()
  registry.state.fail = new Error('activation failed')
  const { root } = stubRoot(registry)
  registerOpsPtcPreset(root, { forceDefault: true, warn: () => {} })
  await waitFor(() => registry.state.definitions.length === 1, { what: 'the failed registration attempt' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(registry.state.updates, [], 'a missing preset must never become the default')
  assert.equal(registry.defaultId, 'standard')
})

await test('a missing settings service only warns and keeps the preset registered', async () => {
  const registry = stubRegistry()
  const warnings = []
  const { root } = stubRoot(registry, null)
  registerOpsPtcPreset(root, { forceDefault: true, warn: message => warnings.push(message) })
  await waitFor(() => warnings.length === 1, { what: 'the settings warning' })
  assert.match(warnings[0], /settings service is unavailable/)
  await settle(registry)
  assert.equal(registry.defaultId, 'standard')
})

await test('a rejected settings write only warns and leaves the default unchanged', async () => {
  const registry = stubRegistry()
  const warnings = []
  const { root } = stubRoot(registry, stubSettings(registry, new Error('denied')))
  registerOpsPtcPreset(root, { forceDefault: true, warn: message => warnings.push(message) })
  await waitFor(() => warnings.length === 1, { what: 'the rejected write warning' })
  assert.match(warnings[0], /cannot persist the default agent preset as ops-ptc: denied/)
  assert.equal(registry.defaultId, 'standard')
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

await test('a live Loader remount keeps the forced default and a disable restores it', async () => {
  const current = fs.readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')
  const fixture = componentProfile('preset-registration-loader', current)
  const host = await fixture.boot('linux')
  const registry = stubRegistry()
  try {
    // The row mounts before the services exist, exactly like a profile whose
    // settings/preset rows activate after the bundle row: the injection is what
    // starts the registration.
    host.ctx.provide('agentPresets', registry)
    host.ctx.provide('settings', stubSettings(registry))
    await waitFor(() => registry.state.selected === 'ops-ptc', { what: 'the forced default in a live Loader tree' })
    assert.equal(registry.state.updates.length, 1)

    // Saving an ordinary row switch remounts the fiber from the same entry. The
    // old teardown must not restore (that write would race the new activation and
    // wait on the profile lock the save holds).
    fs.writeFileSync(fixture.profile.patchPath, JSON.stringify([{ id: 'dsh-ops', config: { panel: { enabled: true } } }]))
    await host.refresh()
    await waitFor(() => registry.state.definitions.length === 2, { what: 'the replacement activation' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(registry.state.updates.at(-1).patch.selectedDefault, 'ops-ptc',
      'the replacement activation settles the default after the teardown restore')
    assert.equal(registry.state.selected, 'ops-ptc', 'the replacement activation keeps the forced default')

    // Disabling the row loses the owner, so teardown gives the default back.
    fs.writeFileSync(fixture.profile.patchPath, JSON.stringify([{ id: 'dsh-ops', config: { panel: { enabled: true } }, disabled: true }]))
    await host.refresh()
    await waitFor(() => registry.state.selected === 'standard', { what: 'the default restored when the row is disabled' })
  } finally { await shutdown(host.ctx) }
})

await test('live HMR transactions and profile file locks do not block or reject default restoration (#881)', async () => {
  await withTempDir('preset-registration-hmr', async profileDir => {
    const lockFile = path.join(profileDir, 'package.json.lock')
    const hmr = {
      operations: Promise.resolve(),
      executing: new AsyncLocalStorage(),
      runExclusive(operation) {
        if (this.executing.getStore() === true) {
          return Promise.reject(new Error('HMR transactions cannot be nested'))
        }
        const run = () => this.executing.run(true, operation)
        const task = this.operations.then(run, run)
        this.operations = task.then(() => undefined, () => undefined)
        return task
      },
    }
    const events = []
    const makeSettings = registry => ({
      async update(namespace, patch) {
        return hmr.runExclusive(async () => {
          if (fs.existsSync(lockFile)) {
            throw new Error(`Timed out waiting for lock: ${lockFile}`)
          }
          events.push(`settings:${patch.selectedDefault}`)
          registry.state.updates.push({ namespace, patch: { ...patch } })
          registry.state.selected = patch.selectedDefault
        })
      },
    })

    // 1. First boot inside hmr.runExclusive: forceDefault exits the HMR store and persists ops-ptc.
    const firstRegistry = stubRegistry()
    const firstWarnings = []
    const firstCtx = new Context()
    firstCtx.logger.level = 0
    firstCtx.provide('profile', { dir: profileDir })
    firstCtx.provide('hmr', hmr)
    firstCtx.provide('agentPresets', firstRegistry)
    firstCtx.provide('settings', makeSettings(firstRegistry))
    await hmr.runExclusive(async () => {
      registerOpsPtcPreset(firstCtx, { warn: message => firstWarnings.push(message) })
    })
    await waitFor(() => firstRegistry.state.selected === 'ops-ptc', { what: 'the forced default after an HMR boot transaction' })
    assert.deepEqual(firstWarnings, [])
    await shutdown(firstCtx)

    // 2. Second boot where selectedDefault is already ops-ptc on disk, followed by a
    // PluginManager.removeBundle-style two-phase HMR transaction under package.json.lock.
    const secondRegistry = stubRegistry('ops-ptc')
    const secondWarnings = []
    const secondCtx = new Context()
    secondCtx.logger.level = 0
    secondCtx.provide('profile', { dir: profileDir })
    secondCtx.provide('hmr', hmr)
    secondCtx.provide('agentPresets', secondRegistry)
    secondCtx.provide('settings', makeSettings(secondRegistry))
    registerOpsPtcPreset(secondCtx, { warn: message => secondWarnings.push(message) })
    await settle(secondRegistry)
    assert.deepEqual(secondRegistry.state.updates, [], 'second boot with ops-ptc already selected does not rewrite on startup')

    events.length = 0
    fs.writeFileSync(lockFile, `${process.pid}\n`)
    try {
      await hmr.runExclusive(async () => {
        events.push('phase1:unload')
        await secondCtx.fiber.dispose()
      })
      // Simulate `pnpm remove dsh-ops` between the two HMR phases while `package.json.lock` stays held.
      await new Promise(resolve => setTimeout(resolve, 25))
      events.push('between-phases')
      await hmr.runExclusive(async () => {
        events.push('phase2:reload')
      })
    } finally {
      fs.rmSync(lockFile, { force: true })
    }

    await waitFor(() => secondRegistry.state.selected === 'standard', { what: 'the restored official default after removeBundle' })
    assert.deepEqual(secondWarnings, [])
    assert.deepEqual(events, ['phase1:unload', 'between-phases', 'phase2:reload', 'settings:standard'])
    await shutdown(secondCtx)

    // 3. When package.json.lock never clears before the deadline, restoreDefault warns and skips the write.
    const thirdRegistry = stubRegistry('ops-ptc')
    const thirdWarnings = []
    const thirdCtx = new Context()
    thirdCtx.logger.level = 0
    thirdCtx.provide('profile', { dir: profileDir })
    thirdCtx.provide('hmr', hmr)
    thirdCtx.provide('agentPresets', thirdRegistry)
    thirdCtx.provide('settings', makeSettings(thirdRegistry))
    registerOpsPtcPreset(thirdCtx, { idleTimeoutMs: 20, warn: message => thirdWarnings.push(message) })
    await settle(thirdRegistry)
    fs.writeFileSync(lockFile, `${process.pid}\n`)
    try {
      await thirdCtx.fiber.dispose()
      await waitFor(() => thirdWarnings.length === 1, { what: 'the lock timeout warning' })
      assert.match(thirdWarnings[0], /timed out waiting for the profile lock to clear/)
      assert.equal(thirdRegistry.state.updates.length, 0, 'the write is skipped when the profile lock never clears')
    } finally {
      fs.rmSync(lockFile, { force: true })
      await shutdown(thirdCtx)
    }
  })
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
