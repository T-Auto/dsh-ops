/** Inspect public presentation before publishing a replacement. Inspection is
 * marked by exact context identity and never becomes a provider request.
 * Per-scope assembly results are memoized so that repeated discovery/ptc
 * reconciles share one assembly per scope: both components derive their
 * verdicts (native vs ptc) from the same cached assembly and only assemble
 * again after an explicit invalidation. */
import type { AssembleContext, PromptAssembly, SystemPrompt } from '@deepseek-ai/dsh-system-prompt'

const probes = new WeakSet<AssembleContext>()
export function isPresentationProbe(context: AssembleContext): boolean { return probes.has(context) }
export async function inspectPresentation(prompt: Pick<SystemPrompt, 'assemble'>, scope: NonNullable<AssembleContext['scope']>, signal?: AbortSignal): Promise<PromptAssembly> {
  const context: AssembleContext = { scope, signal }
  probes.add(context)
  try {
    return await prompt.assemble(context)
  } finally { probes.delete(context) }
}

/** One memoized assembly: the exact prompt instance it was computed from (a
 * different instance invalidates the entry) and the pending result so
 * concurrent callers share a single assembly. */
interface AssemblyEntry {
  prompt: Pick<SystemPrompt, 'assemble'>
  result: Promise<PromptAssembly>
}

/** Per-scope memo, keyed by the agent object; entries survive until the owning
 * components invalidate them on dispose or a relevant change. */
const assemblyCache = new Map<object, AssemblyEntry>()

/** Invalidate one scope's cached assembly; the next probe re-assembles. */
export function invalidateNativePresentation(scope: NonNullable<AssembleContext['scope']>): void {
  assemblyCache.delete(scope)
}

/** Drop every cached assembly (component teardown). */
export function clearNativePresentationCache(): void {
  assemblyCache.clear()
}

/** Memoized per-scope inspection: concurrent callers share one assembly,
 * cached callers assemble nothing, and a failed probe is evicted so the next
 * reconcile retries it. The signal only governs the first (uncached) probe. */
export function inspectCachedPresentation(prompt: Pick<SystemPrompt, 'assemble'>, scope: NonNullable<AssembleContext['scope']>, signal?: AbortSignal): Promise<PromptAssembly> {
  const cached = assemblyCache.get(scope)
  if (cached && cached.prompt === prompt) return cached.result
  const result = inspectPresentation(prompt, scope, signal).then(
    assembly => assembly,
    error => { invalidateNativePresentation(scope); throw error },
  )
  assemblyCache.set(scope, { prompt, result })
  return result
}

/** Native verdict derived from the shared per-scope assembly: the scope is
 * native when no ptc-only section is present. */
export function isNativePresentation(prompt: Pick<SystemPrompt, 'assemble'>, scope: NonNullable<AssembleContext['scope']>): Promise<boolean> {
  return inspectCachedPresentation(prompt, scope).then(assembly =>
    !assembly.sections.some(section => section.name === 'tools:ptc-only' && Boolean(section.text.trim())),
  )
}

/** A cheap layer fingerprint for directed tools/change invalidation. Reads only
 * the tool layers (no assembly): registered tool names plus the presentation
 * mode's collapse (a ptc-presented scope surfaces only `run_code`). Two scopes
 * with the same fingerprint show the model the same tool wire; a change that
 * leaves every fingerprint intact cannot alter any ptc-only section. */
export function layerFingerprint(scope: object, schemas: (scope: object) => { name: string }[]): string {
  return schemas(scope).map(schema => schema.name).join('\uFFFF')
}
