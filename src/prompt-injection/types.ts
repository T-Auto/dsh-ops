import type { Agent, AssembleContext } from '../adapter/dsh/types.js'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** Stable identity within one agent and contribution kind. Dispose before replacing a revision. */
export interface PromptContribution {
  readonly id: string
  readonly revision: string
  /** Ascending order; equal priorities use code-unit id order. Defaults to zero. */
  readonly priority?: number
}
export interface SystemSectionOptions extends PromptContribution {
  /** Literal text: braces are never interpolated. Providers are synchronous, like host sections. */
  readonly text: string | ((context: AssembleContext) => string)
}
export type ReadonlyValue<T> = T extends object ? { readonly [K in keyof T]: ReadonlyValue<T[K]> } : T
export interface StepTailContext {
  readonly agent: Agent
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
  /** Detached, deeply frozen accepted batch, without this API's contributions. */
  readonly messages: readonly ReadonlyValue<UserMessage>[]
}
export interface StepTailProviderOptions extends PromptContribution {
  /** Called only for accepted nonempty user-message batches, not every model request. */
  readonly provide: (context: StepTailContext) => string | undefined | Promise<string | undefined>
}
/** Provider failures reject admission and reach the host's normal agent/error channel. */
export class PromptProviderError extends Error {
  constructor(readonly contributionId: string, readonly revision: string, cause: unknown) {
    super(`Step-tail provider ${JSON.stringify(contributionId)} revision ${JSON.stringify(revision)} failed.`, { cause })
    this.name = 'PromptProviderError'
  }
}
export type PromptDisposer = () => void

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-ops:step-tail': {
      readonly kind: 'dsh-ops:step-tail'
      readonly contributor: string
      readonly revision: string
      readonly turn: number
      readonly step: number
    }
  }
}
