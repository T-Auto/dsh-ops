import fs from 'node:fs'
import path from 'node:path'
import LlmRuntime, { LlmAdapter, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { createScope } from '@deepseek-ai/dsh-scope'
import { publicToolName } from '../../lib/policy.js'
import * as Discovery from '../../lib/components/discovery/index.js'
import { DISCOVERABLE_TOOLS } from '../../lib/discovery/config.js'
import { assert, waitFor, withTempDir } from './harness.mjs'
import { bootHost, mountPlugin, shutdown } from './host.mjs'
import { legacyComponent } from './legacy-component.mjs'
import { prepareStep, executeCall } from './executor.mjs'

export const READ = publicToolName('inspect_local_file')
export const text = result => result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
export const full = result => assert.match(text(result), /^1(?: \| |\|)payload/m)
export const elided = result => {
  assert.match(text(result), /Unchanged file range; body already present in the current model context/)
  assert.doesNotMatch(text(result), /^\d+(?: \| |\|)/m)
  assert.match(text(result), /=== FILE: .*Lines \d+-\d+ of \d+/)
  assert.match(text(result), /revision=[a-f0-9]{64}/)
}
class RecordingAdapter extends LlmAdapter {
  requests = []
  next = undefined
  async *stream(options) {
    this.requests.push(structuredClone({ messages: options.messages, purpose: options.purpose }))
    if (this.next) { const run = this.next; this.next = undefined; yield* run(options); return }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ack' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ack' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
export async function fixture(run) {
  return withTempDir('context-read', async dir => {
    const file = path.join(dir, 'read.txt')
    fs.writeFileSync(file, Array.from({ length: 30 }, (_, i) => `payload line ${i + 1}: ${'content '.repeat(10)}`).join('\n'))
    const { ctx } = await bootHost()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(Subprocess)
      await ctx.plugin(Sandbox, {})
      const modes = new Map()
      const policyReads = { count: 0 }
      await ctx.plugin(inner => inner.provide('sandboxPolicy', {
        resolve: ({ session }) => { policyReads.count++; return { mode: modes.get(session) ?? 'danger-full-access', workspaceRoot: session.header.cwd, sessionId: session.id } },
      }))
      const agents = []
      ctx.provide('agents', { list: () => [...agents] })
      const { fiber: fileFiber } = await mountPlugin({ ctx, config: { required: true } })
      const discoveryFiber = await ctx.plugin(legacyComponent(Discovery), { enabled: false, required: true,
        alwaysLoaded: ['inspect_local_file', 'read_files'].filter(name => DISCOVERABLE_TOOLS.includes(name)) })
      const fiber = { dispose: async () => { await discoveryFiber.dispose(); await fileFiber.dispose() } }
      const admitted = new WeakSet()
      const adapter = new RecordingAdapter()
      ctx.get('llm').registerAdapter(['fixture'], adapter)
      let sequence = 0
      const mint = id => {
        const agent = { id, session: ctx.get('sessions').create(id, { meta: { cwd: dir } }) }
        return agent
      }
      const agent = mint('read-session')
      const request = async (messages = agent.session.deriveMessages(), options = {}) => {
        const chunks = []
        for await (const chunk of ctx.get('llm').stream({ provider: 'fixture', model: 'fixture', sessionId: agent.session.id, messages, ...options })) chunks.push(chunk)
        return chunks
      }
      const read = async ({ args = { path: file }, owner = agent, commit = true, callId = `read-${++sequence}`, name = READ } = {}) => {
        if (!admitted.has(owner)) {
          if (!owner.ctx) await ctx.plugin({ inject: ['tools'], apply(inner) { owner.ctx = createScope(inner, owner).ctx } })
          // Discovery's injected mount may still be awaiting provider/ownership setup.
          // Its real agent inventory lets the initialization refresh attach missed events.
          agents.push(owner)
          await ctx.serial('agent/created', { agent: owner })
          await waitFor(() => ctx.get('tools').definitions(owner).some(tool => tool.name === READ), {
            timeoutMs: 5_000, what: 'context-read discovery registration and scope ownership',
          })
          admitted.add(owner)
        }
        const prepared = await prepareStep(ctx, owner)
        assert.ok(ctx.get('tools').executable(name, owner, prepared.toolSet), `${name} registered but not admitted in resolved toolSet`)
        const assistant = createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }] })
        if (commit && owner.session.append) owner.session.append('assistant/message', { turn: 1, step: sequence, message: assistant, stream: [] }, { surfaceOp: 'append' })
        let result
        try { result = await executeCall(ctx, { agent: owner, toolSet: prepared.toolSet, callId, name, arguments: args }) }
        finally { prepared.dispose() }
        const message = createToolResultMessage({ callId, content: result.content, isError: result.isError })
        const event = commit && owner.session.append ? owner.session.append('tool/result', { turn: 1, step: sequence, message }, { surfaceOp: 'append' }) : undefined
        ctx.emit('session/event', owner.session, { type: 'step/end' })
        assert.equal(result.isError, false, text(result))
        return { ...result, message, assistant, event }
      }
      const compact = () => {
        const nodes = [...agent.session.surface.nodes]
        const before = agent.session.surface.contentGeneration
        agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Compacted summary, without the read body.' }] }),
          { surfaceOp: { op: 'replace', startSeq: nodes[0], endSeq: nodes.at(-1) }, sourceEventSeqs: nodes })
        assert.ok(agent.session.surface.contentGeneration > before)
      }
      const call = async (input) => {
        const prepared = await prepareStep(ctx, input.agent)
        try { return await executeCall(ctx, { ...input, toolSet: prepared.toolSet }) }
        finally { prepared.dispose() }
      }
      await run({ call, ctx, dir, file, agent, adapter, modes, mint, request, read, compact, fiber, policyReads })
    } finally { await shutdown(ctx) }
  })
}
