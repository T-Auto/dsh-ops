/** Real DSH 0.2.2 executor and model-step preparation helpers. */
import * as native from '@deepseek-ai/dsh-tool-executor-native'
import * as ptc from '@deepseek-ai/dsh-tool-executor-ptc'

/** Register a host executor in the caller's scope; its returned effect is disposable. */
export function selectExecutor(ctx, mode) {
  if (mode !== 'native' && mode !== 'ptc') throw new Error(`Unknown executor mode: ${mode}`)
  const Executor = mode === 'native' ? native.NativeToolExecutor : ptc.PtcExecutor
  return ctx.tools.setExecutor(new Executor(ctx))
}

/** Capture the same admission set used by the loop, without advancing a Session. */
export async function prepareStep(ctx, agent, signal = new AbortController().signal) {
  const modelSelection = agent?.model?.current?.() ?? { provider: 'fixture', model: 'scripted' }
  const toolSet = await ctx.get('tools').resolve({ agent, modelSelection, signal })
  try {
    const assembly = await ctx.get('systemPrompt').assemble({ scope: agent, modelSelection, signal, toolSet })
    return { toolSet, assembly, dispose: () => toolSet.dispose() }
  } catch (error) { toolSet.dispose(); throw error }
}

/** Execute one model call as a real batch, preserving an explicitly captured step set. */
export async function executeCall(ctx, request) {
  const { name, callId, arguments: args, agent, signal = new AbortController().signal, toolSet } = request
  const step = toolSet ? undefined : await prepareStep(ctx, agent, signal)
  try {
    const batch = await ctx.get('tools').execute({ agent, signal, toolSet: toolSet ?? step.toolSet,
      calls: [{ type: 'tool-call', id: callId ?? 'fixture-call', name, arguments: JSON.stringify(args) }] })
    return batch.results[0].result
  } finally { step?.dispose() }
}
