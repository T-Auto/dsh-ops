/** Idle-only policy over the same public compaction seam as /compact. */
import { createAutoCompactConfigSchema, resolveAutoCompactConfig } from './config.js'

export const name = 'dsh-ops-auto-compact'
export const inject = ['compaction', 'sessionProjections']
export const Config = createAutoCompactConfigSchema()

/** Match the Web context meter; absent/invalid samples never trigger work. */
export function contextPercent(pressure) {
  const used = pressure?.projectedTokens ?? pressure?.pressureTokens
  const capacity = pressure?.contextWindow
  if (!Number.isFinite(used) || used < 0 || !Number.isFinite(capacity) || capacity <= 0) return null
  return Math.min(100, Math.round(used / capacity * 100))
}

/** Surface changes, not compaction bookkeeping, permit a fresh attempt. */
function surfaceKey(session) {
  return JSON.stringify([session.surface.contentGeneration, session.surface.nodes])
}

/** Bounded, event-driven supervisor. It never publishes a model-callable tool. */
export function createAutoCompactor(ctx, rawConfig, {
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  const states = new WeakMap()
  const active = new Map()
  const disposedAgents = new WeakSet()
  let closed = false
  // One summary at a time for this component, across all sessions.
  let globalNextAt = 0

  function check(agent) {
    if (closed || disposedAgents.has(agent) || agent.status !== 'idle' || active.size > 0) return
    let config, percent, key
    try {
      config = resolveAutoCompactConfig(rawConfig)
      percent = contextPercent(ctx.get('sessionProjections').snapshot(agent.session, ['contextPressure']).values.contextPressure)
      key = surfaceKey(agent.session)
    } catch {
      // No guessed capacity, no admission when a required service disappears.
      return
    }
    if (percent === null || percent <= config.thresholdPercent) return
    const state = states.get(agent.session)
    const time = now()
    if (time < globalNextAt || time < (state?.nextAt ?? 0)
      || state?.blocked
      || state?.key === key && state.threshold === config.thresholdPercent) return

    const controller = new AbortController()
    const slot = { controller, done: undefined }
    // Install before calling compactNow: service admission may emit synchronously.
    active.set(agent, slot)
    states.set(agent.session, { key, threshold: config.thresholdPercent, nextAt: time + config.cooldownSeconds * 1000 })
    globalNextAt = time + config.cooldownSeconds * 1000
    const timer = setTimer(() => controller.abort(new Error('Automatic compaction timed out')), config.timeoutSeconds * 1000)
    timer.unref?.()
    let blocked = false
    slot.done = (async () => {
      try {
        const result = await ctx.get('compaction').compactNow(agent, controller.signal)
        if (result !== null) ctx.logger.info('dsh-ops auto-compact: compacted idle session history')
      } catch (error) {
        const code = error?.code
        if (code === 'commit' || code === 'persistence') {
          blocked = true
          ctx.logger.warn('dsh-ops auto-compact: session requires inspection after a commit/save failure; automatic compaction is suspended until this component is reloaded')
        } else if (!controller.signal.aborted && code !== 'busy' && code !== 'cancelled') {
          // Do not log history, provider errors, paths or credentials.
          ctx.logger.warn('dsh-ops auto-compact: compaction failed; automatic retry is backed off')
        }
      } finally {
        clearTimer(timer)
        // Suppress retries against our own replacement or bookkeeping records.
        try {
          states.set(agent.session, {
            key: surfaceKey(agent.session), threshold: config.thresholdPercent, blocked,
            nextAt: now() + config.cooldownSeconds * 1000,
          })
        } catch { /* disposed session */ }
        globalNextAt = now() + config.cooldownSeconds * 1000
        if (active.get(agent) === slot) active.delete(agent)
      }
    })()
  }

  function retire(agent) {
    disposedAgents.add(agent)
    active.get(agent)?.controller.abort(new Error('Agent disposed'))
  }

  async function dispose() {
    closed = true
    const slots = [...active.values()]
    for (const slot of slots) slot.controller.abort(new Error('Automatic compaction component disabled'))
    await Promise.allSettled(slots.map(slot => slot.done))
  }
  return { check, retire, dispose }
}

/** Keep this plugin's validated live references stable through Fiber.update. */
export function installLiveConfigUpdates(ctx, config) {
  ctx.on('internal/update', (candidate, _noSave, _next) => {
    const values = resolveAutoCompactConfig(candidate)
    const write = Symbol.for('cosmokit.volatile.write')
    for (const [key, value] of Object.entries(values)) config[key][write](value)
    try { ctx.emit('loader/volatile-update', Object.keys(values).map(key => [key])) }
    catch { ctx.logger.warn('dsh-ops auto-compact: live config notification failed') }
  })
}

/** Scoped listeners, abort and drain follow the host's teardown lifecycle. */
export function apply(ctx, config = {}, { liveUpdates = true } = {}) {
  resolveAutoCompactConfig(config)
  if (liveUpdates) installLiveConfigUpdates(ctx, config)
  const policy = createAutoCompactor(ctx, config)
  const lastTurnSignals = new WeakMap()
  ctx.effect(function* () {
    yield () => policy.dispose()
    yield ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle' && !lastTurnSignals.get(agent)?.aborted) policy.check(agent)
    })
    yield ctx.on('agent/turn-stopping', ({ agent, signal }) => {
      lastTurnSignals.set(agent, signal)
    })
    yield ctx.on('agent/disposed', ({ agent }) => policy.retire(agent))
    // Hot-enabling also covers already loaded idle sessions, without waking them.
    ctx.inject(['agents'], inner => {
      for (const agent of inner.get('agents').list()) policy.check(agent)
    })
  }, 'dsh-ops auto-compact lifecycle')
}
