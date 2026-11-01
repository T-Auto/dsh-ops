/** PTC-only typed projection over the shared capability catalogue and canonical worker. */
import type { ToolDefinition } from '../../adapter/dsh/types.js'
import { publicToolName } from '../../policy.js'
import { capability, FILE_TOOLS, PTC_TOOLS } from '../../capabilities/registry.js'
import type { FileToolName, PtcToolName } from '../../capabilities/registry.js'
import { PARAMETERS, DESCRIPTIONS, OUTPUT } from '../../capabilities/ptc.js'
import { outcomeSchema } from './schema.js'
import { canonicalOutput } from './canonical-schema.js'
import { toOutcome } from './outcome.js'
import { WORKER_TIMEOUT_MS } from '../../execution/protocol.js'
export { PTC_TOOLS, PARAMETERS, DESCRIPTIONS, OUTPUT }
export const PTC_API_TOOLS = Object.freeze([...FILE_TOOLS, ...PTC_TOOLS])
export const PTC_SECTION = 'dsh-ops:repository-tooling:mode-ptc'
export function definition(tool: FileToolName | PtcToolName, execute: ToolDefinition['execute']): ToolDefinition {
  const entry = capability(tool)
  if (!entry || !('parameters' in entry)) throw new Error(`Missing PTC capability: ${tool}`)
  const description = entry.description.replace(/ Failures resolve as .*?they are not thrown\./, '')
  return { name: publicToolName(tool), description: description +
    ' PTC returns Outcome: completed.data; partial.data, coverage and continuation; failures use error.code/effectState/retry. Check status before reading data; never blindly retry a possible write.',
    parameters: entry.parameters, timeoutMs: WORKER_TIMEOUT_MS + 2000,
    ...(entry.concurrencySafe ? { isConcurrencySafe: () => true } : {}),
    output: { schema: outcomeSchema(canonicalOutput(tool)), render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      try { return toOutcome(tool, args, await execute(args, exec)) }
      catch { return toOutcome(tool, args, { status: 'unknown', error: { code: 'RESULT_UNKNOWN', effectState: 'unknown',
        message: 'The operation did not return a settled receipt. Inspect postconditions before recovery.' } }) }
    },
  }
}
