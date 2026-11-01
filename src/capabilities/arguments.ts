/** Shared argument normalization; projections never own execution inputs. */
import { capability } from './registry.js'

/**
 * Create-capable tools whose CAS baseline may be omitted, as raw name → [field, sentinel].
 * Only `write_file` has a create mode; `edit_file`, `copy`, `move` and `remove` keep
 * requiring an observed revision, so omission there stays a schema error.
 */
const CREATE_ONLY: Readonly<Record<string, readonly [field: string, sentinel: string]>> = {
  write_file: ['expectedRevision', 'absent'],
}

export function normalizeArguments(rawName: string, args: unknown): unknown {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return args
  const entry = capability(rawName)
  const schema = entry?.component === 'file' ? entry.parameters : undefined
  if (!schema) return { ...args }
  const required = new Set(schema.required)
  const baseline = CREATE_ONLY[rawName]
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue
    const field = schema.properties[key]
    // A supplied baseline travels unchanged: an explicit null or blank is a caller
    // error the worker must report, never an omission that silently creates (#422).
    if (baseline?.[0] !== key) {
      if (value === null) continue
      if (field && !required.has(key)) {
        if (field.type === 'string' && typeof value === 'string' && value.trim() === '') continue
        if (field.type === 'array' && Array.isArray(value) && value.length === 0) continue
      }
    }
    result[key] = value
  }
  // An omitted baseline is still a CAS expectation on the wire: the worker receives
  // the create sentinel, so a path already created concurrently yields REVISION_CONFLICT.
  if (baseline && result[baseline[0]] === undefined) result[baseline[0]] = baseline[1]
  return result
}
