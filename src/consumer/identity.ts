/**
 * Identify the agent preset a live Agent was composed from.
 *
 * The preset id is the only authority for which OPS mode applies: a preset is a
 * scoped plugin composition, and a prompt or tool name is not a preset identity.
 * The value comes from the public preset registry when that service is mounted;
 * hosts without a preset roster fall back to the session projection or the frozen
 * session header. A host with no preset registry at all is a single-composition
 * deployment (headless/SDK), which this plugin treats as the built-in Standard
 * composition so OPS keeps working there.
 */
import type { Context } from '../adapter/dsh/types.js'
import type { Agent } from '../adapter/dsh/types.js'

interface PresetRegistry { composedPreset(ctx: Context): string | undefined }
interface SessionProjections { stateOf(session: unknown, key: string): unknown }
interface AgentSession { header?: { agentPreset?: unknown } }


/** Read an optional service by name without requiring its type package at load time. */
function service<T>(ctx: Context, name: string): T | undefined {
  try {
    const getter = (ctx as unknown as { get?: (key: string) => unknown }).get
    const value = typeof getter === 'function' ? Reflect.apply(getter, ctx, [name]) : undefined
    return value === undefined || value === null ? undefined : value as T
  } catch { return undefined }
}

/**
 * The preset id an Agent is currently composed from.
 * @param ctx - a context on the same Cordis root as the Agent.
 * @param agent - the live Agent.
 * @returns the preset id, or undefined when the host composes no preset for it.
 */
export function presetOf(ctx: Context, agent: Agent): string | undefined {
  const registry = service<PresetRegistry>(ctx, 'agentPresets')
  if (registry !== undefined) {
    try {
      const id = registry.composedPreset?.(agent.ctx)
      if (typeof id === 'string' && id !== '') return id
    } catch { /* a collected generation is not a preset for this Agent */ }
  }
  const projections = service<SessionProjections>(ctx, 'sessionProjections')
  try {
    const state = projections?.stateOf?.(agent.session, 'agentPreset')
    if (typeof state === 'string' && state !== '') return state
  } catch { /* projection unavailable */ }
  const header = (agent.session as AgentSession | undefined)?.header
  const declared = header?.agentPreset
  return typeof declared === 'string' && declared !== '' ? declared : undefined
}

/** Whether the host has explicit preset compositions; headless fallback is consumer policy. */
export function hasPresetRegistry(ctx: Context): boolean { return service<PresetRegistry>(ctx, 'agentPresets') !== undefined }
