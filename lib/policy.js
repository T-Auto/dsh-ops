/** Model-facing routing, kept in one section. No shared registry mutation. */
export const TOOLING_SECTION = 'dsh-ops:repository-tooling'
// Legacy section name kept for consumers; the plugin no longer publishes it.
export const HOST_SHELL_SECTION = 'dsh-ops:host-shell-policy'
export const SECTION_ORDERS = Object.freeze({ [TOOLING_SECTION]: 3250 })
export const TOOL_PREFIX = 'ops_'
export const FILE_TOOLS = Object.freeze(['inspect_local_file', 'grep', 'glob', 'replace'])
export const SHELL_TOOLS = Object.freeze(['run', 'run_background', 'job_output', 'job_list', 'job_kill'])
// The plugin's second layer executes POSIX commands; pwsh7 uses the host tool.
export const IN_PROCESS_TOOLS = Object.freeze(['bash'])
export function publicToolName(rawName) { return `${TOOL_PREFIX}${rawName}` }
export const BASH_TOOL = publicToolName('bash')

/** Resolve the actual command capability, not the presence of a shell executable. */
export function ladderLevels({ published, pwsh = false }) {
  const names = new Set(published)
  return {
    fastctx: FILE_TOOLS.some(name => names.has(publicToolName(name))),
    run: names.has(publicToolName('run')),
    bash: names.has(BASH_TOOL),
    pwsh: pwsh === true && names.has('pwsh'),
  }
}

/** A single compact table; absent tools never get advertised. */
export function renderToolingPolicy({ published, enableShellTools, mounted, levels, pwsh7 = false, extraGuidance = '' }) {
  const names = new Set(published ?? (mounted || levels?.fastctx
    ? [...FILE_TOOLS, ...(enableShellTools ? SHELL_TOOLS : []), ...(levels?.bash ? IN_PROCESS_TOOLS : [])].map(publicToolName) : []))
  if (levels?.pwsh) names.add('pwsh')
  if (!FILE_TOOLS.some(name => names.has(publicToolName(name))) && !names.has(BASH_TOOL)) return ''
  const lines = ['# Repository operations: tools → bash → PowerShell 7', '', '| Task | Tool |', '| --- | --- |']
  const row = (raw, task) => {
    if (names.has(publicToolName(raw))) lines.push(`| ${task} | ${publicToolName(raw)} |`)
  }
  row('inspect_local_file', 'Text / multiple ranges / encoding / PDF text / hex')
  lines.push('| Images | read_image (host) |')
  row('grep', 'Search contents')
  row('glob', 'Find paths')
  row('replace', 'Batch replacement; use host edit for precise edits')
  row('bash', 'General commands / builds / git / pipelines / scripts — preferred command executor')
  if (names.has('pwsh')) lines.push(`| Windows-native cmdlets / registry / services only | pwsh (${pwsh7 || levels?.pwsh ? 'bundled PowerShell 7 via host' : 'host PowerShell'}) |`)
  row('run', 'Bounded bash command result (full access only)')
  if (names.has(publicToolName('run_background'))) {
    lines.push(`| Background commands / owned jobs | ${SHELL_TOOLS.slice(1).map(publicToolName).join(', ')} |`)
  }
  lines.push('', '- ops_* arguments are strict: pass only declared fields.',
    '- Do not build shell command lines for file operations.',
    '- On a tool error, correct the arguments and retry; do not switch to a shell workaround.')
  if (names.has(BASH_TOOL)) lines.push('- Prefer bash for command execution. Use PowerShell only when Windows-native functionality is necessary; fix bash errors in bash, do not switch shells or mix their syntax.')
  if (names.has(publicToolName('run_background'))) lines.push('- Only operate on job IDs you started in this session.')
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
