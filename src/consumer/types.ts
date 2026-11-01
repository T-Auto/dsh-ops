/** Unified consumer plan shared by built-in and externally mounted presets. */
import type { Agent } from '../adapter/dsh/types.js'
import type { ResolvedConfig } from '../config.js'
import type { DiscoveryConfig } from '../discovery/config.js'
import type { PtcConfig } from '../ptc/config.js'
import type { FileToolName } from '../capabilities/registry.js'

export interface ConsumerGate {
  allows(agent: Agent): boolean
  watch?(notify: () => void): () => void
}

export interface ConsumerPlan {
  /** Stable owner id used for diagnostics, sections and scoped publication. */
  readonly id: string
  readonly gate: ConsumerGate
  readonly core: ResolvedConfig
  readonly files: boolean
  readonly shell: boolean
  readonly presentation: 'native' | 'ptc'
  readonly residentTools: boolean
  readonly residentNames?: readonly (FileToolName | 'result')[]
  readonly discovery: boolean
  readonly native: DiscoveryConfig
  readonly ptc: PtcConfig
  readonly replaceOfficial: boolean
  readonly replacementTargets: ReadonlyMap<string, string>
  readonly section: string | null
  readonly external: {
    readonly allowed: readonly string[]
    readonly alwaysLoaded: readonly string[]
    readonly disabled: readonly string[]
  }
}
