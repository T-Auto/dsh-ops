import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolExecution, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { publicToolName } from '../../policy.js'
import { CAPABILITIES, OBSERVED_READ_TOOLS } from '../../capabilities/registry.js'
import { exactJson, observeRead, unchangedContent } from './read-observation.js'
import { generation, readRecord, requestProof } from './read-evidence.js'
import type { EvidenceState, ReadRecord } from './read-evidence.js'

const READS = new Set(OBSERVED_READ_TOOLS.map(publicToolName))
const harmless = new Set(CAPABILITIES.filter(entry => !entry.mutates).map(entry => publicToolName(entry.rawName)))
const MAX_AGENTS = 16, MAX_RECORDS = 32, MAX_BODY_BYTES = 2 * 1024 * 1024

/** Scope-owned, bounded evidence. This never caches execution values or skips file authority/IO. */
export function createNativeReadDedup(ctx: Context): { wrap(tool: ToolDefinition): ToolDefinition; dispose(): void } {
  if (typeof ctx.on !== 'function') return { wrap: tool => tool, dispose() {} }
  const states = new Map<Agent, EvidenceState>()
  const pending = new Map<ToolExecutionToken, { state: EvidenceState; entry: ReadRecord }>()
  const disposers: (() => void)[] = []
  let stopped = false
  const forget = (agent: Agent) => {
    states.delete(agent)
    for (const [token, candidate] of pending) if (candidate.state.agent === agent) pending.delete(token)
  }
  const current = (agent: Agent): EvidenceState | undefined => {
    if (stopped) return
    const value = generation(agent.session)
    const previous = states.get(agent)
    if (value === undefined) { forget(agent); return }
    if (previous?.session === agent.session && previous.generation === value) return previous
    forget(agent)
    if (states.size >= MAX_AGENTS) {
      const oldest = states.keys().next().value
      if (oldest) forget(oldest)
    }
    const state: EvidenceState = { agent, session: agent.session, generation: value, epoch: 0, records: [], proof: new Map() }
    states.set(agent, state)
    return state
  }
  const finalized = (exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => {
    const candidate = pending.get(exec.token)
    pending.delete(exec.token)
    if (!exec.agent || exec.parent) return
    if (!harmless.has(exec.name)) { forget(exec.agent); return }
    if (!candidate || result.isError || exactJson(result.content) !== exactJson([{ type: 'text', text: candidate.entry.body }])
      || current(exec.agent) !== candidate.state) return
    const state = candidate.state
    if (state.records.some(entry => entry.callId === exec.callId)) { forget(exec.agent); return }
    state.records.push(candidate.entry)
    while (state.records.length > MAX_RECORDS || state.records.reduce((size, entry) => size + Buffer.byteLength(entry.body), 0) > MAX_BODY_BYTES) {
      const removed = state.records.shift()
      if (removed) state.proof.delete(removed)
    }
  }
  const stream = async function* (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    if (options.purpose || stopped) { yield* next(); return }
    if (!options.sessionId) {
      for (const state of states.values()) { state.proof.clear(); state.epoch++ }
      yield* next()
      return
    }
    const matching = [...states.values()].filter(state => state.session.id === options.sessionId)
    // A reused session id cannot transfer evidence between owners.
    if (matching.length !== 1) { for (const state of matching) forget(state.agent); yield* next(); return }
    const previous = matching[0]!
    const state = current(previous.agent)
    if (!state) { yield* next(); return }
    const epoch = ++state.epoch
    state.proof.clear()
    const proof = () => { try { return requestProof(options, state) } catch { return new Map<ReadRecord, string>() } }
    const before = proof()
    let finished = false
    for await (const chunk of next()) {
      if (chunk.type === 'finish') finished = chunk.reason.kind === 'stop' || chunk.reason.kind === 'tool-calls'
      yield chunk
    }
    if (!finished || options.signal?.aborted || current(state.agent) !== state || state.epoch !== epoch) return
    const after = proof()
    state.proof = new Map([...before].filter(([entry, id]) => after.get(entry) === id))
  }
  disposers.push(ctx.on('tools/result', (exec, result) => { try { finalized(exec, result) } catch { if (exec.agent) forget(exec.agent) } }))
  disposers.push(ctx.on('llm/stream', stream))
  disposers.push(ctx.on('session/event', (session, event) => {
    try {
      for (const previous of [...states.values()]) {
        if (previous.session !== session) continue
        if (event.type === 'sandbox/mode') { forget(previous.agent); continue }
        const state = current(previous.agent)
        if (!state || event.type !== 'tool/result') continue
        const message = event.data.message
        for (const entry of state.records) {
          if (entry.callId !== message.toolCallId) continue
          if (message.isError || message.source.callId !== entry.callId || !message.id
            || exactJson(message.content) !== exactJson([{ type: 'text', text: entry.body }])
            || (entry.messageId && entry.messageId !== message.id)) { forget(state.agent); break }
          entry.messageId = message.id
        }
      }
    } catch { for (const state of [...states.values()]) if (state.session === session) forget(state.agent) }
  }))
  disposers.push(ctx.on('agent/disposed', ({ agent }) => { forget(agent) }))
  disposers.push(ctx.on('session/disposed', session => { for (const state of [...states.values()]) if (state.session === session) forget(state.agent) }))
  return {
    wrap(tool) {
      if (!READS.has(tool.name) || tool.finalizeContent) return tool
      return { ...tool, finalizeContent(exec, result) {
        try {
          if (!exec.agent || !exec.token || exec.callId.length > 256) return
          const state = current(exec.agent)
          const observation = state && observeRead(tool, exec, result)
          if (!state || !observation) return
          for (const [entry, messageId] of state.proof) {
            if (entry.key !== observation.key || entry.body !== observation.body || messageId.length > 256) continue
            const text = unchangedContent(observation.body, entry.callId, messageId)
            if (text) return [{ type: 'text', text }]
          }
          pending.set(exec.token, { state, entry: readRecord(observation, exec) })
        } catch { if (exec.agent) forget(exec.agent) }
        return undefined
      } }
    },
    dispose() {
      stopped = true
      states.clear()
      pending.clear()
      for (const dispose of disposers.splice(0)) { try { dispose() } catch { /* Scope teardown continues. */ } }
    },
  }
}
