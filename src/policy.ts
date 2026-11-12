import { FILE_TOOLS, NATIVE_FILE_TOOLS, IN_PROCESS_TOOLS, DISCOVERY_TOOL_NAME } from './capabilities/registry.js'
export { FILE_TOOLS, FILE_MUTATIONS, IN_PROCESS_TOOLS } from './capabilities/registry.js'

/** Model-facing routing, kept in one section. No shared registry mutation. */
export const TOOLING_SECTION = 'dsh-ops:repository-tooling'
// Legacy section name kept for consumers; the plugin no longer publishes it.
export const HOST_SHELL_SECTION = 'dsh-ops:host-shell-policy'
export const SECTION_ORDERS = Object.freeze({ [TOOLING_SECTION]: 3250 })
/** Prompt-section suffix and order for one enhanced preset row. */
export const MODE_SECTION_ORDERS: Readonly<Record<string, number>> = Object.freeze({
  'mode-standard': 3250, 'mode-ptc': 3251, 'mode-cordis': 3252,
})
/**
 * The prompt section one mode row publishes.
 * @param suffix - the mode section suffix, for example `mode-standard`.
 * @returns the section name.
 */
export function modeSectionName(suffix: string): string { return `${TOOLING_SECTION}:${suffix}` }
export const TOOL_PREFIX = 'ops_'
// The plugin's second layer executes POSIX commands; pwsh7 uses the host tool.
export function publicToolName(rawName: string) { return `${TOOL_PREFIX}${rawName}` }
export const BASH_TOOL = publicToolName(IN_PROCESS_TOOLS[0])

/** Resolve the actual command capability, not the presence of a shell executable. */
export function ladderLevels({ published, pwsh = false }: { published: Iterable<string>, pwsh?: boolean }) {
  const names = new Set(published)
  return {
    files: NATIVE_FILE_TOOLS.some(name => names.has(publicToolName(name))),
    bash: names.has(BASH_TOOL),
    pwsh: pwsh === true && names.has('pwsh'),
  }
}

interface ToolingPolicyOptions {
  published?: Iterable<string>
  mounted?: boolean
  levels?: { files?: boolean, bash?: boolean, pwsh?: boolean }
  shellComponent?: boolean
  extraGuidance?: string
}

/** A single compact table; absent tools never get advertised. */
export function renderToolingPolicy({ published, mounted, levels, shellComponent = true, extraGuidance = '' }: ToolingPolicyOptions) {
  const names = new Set(published ?? (mounted || levels?.files
    ? [...NATIVE_FILE_TOOLS, ...(levels?.bash ? IN_PROCESS_TOOLS : [])].map(publicToolName) : []))
  if (levels?.pwsh) names.add('pwsh')
  if (!shellComponent) names.delete('pwsh')
  const hasDiscovery = names.has(publicToolName(DISCOVERY_TOOL_NAME))
  const hasFiles = NATIVE_FILE_TOOLS.some(name => names.has(publicToolName(name)))
  const hasBash = names.has(BASH_TOOL)
  const hasPwsh = shellComponent && names.has('pwsh')
  if (!hasFiles && !hasBash && !hasPwsh && !hasDiscovery) return ''
  const heading = hasBash ? `# Bash command execution: ${BASH_TOOL}`
    : hasFiles || hasDiscovery ? '# Repository file tools' : '# Windows-native shell'
  const lines = [heading, '', '| Task | Tool |', '| --- | --- |']
  const row = (raw: string, task: string) => {
    if (names.has(publicToolName(raw))) lines.push(`| ${task} | ${publicToolName(raw)} |`)
  }
  row(DISCOVERY_TOOL_NAME, 'Find advanced capabilities for the next model step')
  row('read_files', 'Read UTF-8 ranges from multiple files')
  row('read_table', 'Read bounded CSV / TSV lexical rows')
  row('read_docx', 'Read DOCX main-body paragraphs')
  row('read_pdf', 'Read supported PDF text-layer pages')
  row('inspect_local_file', 'Bounded UTF-8 lines / hex')
  if (hasFiles && names.has('read_image')) lines.push('| Images | read_image (host) |')
  row('grep', 'Search contents')
  row('glob', 'Find paths')
  row('replace', 'Batch literal replacement')
  row('write_file', 'Create / full UTF-8 write (CAS)')
  row('edit_file', 'Precise original-text patch (CAS)')
  row('diff', 'Preview proposed UTF-8 content')
  row('stat', 'Revision / bytes / line count / metadata')
  row('copy', 'Copy one regular file, no clobber')
  row('move', 'Move one regular file, same filesystem')
  row('remove', 'Remove one regular file (CAS)')
  row('result', 'Page / release owned result references')
  row('bash', 'General Bash commands / builds / git / pipelines / scripts')
  if (names.has('pwsh')) lines.push(`| Windows-native cmdlets / registry / services only | pwsh (host PowerShell) |`)
  lines.push('')
  if (hasFiles) lines.push('- Use published file tools for file operations.')
  if (hasDiscovery) lines.push(
    '- Discover a capability when a task needs a reader for a `.pdf`, `.docx`, `.csv` or `.tsv` file whose reader is absent from the tool table; selection makes it available on the next model step and performs no file action.',
    '- Creating, editing, rendering or exporting Office documents belongs to the host office skill, and a document read that fails falls back to it rather than retrying the reader.',
  )
  if (hasFiles) lines.push(
    '- Single-file tools use `path`, resolved relative to the current DSH session cwd. Use `/` separators; do not pass workspace, cwd, or file_path aliases.',
    '- Native file tools are UTF-8 first and bounded.',
  )
  if (names.has(publicToolName('copy')) || names.has(publicToolName('move'))) lines.push('- The destination `to` uses the same session cwd base as `path`.')
  if (names.has(publicToolName('write_file')) || names.has(publicToolName('edit_file'))) lines.push('- Read the current file state first and reuse its `revision` as `expectedRevision`. Unsupported metadata is not a permission escalation.')
  if (hasFiles) lines.push('- Follow error.nextAction; authorization denials require the user to change mode, not retries. After applied/unknown effects inspect postconditions; do not switch to a shell workaround.')
  if (names.has(BASH_TOOL)) {
    const fallback = hasPwsh
      ? 'Use host pwsh only when Windows-native functionality is necessary.'
      : 'No host pwsh tool is visible in this session; keep command execution in Bash.'
    lines.push(`- Prefer ${BASH_TOOL} for Bash command execution. ${fallback} Fix ${BASH_TOOL} errors in ${BASH_TOOL}; do not mix shell syntax.`)
  }
  if (extraGuidance.trim()) lines.push('', extraGuidance.trim())
  return lines.join('\n')
}

/** Legacy API: no second prompt section. */
export function renderHostShellPolicy() { return '' }

/** Explicit deny policy applies even without an ops command capability. */
export function hostShellEnforcement({ shellPolicy }: { shellPolicy?: string }) {
  return { hide: shellPolicy === 'deny-host-shell', reason: undefined }
}
export function hostShellRefusal({ toolName, denied }: { toolName: string, denied: ReadonlySet<string> }) {
  if (!denied.has(toolName)) return undefined
  return { kind: 'deny', reason: `Host tool ${toolName} is disabled by dsh-ops shellPolicy. Use an available file tool for file operations; otherwise request an operator policy change.` }
}
