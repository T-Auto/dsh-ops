/** One execution contract with independent Native text and typed program output. */
import type { ToolDefinition, ToolExecutionResult } from '../adapter/dsh/types.js'
import type { Outcome } from '../kernel/outcome.js'
import { toOutcome } from './ptc/outcome.js'
import type { CanonicalData } from './ptc/outcome.js'
import { outcomeSchema } from './ptc/schema.js'

/** No raw receipt exists for data-less failures; replay the serializable error facts instead. */
function nativeValue(value: unknown): unknown {
  const outcome = value as Outcome<CanonicalData>
  return outcome.data ?? outcome
}

/** Host failures without a value have no Native receipt to replay. */
function nativeResult(result: Readonly<ToolExecutionResult>): Readonly<ToolExecutionResult> {
  if (result.isError) return result
  return { ...result, value: nativeValue(result.value) as typeof result.value }
}

/** Adapt a raw kernel definition without registering it or retaining per-call state. */
export function canonicalOutput(tool: string, definition: ToolDefinition): ToolDefinition {
  const { output } = definition
  return {
    ...definition,
    execute: async (args, exec) => toOutcome(tool, args, await definition.execute(args, exec)),
    // Hooks belong to the raw Native projection; preserve execution identity and
    // content while leaving the host's final canonical value untouched.
    ...(definition.projectContent ? {
      projectContent: (exec, result) => definition.projectContent!(exec, nativeResult(result)),
    } : {}),
    ...(definition.finalizeContent ? {
      finalizeContent: (exec, result) => definition.finalizeContent!(exec, nativeResult(result)),
    } : {}),
    output: {
      ...output,
      schema: outcomeSchema(output.schema),
      render: (args, value) => output.render(args, nativeValue(value) as Parameters<typeof output.render>[1]),
      ...(output.presentationMeta ? {
        presentationMeta: (args, value) => output.presentationMeta!(args,
          nativeValue(value) as Parameters<NonNullable<typeof output.presentationMeta>>[1]),
      } : {}),
    },
  }
}
