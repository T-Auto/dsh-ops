/** Model-facing routing, kept in one section. No shared registry mutation. */
export const TOOLING_SECTION = 'dsh-ops:repository-tooling'
// Legacy section name kept for consumers; the plugin no longer publishes it.
export const HOST_SHELL_SECTION = 'dsh-ops:host-shell-policy'
export const SECTION_ORDERS = Object.freeze({ [TOOLING_SECTION]: 3250 })
export const TOOL_PREFIX = 'ops_'
export const FILE_TOOLS = Object.freeze(['inspect_local_file', 'grep', 'glob', 'replace'])
// The plugin's second layer executes POSIX commands; pwsh7 uses the host tool.
export const IN_PROCESS_TOOLS = Object.freeze(['bash'])
export function publicToolName(rawName) { return `${TOOL_PREFIX}${rawName}` }
export const BASH_TOOL = publicToolName('bash')

/** Resolve the actual command capability, not the presence of a shell executable. */
export function ladderLevels({ published, pwsh = false }) {
  const names = new Set(published)
  return {
    files: FILE_TOOLS.some(name => names.has(publicToolName(name))),
    bash: names.has(BASH_TOOL),
    pwsh: pwsh === true && names.has('pwsh'),
  }
}

/** A single compact table; absent tools never get advertised. */
export function renderToolingPolicy({ published, mounted, levels, pwsh7 = false, shellComponent = true, extraGuidance = '' }) {
  const names = new Set(published ?? (mounted || levels?.files
    ? [...FILE_TOOLS, ...(levels?.bash ? IN_PROCESS_TOOLS : [])].map(publicToolName) : []))
  if (levels?.pwsh) names.add('pwsh')
  if (!shellComponent) names.delete('pwsh')
  const hasFiles = FILE_TOOLS.some(name => names.has(publicToolName(name)))
  const hasBash = names.has(BASH_TOOL)
  const hasPwsh = shellComponent && names.has('pwsh')
  if (!hasFiles && !hasBash && !hasPwsh) return ''
  const heading = hasBash ? '# Shell routing: bash → PowerShell 7'
    : hasFiles ? '# Repository file tools' : '# Windows-native shell'
  const lines = [heading, '', '| Task | Tool |', '| --- | --- |']
  const row = (raw, task) => {
    if (names.has(publicToolName(raw))) lines.push(`| ${task} | ${publicToolName(raw)} |`)
  }
  row('inspect_local_file', 'Text / multiple ranges / encoding / PDF text / hex')
  if (hasFiles && names.has('read_image')) lines.push('| Images | read_image (host) |')
  row('grep', 'Search contents')
  row('glob', 'Find paths')
  row('replace', 'Batch replacement; use host edit for precise edits')
  row('bash', 'General commands / builds / git / pipelines / scripts — preferred command executor')
  if (names.has('pwsh')) lines.push(`| Windows-native cmdlets / registry / services only | pwsh (${pwsh7 || levels?.pwsh ? 'bundled PowerShell 7 via host' : 'host PowerShell'}) |`)
  lines.push('', '- ops_* arguments are strict: pass only declared fields.')
  if (hasFiles) lines.push('- Use file tools for file operations; use count for totals and batch independent requests.')
  if (hasFiles) lines.push(
    '- Every file tool has one `path`, resolved relative to the current DSH session cwd. Use `/` separators; do not pass root, workspace, cwd, or file_path aliases.',
    '- Native file tools are UTF-8 first and bounded. glob and grep do not traverse symlinks, junctions, reparse points, hidden files, or `.git`.',
  )
  // Per-tool syntax (ops_glob `pattern` is an ARRAY; *.md matches top level only; ops_grep has
  // no `include`; ops_replace `pattern` is literal text) now lives in each tool's own description;
  // the routing table keeps only routing-unique guidance to avoid duplicating it every turn.
  if (hasFiles) lines.push('- ops file tools never throw: check `status` and `error.code`/`error.nextAction`; a try/catch alone misses their failures.')
  if (hasFiles) lines.push('- On a tool error, correct the arguments and retry; do not switch to a shell workaround.')
  if (names.has(BASH_TOOL)) lines.push('- Prefer bash for command execution. Use PowerShell only when Windows-native functionality is necessary; fix bash errors in bash, do not switch shells or mix their syntax.',
    '- Use command only for short commands and pipelines. For scripts longer than about 1 KB or containing heredocs, quotes, backslashes or non-ASCII text, write the script to a file first and pass script_path.',
    '- ops_bash resolves with `status` (completed/failed), `exitCode`, stdout/stderr, `error` and `permission`; it throws only for invalid arguments or an unavailable executor.')
  if (extraGuidance.trim()) lines.push('', extraGuidance.trim())
  return lines.join('\n')
}

/** Legacy API: no second prompt section. */
export function renderHostShellPolicy() { return '' }

/** Explicit deny policy applies even without an ops command capability. */
export function hostShellEnforcement({ shellPolicy }) {
  return { hide: shellPolicy === 'deny-host-shell', reason: undefined }
}
export function hostShellRefusal({ toolName, denied }) {
  if (!denied.has(toolName)) return undefined
  return { kind: 'deny', reason: `Host tool ${toolName} is disabled by dsh-ops shellPolicy. Use an available file tool for file operations; otherwise request an operator policy change.` }
}
