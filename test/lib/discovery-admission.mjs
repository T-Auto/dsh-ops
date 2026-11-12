/** Shared real-host discovery admission fixtures, without eager-presentation assumptions. */
import { bootDiscoveryHost, mintDiscoveryAgent } from './discovery.mjs'
import { prepareStep, executeCall } from './executor.mjs'
import { isPresentationProbe } from '../../lib/presentation.js'
export async function fixture(root, config = {}) {
  const { ctx, fiber } = await bootDiscoveryHost(config)
  const probes = new Map()
  ctx.systemPrompt.section({ name: 'admission-counter', order: 10, text(context) {
    if (isPresentationProbe(context)) probes.set(context.scope, (probes.get(context.scope) ?? 0) + 1)
    return ''
  } })
  let sequence = 0
  const mint = parent => mintDiscoveryAgent(ctx, `admission-${++sequence}`, root, parent)
  const capture = agent => prepareStep(ctx, agent)
  const names = async agent => { const step = await capture(agent); try { return ctx.tools.schemas(agent, step.toolSet).map(t => t.name) } finally { step.dispose() } }
  const call = (agent, name, args, toolSet) => executeCall(ctx, { agent, name, arguments: args, toolSet })
  const commit = agent => ctx.serial('session/event', agent.session, { type: 'step/end' })
  return { ctx, fiber, probes, mint, capture, names, call, commit }
}
