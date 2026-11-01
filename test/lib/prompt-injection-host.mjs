/** Real host loop without worker or network: every model request is captured. */
import { Context } from '@deepseek-ai/cordis'
import Agents from '@deepseek-ai/dsh-agent'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Loop from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { assert } from './harness.mjs'
let serial = 0
export async function promptHost() {
  const ctx = new Context(); ctx.logger.level = 0
  for (const plugin of [Agents, Sessions, Projections, Prompt, Tools]) await ctx.plugin(plugin, {})
  const requests = [], errors = [], events = [], scripts = new Map()
  await ctx.plugin(inner => {
    inner.provide('llm', { async prepareCall(config) { return { config, adapterDefaults: {}, stream: async function* (request) {
      assert.deepEqual(request.messages, ctx.get('sessions').get(request.sessionId).deriveMessages(), 'request must exactly reconstruct from committed history')
      requests.push(request)
      const queue = scripts.get(request.sessionId)
      assert.ok(queue?.length, 'unexpected request (possible artificial wake-up)')
      const script = queue.shift()
      if (typeof script === 'function') yield* script(request)
      else { yield { type: 'text-delta', index: 0, text: 'Done.' }; yield { type: 'finish', reason: { kind: script ?? 'stop' } } }
    } } } })
    inner.on('agent/error', ({ error }) => errors.push(error))
    inner.on('session/event', (session, event) => events.push({ session, event }))
  })
  await ctx.plugin(Loop, { agents: [] })
  const agent = async parentAgent => (await handle(parentAgent)).agent
  const handle = parentAgent => ctx.get('agents').create({ sessionId: `prompt-loop-${++serial}`, parentAgent,
    agentOptions: { provider: 'fixture', model: 'capture' } })
  const owner = () => ctx.plugin(() => {}).ctx
  async function run(agent, queue = [undefined]) {
    scripts.set(agent.session.id, [...queue])
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Real user task.' }] }))
    await agent.whenIdle()
    assert.equal(scripts.get(agent.session.id).length, 0)
  }
  return { ctx, agent, handle, owner, run, requests, errors, events, close: () => ctx.fiber.dispose() }
}
export const tailMessages = request => request.messages.filter(m => m.source?.kind === 'dsh-ops:step-tail')
