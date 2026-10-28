/** Shared lifecycle gate for scoped publication; product preset rules stay in modes/. */
import type { Agent } from '../adapter/dsh/types.js'
export interface PublicationGate {
  allows(agent: Agent): boolean
  watch?(notify: () => void): () => void
}
