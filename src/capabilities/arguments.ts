/** Shared argument normalization; projections never own execution inputs. */
import { capability } from './registry.js'
export function normalizeArguments(rawName: string, args: unknown): unknown {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return args
  const entry = capability(rawName)
  const schema = entry?.component === 'file' ? entry.parameters : undefined
  if (!schema) return { ...args }
  const required = new Set(schema.required)
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue
    const field = schema.properties[key]
    if (field && !required.has(key)) {
      if (field.type === 'string' && typeof value === 'string' && value.trim() === '') continue
      if (field.type === 'array' && Array.isArray(value) && value.length === 0) continue
    }
    result[key] = value
  }
  return result
}
