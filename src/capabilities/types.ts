import type { JsonSchemaNode, ObjectJsonSchema, ToolPresentationMode } from '../adapter/dsh/types.js'

export type Component = 'file' | 'ptc' | 'shell' | 'discovery' | 'ast'
export type ParameterSchema = ObjectJsonSchema & Record<string, unknown> & {
  properties: Record<string, JsonSchemaNode>
  required: string[]
}

/** Native publication tier; the PTC adapter independently projects the full kernel. */
export interface CapabilityMetadata {
  readonly rawName: string
  readonly component: Component
  /** Who answers this name. Absent means the native worker. */
  readonly executor?: 'ast-inproc'
  readonly presentations: readonly ToolPresentationMode[]
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
