/** DSH 0.2.2 definition readers. Registry diagnostics and step admission stay distinct. */
import type { ResolvedToolSet, ToolDefinition, ToolRuntime } from '../adapter/dsh/types.js'

const identities = new WeakMap<object, number>()
let sequence = 0
const identityOf = (definition: ToolDefinition): number => {
  const known = identities.get(definition)
  if (known !== undefined) return known
  const next = ++sequence
  identities.set(definition, next)
  return next
}
const flatten = (text: string): string => text.replaceAll('\\', '\\\\').replaceAll('\u0000', '\\0').replaceAll('\u0001', '\\1')
const unescape = (text: string): string => {
  let out = ''
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (char !== '\\') { out += char; continue }
    const next = text[index + 1]
    if (next === '\\') { out += '\\'; index++ }
    else if (next === '0') { out += '\u0000'; index++ }
    else if (next === '1') { out += '\u0001'; index++ }
    else out += char
  }
  return out
}
/** Read one public definition list without schema cloning or per-name lookups. */
export const surfaceOf = (tools: Pick<ToolRuntime, 'definitions'>, scope?: object, toolSet?: ResolvedToolSet): string =>
  tools.definitions(scope, toolSet).map(definition => `${flatten(definition.name)}\u0001${identityOf(definition)}`).join('\u0000')

/** Recover names from a registration-identity key. */
export const surfaceNames = (surface: string): string[] =>
  surface === '' ? [] : surface.split('\u0000').map(entry => unescape(entry.split('\u0001')[0]!))

/** Omit toolSet only when inspecting registrations rather than a prepared model step. */
export const visibleNames = (tools: Pick<ToolRuntime, 'definitions'>, scope?: object, toolSet?: ResolvedToolSet): string[] =>
  tools.definitions(scope, toolSet).map(definition => definition.name)
