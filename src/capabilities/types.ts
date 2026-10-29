import type { JsonSchemaNode, ObjectJsonSchema } from '../adapter/dsh/types.js'

export type Component = 'file' | 'ptc' | 'shell' | 'discovery'
/**
 * Where this catalogue publishes a capability. DSH 0.2.2 removed the host's
 * `ToolPresentationMode` in favour of per-call presenters; this vocabulary
 * describes the plugin's own publication tiers, so it is declared locally and
 * its members are unchanged.
 */
export type PresentationMode = 'native' | 'ptc' | 'both'
export type ParameterSchema = ObjectJsonSchema & Record<string, unknown> & {
  properties: Record<string, JsonSchemaNode>
  required: string[]
}

/** Native publication tier; the PTC adapter independently projects the full kernel. */
export interface CapabilityMetadata {
  readonly rawName: string
  readonly component: Component
  readonly presentations: readonly PresentationMode[]
  readonly availability: 'resident' | 'discoverable'
  /** PTC publication is independent of the Native tier. */
  readonly ptcAvailability?: 'resident' | 'discoverable'
  readonly supportsContinuation?: boolean
  readonly observesRead?: boolean
  /** Conservative per-tool flag: some actions (batch plan/result page) remain read-only. */
  readonly mutates: boolean
  readonly concurrencySafe: boolean
}

export interface SchemaCapability extends CapabilityMetadata {
  readonly parameters: ParameterSchema
  readonly description: string
  readonly output: JsonSchemaNode
  readonly nativeProjection?: { readonly component: 'file'; readonly availability?: 'resident' | 'discoverable'; readonly parameters: ParameterSchema; readonly description: string }
}
