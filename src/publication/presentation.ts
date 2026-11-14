/** Inspect public presentation before publishing a replacement. Inspection is
 * marked by exact context identity and never becomes a provider request. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { AssembleContext, Context, PromptAssembly, SystemPrompt, ToolActivationContext } from '../adapter/dsh/types.js'

type Prompt = Pick<SystemPrompt, 'assemble'>
type Scope = NonNullable<AssembleContext['scope']>
interface Verdict { native: boolean; ptc: boolean }
interface Observed { revision: number; owners: number; values: WeakMap<Scope, Verdict> }
const observed = new WeakMap<Prompt, Observed>()
function verdict(assembly: PromptAssembly): Verdict {
  const native = !assembly.sections.some(section => section.name === 'tools:ptc-only' && Boolean(section.text.trim()))
  return { native, ptc: !native && assembly.tools.length === 1 && assembly.tools[0]?.name === 'run_code' }
}
/** Watch public invalidation in the owning context. Unobserved deployments always probe. */
export function observePresentation(ctx: Context, prompt: Prompt): void {
  let state = observed.get(prompt)
  if (!state) { state = { revision: 0, owners: 0, values: new WeakMap() }; observed.set(prompt, state) }
  const owner = state
  const invalidate = () => { ++owner.revision; owner.values = new WeakMap() }
  ++owner.owners
  invalidate()
  ctx.on('system-prompt/change', invalidate, { global: true })
  ctx.on('tools/change', invalidate, { global: true })
  ctx.effect(() => () => { --owner.owners; invalidate() }, 'dsh-ops: presentation verdict observer')
}
/** Consumers compare this again after async admission, before dispatch. */
export function presentationRevision(prompt: Prompt): number | undefined { return observed.get(prompt)?.revision }

const probes = new WeakSet<AssembleContext>()
/** Probe depth per asynchronous execution context, not per process: a probe that
 * is still awaiting a slow handler must not make an unrelated later change look
 * like our own, and a nested assembly must stay attributable to its outermost
 * probe. */
const ambient = new AsyncLocalStorage<number>()
export function isPresentationProbe(context: AssembleContext): boolean { return probes.has(context) }
export async function inspectPresentation(prompt: Pick<SystemPrompt, 'assemble'>, scope: NonNullable<AssembleContext['scope']>, signal?: AbortSignal): Promise<PromptAssembly> {
  const context: AssembleContext = { scope, signal }
  const state = observed.get(prompt), revision = state?.revision
  probes.add(context)
  try {
    const assembly = await ambient.run((ambient.getStore() ?? 0) + 1, () => prompt.assemble(context))
    // Only the final public result is remembered; an inner middleware result
    // may still be changed by an outer handler. Never cache an obsolete probe.
    if (state?.owners && state.revision === revision && !signal?.aborted) state.values.set(scope, verdict(assembly))
    return assembly
  } finally { probes.delete(context) }
}

async function executionVerdict(prompt: Prompt, scope: Scope, signal?: AbortSignal): Promise<Verdict> {
  const state = observed.get(prompt), revision = state?.revision
  const cached = state?.owners ? state.values.get(scope) : undefined
  const value = cached ?? verdict(await inspectPresentation(prompt, scope, signal))
  if (signal?.aborted || state && revision !== state.revision) return { native: false, ptc: false }
  return value
}

export async function isPtcPresentation(prompt: Prompt, scope: Scope, signal?: AbortSignal): Promise<boolean> {
  return (await executionVerdict(prompt, scope, signal)).ptc
}

const activationPresentations = new WeakMap<ToolActivationContext, Promise<PromptAssembly>>()
/** One read-only mode probe per exact resolve context; never publishes or consumes selection. */
export async function activationIsPtc(prompt: Pick<SystemPrompt, 'assemble'>, context: ToolActivationContext): Promise<boolean> {
  let pending = activationPresentations.get(context)
  if (!pending) {
    pending = inspectPresentation(prompt, context.agent, context.signal)
    activationPresentations.set(context, pending)
  }
  const assembly = await pending
  return assembly.tools.length === 1 && assembly.tools[0]?.name === 'run_code'
    && assembly.sections.some(section => section.name === 'tools:ptc-only' && Boolean(section.text.trim()))
}

export async function isNativePresentation(prompt: Pick<SystemPrompt, 'assemble'>, scope: NonNullable<AssembleContext['scope']>, signal?: AbortSignal): Promise<boolean> {
  return (await executionVerdict(prompt, scope, signal)).native
}
