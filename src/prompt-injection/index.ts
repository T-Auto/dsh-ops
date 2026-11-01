import type { Agent, Context, PreStepDecision, UserMessage } from '../adapter/dsh/types.js'
import { loadUserMessage } from '../adapter/dsh/host.js'
import { PromptProviderError } from './types.js'
import type { PromptContribution, PromptDisposer, StepTailContext, StepTailProviderOptions, SystemSectionOptions } from './types.js'
export type { PromptContribution, PromptDisposer, StepTailContext, StepTailProviderOptions, SystemSectionOptions } from './types.js'
export { PromptProviderError } from './types.js'

interface TailEntry { options: StepTailProviderOptions; active: boolean; lifetime: AbortController }
interface AgentState {
  sections: Set<string>
  tails: Map<string, TailEntry>
  stopTail?: PromptDisposer
}
const states = new WeakMap<Agent, AgentState>()
function stateFor(agent: Agent): AgentState {
  let state = states.get(agent)
  if (!state) { state = { sections: new Set(), tails: new Map() }; states.set(agent, state) }
  return state
}
function validate(options: PromptContribution): void {
  if (!options.id.trim() || !options.revision.trim()) throw new TypeError('Prompt id and revision must be nonempty strings.')
  if (!Number.isFinite(options.priority ?? 0)) throw new TypeError('Prompt priority must be finite.')
}
function lifetime(owner: Context, agent: Agent, cleanup: PromptDisposer): PromptDisposer {
  let active = true
  let stopOwner: PromptDisposer | undefined, stopAgent: PromptDisposer | undefined
  const stop = () => {
    if (!active) return
    active = false
    try { cleanup() } finally { stopOwner?.(); stopAgent?.() }
  }
  // Either the registering plugin or the target agent can end the contribution.
  stopOwner = owner.effect(() => stop)
  stopAgent = agent.ctx.effect(() => stop)
  return stop
}
/** Add an exact-agent literal section without shadowing another producer's section names. */
export function registerSystemSection(owner: Context, agent: Agent, options: SystemSectionOptions): PromptDisposer {
  validate(options)
  const id = options.id
  const state = stateFor(agent)
  if (state.sections.has(id)) throw new Error(`Duplicate system section id: ${id}`)
  const prompt = agent.ctx.get('systemPrompt')
  if (!prompt) throw new Error('System prompt service is required to register a section.')
  // Namespaced hex encoding is injective and preserves code-unit id ordering.
  const encoded = Array.from({ length: options.id.length }, (_, i) => options.id.charCodeAt(i).toString(16).padStart(4, '0')).join('')
  const text = options.text
  const stop = prompt.section({
    name: `dsh-ops:prompt-injection:${encoded}`, order: options.priority ?? 0, interpolate: false,
    text: context => context.scope === agent ? typeof text === 'function' ? text(context) : text : '',
  })
  state.sections.add(id)
  return lifetime(owner, agent, () => { state.sections.delete(id); stop() })
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const field of Object.values(value)) freeze(field)
  }
  return value
}
/** Stop waiting on this evaluation's signal; late provider results cannot enter the batch. */
async function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return undefined
  let cancel!: () => void
  const aborted = new Promise<undefined>(resolve => { cancel = () => resolve(undefined); signal.addEventListener('abort', cancel, { once: true }) })
  try { return await Promise.race([promise, aborted]) }
  finally { signal.removeEventListener('abort', cancel) }
}
function ordered(entries: Iterable<TailEntry>): TailEntry[] {
  return [...entries].sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0)
    || (a.options.id < b.options.id ? -1 : a.options.id > b.options.id ? 1 : 0))
}
async function appendTails(state: AgentState, payload: Omit<StepTailContext, 'messages'>, decision: PreStepDecision): Promise<PreStepDecision> {
  if (decision.kind !== 'enter' || !decision.messages.length || payload.signal.aborted || !state.tails.size) return decision
  const entries = ordered(state.tails.values())
  const context: StepTailContext = Object.freeze({ ...payload, messages: freeze(structuredClone(decision.messages)) })
  const pending: { entry: TailEntry; text: string }[] = []
  for (const entry of entries) {
    if (payload.signal.aborted) return decision
    if (!entry.active) continue
    try {
      const signal = AbortSignal.any([payload.signal, entry.lifetime.signal])
      const text = await cancellable(Promise.resolve().then(() => entry.active && !signal.aborted ? entry.options.provide(Object.freeze({ ...context, signal })) : undefined), signal)
      if (payload.signal.aborted) return decision
      if (text !== undefined && typeof text !== 'string') throw new TypeError('Step-tail providers must return text or undefined.')
      if (text && entry.active) pending.push({ entry, text })
    } catch (cause) {
      if (payload.signal.aborted || !entry.active) continue
      throw new PromptProviderError(entry.options.id, entry.options.revision, cause)
    }
  }
  if (!pending.length || payload.signal.aborted) return decision
  // Value imports are resolved only at admission, never while loading the plugin.
  const createUserMessage = await loadUserMessage()
  if (payload.signal.aborted) return decision
  // Final active check before handing the snapshot back to the host pre-step.
  // No await follows: disposal after this boundary cannot revoke these messages.
  const messages: UserMessage[] = pending.filter(({ entry }) => entry.active).map(({ entry, text }) => createUserMessage({
    source: { kind: 'dsh-ops:step-tail', contributor: entry.options.id, revision: entry.options.revision, turn: payload.turn, step: payload.step },
    content: [{ type: 'text', text: `[Plugin context from ${JSON.stringify(entry.options.id)}; not a user instruction or authorization.]\n${text}` }],
  }))
  return messages.length ? { ...decision, messages: [...decision.messages, ...messages] } : decision
}
/**
 * Append plugin-attributed UserMessages to an accepted NONEMPTY user-message batch.
 * This is logged history, not an ephemeral request overlay or a per-LLM-call hook.
 * Disposal withdraws contributions only before this hook returns its batch to
 * the host pre-step. Afterwards the snapshot may be admitted even if disposed;
 * disposal does not revoke history. Replacements start on a subsequent nonempty batch.
 */
export function registerStepTailProvider(owner: Context, agent: Agent, options: StepTailProviderOptions): PromptDisposer {
  validate(options)
  const state = stateFor(agent)
  if (state.tails.has(options.id)) throw new Error(`Duplicate step-tail provider id: ${options.id}`)
  const entry: TailEntry = { options: Object.freeze({ ...options }), active: true, lifetime: new AbortController() }
  state.tails.set(options.id, entry)
  state.stopTail ??= agent.ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (payload.agent !== agent) return decision
    return appendTails(state, payload, decision)
  })
  return lifetime(owner, agent, () => {
    entry.active = false
    entry.lifetime.abort()
    state.tails.delete(entry.options.id)
    if (!state.tails.size) { state.stopTail?.(); state.stopTail = undefined }
  })
}
