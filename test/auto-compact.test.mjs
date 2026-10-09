/** Safety regressions plus real Cordis schema/lifecycle interoperability. */
import fs from 'node:fs'
import vm from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { AUTO_COMPACT_DEFAULTS, resolveAutoCompactConfig } from '../packages/auto-compact/lib/config.js'
import * as plugin from '@dsh-ops/auto-compact'
import { assert, PACKAGE_ROOT, report, test } from './lib/harness.mjs'

const write = Symbol.for('cosmokit.volatile.write')
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture({ result = {}, failure, operation } = {}) {
  let time = 1000000
  let pressure = { projectedTokens: 510, contextWindow: 1000 }
  const calls = [], logs = []
  const agent = { status: 'idle', session: { surface: { contentGeneration: 0, nodes: [0, 1, 2] } } }
  const ctx = {
    get: name => name === 'sessionProjections'
      ? { snapshot: () => ({ values: { contextPressure: pressure } }) }
      : { compactNow(owner, signal) {
        calls.push({ owner, signal })
        if (operation) return operation(owner, signal)
        if (failure) throw failure
        return Promise.resolve(result)
      } },
    logger: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
  }
  const config = plugin.Config['~standard'].validate({}).value
  const policy = plugin.createAutoCompactor(ctx, config, { now: () => time })
  return { agent, config, policy, calls, logs, ctx,
    advance: () => { time += 121000 },
    pressure: value => { pressure = value },
    grow: () => { agent.session.surface.nodes.push(agent.session.surface.nodes.length) },
  }
}

await test('defaults and strict bounds reject unknown, nonfinite, null and coerced input', () => {
  assert.deepEqual(resolveAutoCompactConfig(), AUTO_COMPACT_DEFAULTS)
  for (const value of [null, [], '50', { typo: 50 }, { thresholdPercent: 0 }, { thresholdPercent: 100 },
    { thresholdPercent: 50.5 }, { thresholdPercent: '50' }, { thresholdPercent: NaN },
    { thresholdPercent: null }, { cooldownSeconds: 0 }, { timeoutSeconds: Infinity }]) {
    assert.throws(() => resolveAutoCompactConfig(value))
  }
})

await test('descriptor rehydrates through the host schema; stable live references update', () => {
  const serialized = plugin.Config.toJSON()
  const hostSchema = new z(serialized)
  const validated = hostSchema({ thresholdPercent: 60 })
  assert.ok(isVolatile(validated.thresholdPercent))
  assert.equal(validated.thresholdPercent.get(), 60)
  const own = plugin.Config['~standard'].validate({}).value
  assert.ok(isVolatile(own.thresholdPercent))
  own.thresholdPercent[write](65)
  assert.equal(resolveAutoCompactConfig(own).thresholdPercent, 65)
  for (const value of [0, 100, 50.5]) assert.throws(() => hostSchema({ thresholdPercent: value }))
  // Exactly how SettingsForms.volatileForm clones each volatile child.
  const projected = z.object(Object.fromEntries(Object.entries(plugin.Config.dict).map(([key, node]) => {
    const field = new z(node.toJSON()); delete field.meta.volatile; return [key, field]
  })))
  assert.deepEqual(projected({}), AUTO_COMPACT_DEFAULTS)
})

await test('Web occupancy precedence, rounding, absent and invalid samples', () => {
  assert.equal(plugin.contextPercent({ projectedTokens: 501, pressureTokens: 900, contextWindow: 1000 }), 50)
  assert.equal(plugin.contextPercent({ pressureTokens: 506, contextWindow: 1000 }), 51)
  assert.equal(plugin.contextPercent({ projectedTokens: 2000, contextWindow: 1000 }), 100)
  for (const value of [undefined, {}, { projectedTokens: NaN, contextWindow: 1000 },
    { projectedTokens: -1, contextWindow: 1000 }, { projectedTokens: 51, contextWindow: 0 }]) {
    assert.equal(plugin.contextPercent(value), null)
  }
})

await test('strictly above threshold; running work and missing capacity do not compact', async () => {
  const f = fixture()
  f.pressure({ projectedTokens: 500, contextWindow: 1000 }); f.policy.check(f.agent)
  f.pressure({ projectedTokens: 510, contextWindow: 1000 }); f.agent.status = 'running'; f.policy.check(f.agent)
  f.agent.status = 'idle'; f.pressure({}); f.policy.check(f.agent)
  assert.equal(f.calls.length, 0)
  f.pressure({ projectedTokens: 510, contextWindow: 1000 }); f.policy.check(f.agent)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].owner, f.agent)
  await f.policy.dispose()
})

await test('live threshold updates are read without remounting', async () => {
  const f = fixture()
  f.config.thresholdPercent[write](60); f.policy.check(f.agent)
  assert.equal(f.calls.length, 0)
  f.config.thresholdPercent[write](40); f.policy.check(f.agent)
  assert.equal(f.calls.length, 1)
  await f.policy.dispose()
})

await test('same surface is suppressed even after cooldown; growth allows one new attempt', async () => {
  const f = fixture({ result: null })
  f.policy.check(f.agent); await tick(); f.advance(); f.policy.check(f.agent)
  assert.equal(f.calls.length, 1)
  f.grow(); f.policy.check(f.agent); await tick()
  assert.equal(f.calls.length, 2)
  f.grow(); f.policy.check(f.agent)
  assert.equal(f.calls.length, 2)
  await f.policy.dispose()
})

await test('own summary replacement does not form an automatic compaction loop', async () => {
  const f = fixture({ operation: async owner => {
    owner.session.surface.contentGeneration++
    owner.session.surface.nodes = [0, 5]
    return {}
  } })
  f.policy.check(f.agent); await tick(); f.advance(); f.policy.check(f.agent)
  assert.equal(f.calls.length, 1)
  await f.policy.dispose()
})

await test('component admits one session at a time; unload aborts and drains without agent.cancel', async () => {
  const f = fixture({ operation: (_owner, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }) })
  const other = { ...f.agent, session: { surface: { contentGeneration: 0, nodes: [0, 1] } } }
  f.policy.check(f.agent); f.policy.check(f.agent); f.policy.check(other)
  assert.equal(f.calls.length, 1)
  await f.policy.dispose()
  assert.equal(f.calls[0].signal.aborted, true)
  f.advance(); f.grow(); f.policy.check(other)
  assert.equal(f.calls.length, 1)
})

await test('disposed agents are not restarted', async () => {
  const f = fixture()
  f.policy.retire(f.agent); f.policy.check(f.agent)
  assert.equal(f.calls.length, 0)
  await f.policy.dispose()
})

await test('busy, cancellation and sensitive provider failures are contained and backed off', async () => {
  for (const code of ['busy', 'cancelled', 'summary', 'commit', 'persistence', undefined]) {
    const failure = Object.assign(new Error('SECRET_PROVIDER_TOKEN'), { code })
    const f = fixture({ failure })
    f.policy.check(f.agent); await tick(); f.advance(); f.policy.check(f.agent)
    assert.equal(f.calls.length, 1)
    assert.equal(JSON.stringify(f.logs).includes('SECRET_PROVIDER_TOKEN'), false)
    await f.policy.dispose()
  }
})

await test('commit/save failures suspend this session even when its history grows', async () => {
  for (const code of ['commit', 'persistence']) {
    const f = fixture({ failure: Object.assign(new Error('sensitive'), { code }) })
    f.policy.check(f.agent); await tick(); f.advance(); f.grow(); f.policy.check(f.agent)
    assert.equal(f.calls.length, 1)
    await f.policy.dispose()
  }
})

await test('timeout aborts only this compaction and drain waits for settlement', async () => {
  const f = fixture({ operation: (_agent, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }) })
  let expire, duration, cleared = false
  const policy = plugin.createAutoCompactor(f.ctx, f.config, {
    setTimer: (callback, ms) => { expire = callback; duration = ms; return { unref() {} } },
    clearTimer: () => { cleared = true },
  })
  policy.check(f.agent)
  assert.equal(duration, 120000)
  expire()
  await policy.dispose()
  assert.equal(f.calls[0].signal.aborted, true)
  assert.equal(cleared, true)
  await f.policy.dispose()
})

await test('real Cordis mounts standard schema, inject waits and unloading removes listeners', async () => {
  const ctx = new Context(); ctx.logger.level = 0
  const calls = []
  ctx.reflect.provide('sessionProjections', { snapshot: () => ({ values: { contextPressure: { projectedTokens: 900, contextWindow: 1000 } } }) })
  ctx.reflect.provide('compaction', { compactNow: async (agent, signal) => { calls.push({ agent, signal }); return null } })
  const fiber = ctx.plugin(plugin, {})
  await fiber
  assert.equal(fiber.config.thresholdPercent.get(), 50)
  const agent = { status: 'idle', session: { surface: { contentGeneration: 0, nodes: [0, 1] } } }
  const aborted = new AbortController(); aborted.abort()
  ctx.emit('agent/turn-stopping', { agent, signal: aborted.signal })
  ctx.emit('agent/status', { agent, status: 'idle' }); await tick()
  assert.equal(calls.length, 0, 'user cancellation must not start automatic maintenance')
  ctx.emit('agent/turn-stopping', { agent, signal: new AbortController().signal })
  ctx.emit('agent/status', { agent, status: 'idle' }); await tick()
  assert.equal(calls.length, 1)
  const originalConfig = fiber.config
  fiber.update({ thresholdPercent: 75, cooldownSeconds: 120, timeoutSeconds: 120 }, true)
  await fiber.await()
  assert.equal(fiber.config, originalConfig, 'live update must not remount the component')
  assert.equal(fiber.config.thresholdPercent.get(), 75)
  assert.throws(() => fiber.update({ thresholdPercent: 0 }, true))
  assert.equal(fiber.config.thresholdPercent.get(), 75)
  await fiber.dispose()
  agent.session.surface.nodes.push(2)
  ctx.emit('agent/status', { agent, status: 'idle' }); await tick()
  assert.equal(calls.length, 1)
  await ctx.fiber.dispose()
})

await test('bundle exports, locales and browser factory register this exact component region', () => {
  const pkg = JSON.parse(fs.readFileSync(`${PACKAGE_ROOT}/package.json`, 'utf8'))
  assert.equal(pkg.dependencies['@dsh-ops/auto-compact'], 'file:packages/auto-compact')
  const companion = JSON.parse(fs.readFileSync(`${PACKAGE_ROOT}/packages/auto-compact/package.json`, 'utf8'))
  assert.equal(companion.exports['./client'], './lib/client.js')
  assert.equal(companion.dsh.client.platform, 'web')
  const patch = fs.readFileSync(`${PACKAGE_ROOT}/cordis.patch.yml`, 'utf8')
  assert.match(patch, /id: dsh-ops-auto-compact\s+name: '@dsh-ops\/auto-compact'/)
  assert.match(patch, /thresholdPercent: 50/)
  for (const lang of ['zh', 'en']) {
    const meta = JSON.parse(fs.readFileSync(`${PACKAGE_ROOT}/packages/auto-compact/locale/${lang}.json`, 'utf8')).meta
    assert.ok(meta.title && meta.description)
  }
  let registration
  vm.runInNewContext(fs.readFileSync(`${PACKAGE_ROOT}/packages/auto-compact/lib/client.js`, 'utf8'), {
    window: { __ModuleLoader__: { load: record => { registration = record } } },
  })
  assert.equal(registration.id, '@dsh-ops/auto-compact')
  const browser = registration.factory(name => {
    assert.equal(name, 'react')
    return { createElement() {}, useState() {}, useEffect() {}, useRef() {} }
  })
  let options
  browser.apply({
    get: name => name === 'locale' ? { bind: () => () => '', register: () => () => {} }
      : { inject: (_slot, callback) => callback(), register: opts => { options = opts; return () => {} } },
    effect: callback => callback(),
  })
  assert.equal(options.name, 'plugins.row.config')
  assert.equal(options.key, 'dsh-ops#dsh-ops-auto-compact')
})

report('auto-compact')
