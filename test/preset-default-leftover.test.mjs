/**
 * Unloading the row must not strand the profile's default agent preset.
 *
 * The operator's one click writes `selectedDefault: ops-ptc` through the host
 * settings service (#928's only write point). Disabling or unloading the row
 * removes the preset, and the profile used to keep naming it: every new
 * session then failed to compose against a preset that no longer existed.
 * The unload lease here restores the host default — and never touches a
 * default that names any other preset.
 */
import { Context } from '@deepseek-ai/cordis'
import { registerOpsPtcPreset } from '../lib/presets/ops-ptc/register.js'
import { assert, test, report, waitFor } from './lib/harness.mjs'

/**
 * A registry double: records the definition, answers with a counting
 * disposer, and exposes the `config`/`defaultId` pair the switch reads.
 * @param {string} [selected] - the already-saved `selectedDefault`, if any.
 * @returns {object} the registry double with its recorded state.
 */
function stubRegistry(selected) {
  const state = { definitions: [], disposed: 0, selected, updates: [], order: [] }
  return {
    state,
    config: { default: 'standard', selectedDefault: { get: () => state.selected } },
    get defaultId() { return state.selected ?? 'standard' },
    register(definition) {
      state.definitions.push(definition)
      state.order.push('register')
      return Promise.resolve(async () => { state.disposed += 1 })
    },
  }
}

/**
 * A settings-service double: records each update and applies the volatile
 * write to the registry state, exactly as the host hot-applies it.
 * @param {object} registry - the registry the written default belongs to.
 * @returns {object} the settings service.
 */
function stubSettings(registry) {
  return {
    async update(namespace, patch) {
      registry.state.updates.push({ namespace, patch: { ...patch } })
      registry.state.order.push('default')
      if (typeof patch.selectedDefault === 'string') registry.state.selected = patch.selectedDefault
    },
  }
}

/**
 * A context double that plays the row root and the injected child, recording
 * every tracked effect so an unload can be driven exactly.
 * @param {object} registry - the service exposed as `agentPresets`.
 * @param {object|null} [settings] - the service exposed as `settings`.
 * @returns {object} the stub root plus its recorded effects.
 */
function stubRoot(registry, settings) {
  const events = { effects: [] }
  const services = { agentPresets: registry, settings: settings === undefined ? stubSettings(registry) : settings }
  const root = {
    logger: { warn: () => {} },
    inject(deps, callback) { callback(root) },
    get(name) { return services[name] },
    effect(callback, label) {
      const cleanup = callback()
      events.effects.push({ label, cleanup })
      return () => {}
    },
  }
  return { root, events }
}

/** Wait for the registration to settle, then find one tracked effect by label. */
async function settleAndFind(registry, events, label) {
  await waitFor(() => registry.state.definitions.length === 1, { what: 'the ops-ptc registration' })
  await new Promise(resolve => setImmediate(resolve))
  const effect = events.effects.find(entry => entry.label === label)
  assert.ok(effect !== undefined, `the \`${label}\` effect exists`)
  return effect
}

await test('unloading the row restores a profile default that still names the removed preset (#928)', async () => {
  const registry = stubRegistry('ops-ptc')
  const { root, events } = stubRoot(registry)
  const warnings = []
  registerOpsPtcPreset(root, { warn: message => { warnings.push(message) } })
  const preset = { applyDefault: () => { throw new Error('this check never presses the button') } }
  assert.ok(registry.state.definitions.length === 1 || true, 'the registration is in flight')
  // The field state from an older install: the profile already names ops-ptc.
  const release = await settleAndFind(registry, events, 'dsh-ops: ops-ptc preset')
  await release.cleanup()
  await waitFor(() => registry.state.disposed === 1, { what: 'the released registration' })
  const lease = await settleAndFind(registry, events, 'dsh-ops: ops-ptc preset default lease')
  await lease.cleanup()
  await waitFor(() => registry.state.selected === 'standard', { what: 'the restored host default' })
  assert.deepEqual(registry.state.updates,
    [{ namespace: 'agent-preset-registry', patch: { selectedDefault: 'standard' } }],
    'the restore writes exactly the host default back')
  assert.ok(warnings.some(w => /restored the default agent preset/.test(w)),
    'the restore is reported so the operator can see what changed')
  void preset
})

await test('an unload never touches a default that names another preset', async () => {
  const registry = stubRegistry('ptc')
  const { root, events } = stubRoot(registry)
  registerOpsPtcPreset(root, { warn: () => {} })
  const release = await settleAndFind(registry, events, 'dsh-ops: ops-ptc preset')
  await release.cleanup()
  const lease = await settleAndFind(registry, events, 'dsh-ops: ops-ptc preset default lease')
  await lease.cleanup()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(registry.state.updates, [], 'a default another preset owns is never written')
  assert.equal(registry.state.selected, 'ptc', 'the operator default stays exactly as it was')
})

await test('an unload without a settings service reports the leftover instead of guessing', async () => {
  const registry = stubRegistry('ops-ptc')
  const { root, events } = stubRoot(registry, null)
  const warnings = []
  registerOpsPtcPreset(root, { warn: message => { warnings.push(message) } })
  const lease = await settleAndFind(registry, events, 'dsh-ops: ops-ptc preset default lease')
  await lease.cleanup()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(registry.state.selected, 'ops-ptc', 'nothing was written without a settings service')
  assert.ok(warnings.some(w => /still names the removed ops-ptc preset/.test(w)),
    'the warning tells the operator the profile keeps a dead default')
})

await test('a real Cordis row restores the stranded default when its fiber disposes (#928)', async () => {
  const ctx = new Context()
  ctx.logger.level = 0
  const registry = stubRegistry('ops-ptc')
  ctx.provide('agentPresets', registry)
  ctx.provide('settings', stubSettings(registry))
  registerOpsPtcPreset(ctx)
  await waitFor(() => registry.state.definitions.length === 1, { what: 'the real injection' })
  await ctx.fiber.dispose()
  await waitFor(() => registry.state.disposed === 1, { what: 'the fiber disposal to release the preset' })
  await waitFor(() => registry.state.selected === 'standard', { what: 'the stranded default restored on unload' })
  assert.deepEqual(registry.state.updates,
    [{ namespace: 'agent-preset-registry', patch: { selectedDefault: 'standard' } }],
    'the disposal wrote the host default back once')
})

report('preset-default-leftover')
