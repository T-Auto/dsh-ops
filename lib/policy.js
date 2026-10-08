/** Model-facing routing, kept in one section. No shared registry mutation. */
export const TOOLING_SECTION = 'dsh-ops:repository-tooling'
// Legacy section name kept for consumers; the plugin no longer publishes it.
export const HOST_SHELL_SECTION = 'dsh-ops:host-shell-policy'
export const SECTION_ORDERS = Object.freeze({ [TOOLING_SECTION]: 3250 })
export const TOOL_PREFIX = 'ops_'
export const FILE_TOOLS = Object.freeze(['inspect_local_file', 'grep', 'glob', 'replace'])
export const SHELL_TOOLS = Object.freeze(['run', 'run_background', 'job_output', 'job_list', 'job_kill'])
// Shell resolution/provisioning remains available, but duplicate ops_bash is retired.
export const IN_PROCESS_TOOLS = Object.freeze([])
export function publicToolName(rawName) { return `${TOOL_PREFIX}${rawName}` }
export const BASH_TOOL = publicToolName('bash')

/** Resolve the actual command capability, not the presence of a shell executable. */
export function ladderLevels({ published }) {
  const names = new Set(published)
  return {
    fastctx: FILE_TOOLS.some(name => names.has(publicToolName(name))),
    run: names.has(publicToolName('run')),
    bash: false,
    pwsh: false,
  }
}

/** A single compact table; absent tools never get advertised. */
export function renderToolingPolicy({ published, enableShellTools, mounted, levels, extraGuidance = '' }) {
  const names = new Set(published ?? (mounted || levels?.fastctx
    ? [...FILE_TOOLS, ...(enableShellTools ? SHELL_TOOLS : [])].map(publicToolName) : []))
  if (!FILE_TOOLS.some(name => names.has(publicToolName(name)))) return ''
  const lines = ['# Repository tools', '', '| Task | Tool |', '| --- | --- |']
  const row = (raw, task) => {
    if (names.has(publicToolName(raw))) lines.push(`| ${task} | ${publicToolName(raw)} |`)
  }
  row('inspect_local_file', 'Text / multiple ranges / encoding / PDF text / hex')
  lines.push('| Images | read_image (host) |')
  row('grep', 'Search contents')
  row('glob', 'Find paths')
  row('replace', 'Batch replacement; use host edit for precise edits')
  row('run', 'Commands (full access only)')
  if (names.has(publicToolName('run_background'))) {
    lines.push(`| Background commands / owned jobs | ${SHELL_TOOLS.slice(1).map(publicToolName).join(', ')} |`)
  }
  lines.push('', '- Do not build shell command lines for file operations.',
    '- On a tool error, correct the arguments and retry; do not switch to a shell workaround.')
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
