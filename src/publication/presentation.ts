/** Inspect public presentation before publishing a replacement. Inspection is
 * marked by exact context identity and never becomes a provider request. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { AssembleContext, PromptAssembly, SystemPrompt } from '../adapter/dsh/types.js'

const probes = new WeakSet<AssembleContext>()
/** Probe depth per asynchronous execution context, not per process: a probe that
 * is still awaiting a slow handler must not make an unrelated later change look
 * like our own, and a nested assembly must stay attributable to its outermost
 * probe. */
const ambient = new AsyncLocalStorage<number>()
export function isPresentationProbe(context: AssembleContext): boolean { return probes.has(context) }
/** Whether this asynchronous flow is inside an assembly this plugin started. */
export function inPresentationProbe(): boolean { return (ambient.getStore() ?? 0) > 0 }

/**
 * Assemblies that already rebuilt once because a publication withdrew its own
 * tools during this request.
 *
 * Every publication hook re-assembles after `next()` when it retires something,
 * and that rebuild enters the same waterfall again. The rebuild is not new
 * evidence: the state it answers was already withdrawn here. So the second hook
 * to reach that point keeps the assembly it holds instead of building a third
 * one — the missing bound that let a two-hook withdrawal spin.
 */
const rebuilt = new WeakSet<AssembleContext>()

/**
 * Claim the single post-withdrawal rebuild this request may perform. The first
 * caller in a request gets `true` and rebuilds; later callers get `false` and
 * must return the assembly they already have.
 */
export function claimPresentationRebuild(context: AssembleContext): boolean {
  if (rebuilt.has(context)) return false
  rebuilt.add(context)
  return true
}

export async function inspectPresentation(prompt: Pick<SystemPrompt, 'assemble'>, scope: NonNullable<AssembleContext['scope']>, signal?: AbortSignal): Promise<PromptAssembly> {
  const context: AssembleContext = { scope, signal }
  probes.add(context)
  try {
    return await ambient.run((ambient.getStore() ?? 0) + 1, () => prompt.assemble(context))
  } finally { probes.delete(context) }
}

export async function isNativePresentation(prompt: Pick<SystemPrompt, 'assemble'>, scope: NonNullable<AssembleContext['scope']>, signal?: AbortSignal): Promise<boolean> {
  const assembly = await inspectPresentation(prompt, scope, signal)
  return !assembly.sections.some(section => section.name === 'tools:ptc-only' && Boolean(section.text.trim()))
}
