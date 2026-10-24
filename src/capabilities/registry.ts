import { DISCOVERY_PARAMETERS, DISCOVERY_DESCRIPTION, DISCOVERY_OUTPUT } from './discovery.js'
/** One catalogue for owned tools. This module never registers tools or imports host values. */
import { PARAMETERS as fileParameters, DESCRIPTIONS as fileDescriptions, fileOutput } from './file.js'
import { PARAMETERS as ptcParameters, DESCRIPTIONS as ptcDescriptions, OUTPUT as ptcOutput } from './ptc.js'
import { SDK_CAPABILITIES } from './sdk.js'
export { SDK_CAPABILITIES, SDK_OUTPUT } from './sdk.js'
import { NATIVE_RESULT_PARAMETERS, NATIVE_RESULT_DESCRIPTION } from './result.js'
import type { CapabilityMetadata, Component, SchemaCapability } from './types.js'

export type FileToolName = keyof typeof fileParameters
export type PtcToolName = keyof typeof ptcParameters
// Preserve the published registration order independently of schema object key order.
const fileOrder = ['inspect_local_file', 'grep', 'glob', 'replace', 'write_file', 'edit_file', 'diff', 'stat', 'copy', 'move', 'remove', 'read_files', 'read_table', 'read_docx', 'read_pdf'] as const satisfies readonly FileToolName[]
const fileMutations = new Set<FileToolName>(['replace', 'write_file', 'edit_file', 'copy', 'move', 'remove'])
const continuationReaders = new Set<FileToolName>(['inspect_local_file', 'read_files', 'glob', 'grep', 'diff', 'read_table', 'read_docx', 'read_pdf'])
const observedReaders = new Set<FileToolName>(['inspect_local_file', 'read_files'])
const allPresentations = Object.freeze(['native', 'ptc', 'both'] as const)

export const FILE_CAPABILITIES = Object.freeze(fileOrder.map(rawName => Object.freeze({
  rawName, component: 'file' as const, presentations: allPresentations,
  availability: rawName === 'read_files' ? 'resident' as const : 'discoverable' as const, mutates: fileMutations.has(rawName),
  concurrencySafe: !fileMutations.has(rawName),
  ptcAvailability: rawName === 'inspect_local_file' ? 'resident' as const : 'discoverable' as const,
  supportsContinuation: continuationReaders.has(rawName), observesRead: observedReaders.has(rawName),
  parameters: fileParameters[rawName], description: fileDescriptions[rawName], output: fileOutput(rawName),
} satisfies SchemaCapability)))
export const PTC_CAPABILITIES = Object.freeze((Object.keys(ptcParameters) as PtcToolName[]).map(rawName => Object.freeze({
  rawName, component: 'ptc' as const, presentations: rawName === 'result' ? allPresentations : Object.freeze(['ptc'] as const),
  ...(rawName === 'result' ? { nativeProjection: { component: 'file' as const, availability: 'discoverable' as const, parameters: NATIVE_RESULT_PARAMETERS, description: NATIVE_RESULT_DESCRIPTION } } : {}),
  availability: 'resident' as const, mutates: true, concurrencySafe: false,
  ptcAvailability: rawName === 'result' ? 'resident' as const : 'discoverable' as const,
  supportsContinuation: rawName === 'result',
  parameters: ptcParameters[rawName], description: ptcDescriptions[rawName], output: ptcOutput,
} satisfies SchemaCapability)))
// The shell owns its host-dependent schema. Its name and ownership still come from this catalogue.
export const SHELL_CAPABILITIES = Object.freeze([Object.freeze({
  rawName: 'bash', component: 'shell', presentations: allPresentations,
  availability: 'resident', mutates: true, concurrencySafe: false,
} as const satisfies CapabilityMetadata)])
export const DISCOVERY_CAPABILITIES = Object.freeze([Object.freeze({
  rawName: 'discover_tools', component: 'discovery', presentations: Object.freeze(['native', 'both'] as const),
  availability: 'resident', mutates: false, concurrencySafe: false,
  parameters: DISCOVERY_PARAMETERS, description: DISCOVERY_DESCRIPTION, output: DISCOVERY_OUTPUT,
} as const satisfies SchemaCapability)])
export const CAPABILITIES = Object.freeze([...FILE_CAPABILITIES, ...PTC_CAPABILITIES, ...SDK_CAPABILITIES, ...SHELL_CAPABILITIES, ...DISCOVERY_CAPABILITIES])
export type Capability = typeof CAPABILITIES[number]
export type ToolName = Capability['rawName']
const byName = new Map<string, Capability>(CAPABILITIES.map(capability => [capability.rawName, capability]))

export function capability(rawName: string): Capability | undefined { return byName.get(rawName) }
export function capabilitiesFor(component: Component): readonly Capability[] {
  return CAPABILITIES.filter(capability => capability.component === component)
}
export const FILE_TOOLS = Object.freeze(FILE_CAPABILITIES.map(capability => capability.rawName))
export const NATIVE_FILE_TOOLS = Object.freeze([...FILE_TOOLS, ...PTC_CAPABILITIES.filter(entry => entry.nativeProjection?.component === 'file').map(entry => entry.rawName)])
export const NATIVE_RESIDENT_FILE_TOOLS = Object.freeze(FILE_CAPABILITIES.filter(capability => capability.availability === 'resident').map(capability => capability.rawName))
export const FILE_MUTATIONS = Object.freeze(FILE_CAPABILITIES.filter(capability => capability.mutates).map(capability => capability.rawName))
export const PTC_TOOLS = PTC_CAPABILITIES.map(capability => capability.rawName)
export const IN_PROCESS_TOOLS = Object.freeze(SHELL_CAPABILITIES.map(capability => capability.rawName))
export const DISCOVERY_TOOL_NAME = DISCOVERY_CAPABILITIES[0].rawName
export const CONTINUATION_TOOLS = Object.freeze([...FILE_CAPABILITIES, ...PTC_CAPABILITIES].filter(entry => entry.supportsContinuation).map(entry => entry.rawName))
export const OBSERVED_READ_TOOLS = Object.freeze(FILE_CAPABILITIES.filter(entry => entry.observesRead).map(entry => entry.rawName))
export const PTC_RESIDENT_TOOLS = Object.freeze([...FILE_CAPABILITIES, ...PTC_CAPABILITIES].filter(entry => entry.ptcAvailability === 'resident').map(entry => entry.rawName))
