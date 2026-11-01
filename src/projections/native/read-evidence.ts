import type { Agent } from '../../adapter/dsh/types.js'
import type { GenerateOptions } from '../../adapter/dsh/types.js'
import type { Session } from '../../adapter/dsh/types.js'
import type { ToolExecution } from '../../adapter/dsh/types.js'
import { exactJson } from './read-observation.js'
import type { ReadObservation } from './read-observation.js'

export interface ReadRecord extends ReadObservation {
  readonly callId: string
  readonly name: string
  readonly args: string
  messageId?: string
}
export interface EvidenceState {
  readonly agent: Agent
  readonly session: Session
  readonly generation: number
  epoch: number
  records: ReadRecord[]
  proof: Map<ReadRecord, string>
}
export function generation(session: Session): number | undefined {
  try {
    const value = session.surface.contentGeneration
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined
  } catch { return }
}
export function readRecord(observation: ReadObservation, exec: Readonly<ToolExecution>): ReadRecord {
  return { ...observation, callId: exec.callId, name: exec.name, args: exactJson(exec.arguments) }
}
/** Positive evidence is the exact role, source, durable identity and body in this provider request. */
export function requestProof(options: GenerateOptions, state: EvidenceState): Map<ReadRecord, string> {
  const proof = new Map<ReadRecord, string>()
  for (const entry of state.records) {
    if (!entry.messageId) continue
    const results = options.messages.filter(message => message.role === 'tool' && message.id === entry.messageId)
    if (results.length !== 1) continue
    const result = results[0]
    if (!result || result.role !== 'tool' || result.isError || result.toolCallId !== entry.callId
      || result.source.kind !== 'tool' || result.source.callId !== entry.callId
      || exactJson(result.content) !== exactJson([{ type: 'text', text: entry.body }])) continue
    const resultIndex = options.messages.indexOf(result)
    const calls = options.messages.slice(0, resultIndex).flatMap(message => message.role === 'assistant' && message.source.kind === 'model'
      ? message.content.filter(block => block.type === 'tool-call' && block.id === entry.callId) : [])
    if (calls.length !== 1) continue
    const call = calls[0]
    if (!call || call.type !== 'tool-call' || call.name !== entry.name) continue
    try {
      if (exactJson(JSON.parse(call.arguments)) === entry.args) proof.set(entry, entry.messageId)
    } catch { /* Raw arguments that cannot identify this successful call are not proof. */ }
  }
  return proof
}
