/** Inspect public presentation before publishing a replacement. Inspection is
 * marked by exact context identity and never becomes a provider request. */
import type { AssembleContext, PromptAssembly, SystemPrompt } from '../adapter/dsh/types.js'

const probes = new WeakSet<AssembleContext>()

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

export function isPresentationProbe(context: AssembleContext): boolean { return probes.has(context) }

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
    return await prompt.assemble(context)
  } finally { probes.delete(context) }
}

export async function isNativePresentation(prompt: Pick<SystemPrompt, 'assemble'>, scope: NonNullable<AssembleContext['scope']>, signal?: AbortSignal): Promise<boolean> {
  const assembly = await inspectPresentation(prompt, scope, signal)
  return !assembly.sections.some(section => section.name === 'tools:ptc-only' && Boolean(section.text.trim()))
}
