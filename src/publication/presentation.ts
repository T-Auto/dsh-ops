/** Inspect public presentation before publishing a replacement. Inspection is
 * marked by exact context identity and never becomes a provider request. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Agent, AssembleContext, PromptAssembly, SystemPrompt, ToolActivationContext } from '../adapter/dsh/types.js'

const probes = new WeakSet<AssembleContext>()
/** Probe depth per asynchronous execution context, not per process: a probe that
 * is still awaiting a slow handler must not make an unrelated later change look
 * like our own, and a nested assembly must stay attributable to its outermost
 * probe. */
const ambient = new AsyncLocalStorage<number>()
export function isPresentationProbe(context: AssembleContext): boolean { return probes.has(context) }
export async function inspectPresentation(prompt: Pick<SystemPrompt, 'assemble'>, agent: Agent, signal?: AbortSignal,
  modelSelection?: ToolActivationContext['modelSelection']): Promise<PromptAssembly> {
  const context: AssembleContext = { scope: agent, agent, signal, ...(modelSelection === undefined ? {} : { modelSelection }) }
  probes.add(context)
  try {
    return await ambient.run((ambient.getStore() ?? 0) + 1, () => prompt.assemble(context))
  } finally { probes.delete(context) }
}

const activationPresentations = new WeakMap<ToolActivationContext, Promise<PromptAssembly>>()
/** One read-only mode probe per exact resolve context; never publishes or consumes selection. */
export async function activationIsPtc(prompt: Pick<SystemPrompt, 'assemble'>, context: ToolActivationContext): Promise<boolean> {
  let pending = activationPresentations.get(context)
  if (!pending) {
    pending = inspectPresentation(prompt, context.agent, context.signal, context.modelSelection)
    activationPresentations.set(context, pending)
  }
  const assembly = await pending
  return assembly.tools.length === 1 && assembly.tools[0]?.name === 'run_code'
    && assembly.sections.some(section => section.name === 'tools:ptc-only' && Boolean(section.text.trim()))
}

export async function isNativePresentation(prompt: Pick<SystemPrompt, 'assemble'>, agent: Agent, signal?: AbortSignal): Promise<boolean> {
  const assembly = await inspectPresentation(prompt, agent, signal)
  return !assembly.sections.some(section => section.name === 'tools:ptc-only' && Boolean(section.text.trim()))
}
