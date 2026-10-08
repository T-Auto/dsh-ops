/**
 * The model-facing policy this plugin injects, and the opt-in fence over the
 * host's own shell tools.
 *
 * The text is a model-facing contract: an explicit ladder of the code-execution
 * rungs this deployment can offer, each rung naming what it is for and the host
 * mechanism it replaces. It is written from the model's point of view and
 * contains no plugin or transport vocabulary.
 *
 * "Prefer" lives here and nowhere else. Which rungs exist is not this module's
 * decision either: every rung is read back from a fact the deployment can be
 * asked for — {@link ladderLevels} takes the published tool names for the
 * FastCtx and bash rungs, and the bundled PowerShell 7 being there for the one
 * rung whose executable the bundle patch acts on. The plugin never switches
 * rungs, retries on another tool, or cascades at run time.
 *
 * @module dsh-ops/policy
 */

/** Prompt section carrying the tooling policy. */
export const TOOLING_SECTION = 'dsh-ops:repository-tooling'

/** Prompt section carrying the host-shell rule on its own. */
export const HOST_SHELL_SECTION = 'dsh-ops:host-shell-policy'

/**
 * Section orders.
 *
 * The host owns named placements (`systemPrompt.getSectionOrder`), so these two
 * numbers are read back against its table: `host-shell-policy` sits at 1500,
 * the slot the first-party `TOOL_GREP` occupies, and `repository-tooling` at
 * 3250 — after the hosted server's own instructions (`MCP_SERVERS`, 3100) and
 * before the PTC SDK section (`TOOLS_SDK`, 5000). Both values are declared in
 * `dsh-plugin.json` as well, and the manifest gate compares them.
 */
export const SECTION_ORDERS = Object.freeze({
  [HOST_SHELL_SECTION]: 1500,
  [TOOLING_SECTION]: 3250,
})

/**
 * The prefix every tool this plugin publishes carries.
 *
 * The plugin holds the MCP connection to the FastCtx server it spawns and
 * publishes each of that server's tools under this namespace (`lib/tools.js`),
 * so the model calls `ops_grep` and a transcript shows `ops_grep`: neither the
 * server's own namespace nor the transport it is reached through ever appears
 * on the model-facing surface.
 */
export const TOOL_PREFIX = 'ops_'

/** The four FastCtx tools that are always published, in the order the model should reach for them. */
export const FILE_TOOLS = Object.freeze([
  'inspect_local_file',
  'grep',
  'glob',
  'replace',
])

/** The five FastCtx tools published with `--enable-shell`. */
export const SHELL_TOOLS = Object.freeze([
  'run',
  'run_background',
  'job_output',
  'job_list',
  'job_kill',
])

/**
 * The public name one FastCtx tool is published under.
 * @param {string} rawName - FastCtx's own tool name.
 * @returns {string} the model-facing name.
 */
export function publicToolName(rawName) {
  return `${TOOL_PREFIX}${rawName}`
}

/**
 * The raw names of the tools this plugin registers itself, without the public
 * prefix.
 *
 * They are not FastCtx tools: the plugin publishes them through its own
 * `ctx.tools.register` (`lib/shells.js`), so the manifest declares them in a
 * namespace of their own, and both the manifest gate and the manifest suite
 * read this list instead of writing the names out again.
 */
export const IN_PROCESS_TOOLS = Object.freeze(['bash'])

/**
 * The rung below FastCtx that runs POSIX commands.
 *
 * Published by `lib/shells.js` from the bash this plugin carries. It is the
 * rung's own tool, so a rung is live exactly when this name is in the registry:
 * resolving a bash is not enough, because publishing the tool also needs the
 * host's `subprocess` service.
 */
export const BASH_TOOL = publicToolName(IN_PROCESS_TOOLS[0])

/** The published names of this plugin's own tools, for telling them from FastCtx's. */
const IN_PROCESS_PUBLIC_NAMES = new Set(IN_PROCESS_TOOLS.map(publicToolName))

/**
 * One bullet naming a FastCtx tool, its purpose, and the host mechanism it replaces.
 * @param {string} rawName - FastCtx's own tool name.
 * @param {string} purpose - what the tool does.
 * @param {string} replaces - the mechanism the model must not use instead.
 * @returns {string} the bullet.
 */
function bullet(rawName, purpose, replaces) {
  return `- \`${publicToolName(rawName)}\` — ${purpose}. Do not use ${replaces} instead.`
}

/**
 * The code-execution rungs one deployment can actually offer.
 *
 * Rendering is driven by this: a rung the deployment cannot run is not
 * mentioned at all, because naming a tool the model cannot call is worse than
 * saying nothing. Every rung is a fact about the tools the model can call, not
 * about an executable that exists somewhere: {@link ladderLevels} derives them
 * from the live registry.
 * @typedef {object} LadderLevels
 * @property {boolean} fastctx - a FastCtx tool is published and connected.
 * @property {boolean} bash - the bash rung's own tool is published (its tool,
 *   not merely a resolved bash: the host's `subprocess` service has to be there
 *   for the tool to exist at all).
 * @property {boolean} pwsh - this plugin's PowerShell 7 is resolvable on this
 *   platform, which is the same fact the bundle patch's L3 override acts on.
 */

/**
 * The rungs to render, from what the model can actually call.
 *
 * The published names are read at every assembly, because a reconnect
 * republishes the whole FastCtx generation and the shell rungs are published
 * beside them. `resolveShells()` answers "which executable, by which route, and
 * why not" — detail and reporting — and deliberately does not decide whether a
 * rung exists: an executable that resolved but whose tool never got published
 * (no `subprocess` service, a registration conflict) is a rung the model cannot
 * reach.
 * @param {object} options - the resolution input.
 * @param {string[]} options.published - the published `ops_` tool names.
 * @param {boolean} options.pwsh - whether this plugin's PowerShell 7 resolved.
 * @returns {LadderLevels} the ladder to render.
 */
export function ladderLevels({ published, pwsh }) {
  const names = new Set(published)
  return {
    // The FastCtx rung is live when any published name is not one of this
    // plugin's own: the in-process tools must not stand in for a server that
    // is not there.
    fastctx: published.some((toolName) => !IN_PROCESS_PUBLIC_NAMES.has(toolName)),
    bash: names.has(BASH_TOOL),
    pwsh: pwsh === true,
  }
}

/**
 * Normalize the ladder input.
 *
 * `mounted` is the single-rung form callers used before the ladder existed: it
 * answers for the FastCtx rung alone and leaves the two bundled shells off, so
 * an older caller renders the policy it always did.
 * @param {LadderLevels|undefined} levels - the explicit ladder, when given.
 * @param {boolean|undefined} mounted - the FastCtx rung alone.
 * @returns {LadderLevels} the ladder to render.
 */
function ladderFor(levels, mounted) {
  if (levels === undefined || levels === null) {
    return { fastctx: mounted === true, bash: false, pwsh: false }
  }
  return {
    fastctx: levels.fastctx === true,
    bash: levels.bash === true,
    pwsh: levels.pwsh === true,
  }
}

/**
 * The tooling policy text.
 *
 * Returns an empty string while the FastCtx server is not mounted: naming tools
 * the model cannot call is worse than saying nothing. Every rung above it is
 * listed in the order to reach for it, and only the rungs this deployment can
 * run are listed.
 * @param {object} options - rendering inputs.
 * @param {boolean} options.enableShellTools - whether FastCtx's shell tools are published.
 * @param {boolean} [options.mounted] - whether the MCP server is connected (the FastCtx rung only).
 * @param {string} [options.extraGuidance] - deployment-specific text appended verbatim.
 * @param {LadderLevels} [options.levels] - the rungs this deployment can offer.
 * @returns {string} the section text.
 */
export function renderToolingPolicy({ enableShellTools, mounted, extraGuidance = '', levels }) {
  const rungs = ladderFor(levels, mounted)
  if (!rungs.fastctx) return ''

  /** Whether the session carries a shell of its own below FastCtx. */
  const bundled = rungs.bash || rungs.pwsh

  const lines = [
    '# Repository tools: the command-execution ladder',
    '',
    'Repository work runs through the rungs below, in the order they are given. Use the first rung '
    + 'that can do the job and stay on it; choosing between them is your decision, and nothing '
    + 'switches rungs for you.',
    '',
    '## Rung 1 — FastCtx (`' + TOOL_PREFIX + '*`): repository reading, searching, listing, '
    + 'replacing, and commands',
    '',
    'This session performs repository work through FastCtx, a local runtime that is already '
    + 'running behind the tools below. It is not a convenience: the shell is the wrong instrument '
    + 'for these operations, and reaching for it produces quoting, escaping, path, encoding and '
    + 'truncation failures that these tools remove.',
    '',
    bullet('inspect_local_file', 'read a file, an image, a PDF, or a raw byte range, '
      + 'with 1-based line numbers and paging', 'a shell command that prints a file'),
    bullet('grep', 'search file contents with the ripgrep engine, across a file or a '
      + 'directory tree', 'PowerShell `Select-String`, `findstr`, or a shell `rg`/`grep`'),
    bullet('glob', 'find files by path pattern', 'PowerShell `Get-ChildItem`, or a shell '
      + '`dir`/`ls`/`find`'),
    bullet('replace', 'apply one mechanical replacement across files', 'PowerShell '
      + '`-replace`, or a shell `sed`/`perl`'),
  ]

  if (enableShellTools) {
    lines.push(
      '',
      'To execute a command — a build, a test run, version control, a formatter — use FastCtx as '
      + 'well. `' + publicToolName('run') + '` runs a command in a bash shell and returns '
      + 'its exit status; `' + publicToolName('run_background') + '` starts a long-running '
      + 'job; `' + publicToolName('job_output') + '`, `'
      + publicToolName('job_list') + '` and `' + publicToolName('job_kill')
      + '` manage those jobs. Do not reach for a host shell tool to run a command.',
    )
  }

  // Rungs are numbered in render order, so the sequence the model reads has no
  // gaps when this deployment cannot run one of the bundled shells.
  const bashRung = 2
  const pwshRung = bashRung + (rungs.bash ? 1 : 0)
  const hostRung = pwshRung + (rungs.pwsh ? 1 : 0)

  if (rungs.bash) {
    lines.push(
      '',
      `## Rung ${bashRung} — \`${BASH_TOOL}\`: the bundled bash, for POSIX pipelines and scripts`,
      '',
      `When FastCtx cannot express the operation — a POSIX pipeline, a shell script, or a \`git\` or `
      + `\`gh\` invocation the tool surface does not cover — run it with \`${BASH_TOOL}\`, the bash `
      + 'bundled with this session, instead of asking FastCtx to approximate it. It runs one '
      + 'command in a fresh, non-interactive process: pass the working directory explicitly '
      + 'whenever the command must not run in the session directory.',
    )
  }

  if (rungs.pwsh) {
    lines.push(
      '',
      `## Rung ${pwshRung} — PowerShell 7: Windows-native work`,
      '',
      'When the task is Windows-native — a cmdlet, `$env:`, a registry or service operation, a '
      + 'native path — use the PowerShell 7 bundled with this session rather than wrapping the '
      + 'work in a POSIX command.',
    )
  }

  lines.push(
    '',
    `## Rung ${hostRung} — the host's own shell tools: last resort`,
    '',
    bundled
      ? 'Use the host\'s own shell tools only for an operation none of the rungs above can run. '
        + 'They are not the repository interface of this session: reading, searching, listing, and '
        + 'replacing files still belong to the FastCtx tools.'
      : 'The host\'s own shell tools are the last resort, for an operation FastCtx cannot express. '
        + 'They are not the repository interface of this session: reading, searching, listing, and '
        + 'replacing files still belong to the FastCtx tools.',
  )

  lines.push(
    '',
    'Rules that hold for every step of the task:',
    '',
    '- Read, search, list, and replace files with the FastCtx tools above — never by building a '
    + 'PowerShell or bash command line for it, and never by piping one through a shell.',
    '- Pass a plain absolute filesystem path. A `file://` URI or any other URI form is not a path.',
    '- When a FastCtx tool returns an error, correct its arguments and call it again. Do not switch '
    + 'to a shell command to work around the error, and do not retry the identical call.',
    '- Paging is explicit: read a tool\'s final status line for the continuation parameters of the '
    + 'next call instead of guessing offsets.',
    '- Tool output is already bounded and marked. Never re-read a file to "double-check" what a tool '
    + 'just returned.',
  )

  if (extraGuidance.trim() !== '') {
    lines.push('', extraGuidance.trim())
  }
  return lines.join('\n')
}

/**
 * The host-shell rule on its own, so the deployment keeps the prohibition even
 * while the FastCtx server is unavailable.
 * @returns {string} the section text.
 */
export function renderHostShellPolicy() {
  return [
    '# Host shell restriction',
    '',
    'The host shell tools are not the repository interface of this session. Reading, searching, '
    + 'listing, and replacing files belongs to the FastCtx tools '
    + `(\`${publicToolName('inspect_local_file')}\`, \`${publicToolName('grep')}\`, `
    + `\`${publicToolName('glob')}\`, \`${publicToolName('replace')}\`), and `
    + 'command execution belongs to FastCtx as well.',
    '',
    'Do not construct a PowerShell command for repository work. If FastCtx is unavailable, report '
    + 'that instead of substituting a shell command for it.',
  ].join('\n')
}

/**
 * Whether `shellPolicy: deny-host-shell` may hide the host shell tools.
 *
 * Hiding is the weaker mechanism, so it is preferred — but only while this
 * deployment still offers a shell rung of its own. The question is asked of the
 * ladder the model can actually reach ({@link ladderLevels}), not of a resolved
 * executable: hiding the host shell while no rung of ours is published would
 * take away the last shell the model could run a command in, so the mode leaves
 * visibility alone and reports `reason` once.
 *
 * The `tools/pre-execute` fence is the policy's own runtime behavior and is
 * installed with the mode; it does not depend on this decision.
 * @param {object} options - the decision input.
 * @param {'advise'|'deny-host-shell'} options.shellPolicy - the configured treatment.
 * @param {LadderLevels} options.levels - the rungs this deployment offers.
 * @returns {{hide: boolean, reason: string|undefined}} the decision.
 */
export function hostShellEnforcement({ shellPolicy, levels }) {
  if (shellPolicy !== 'deny-host-shell') return { hide: false, reason: undefined }
  if (levels?.bash === true || levels?.pwsh === true) return { hide: true, reason: undefined }
  return {
    hide: false,
    reason: 'shellPolicy is "deny-host-shell", but this deployment offers no shell rung of its own '
      + '(the bash rung\'s tool is not published and the PowerShell 7 rung is not live), so the host '
      + 'shell tools stay visible: hiding the last shell the model could run a command in would '
      + 'leave the session with no way to execute anything. The tools/pre-execute fence is still in '
      + 'force.',
  }
}

/**
 * Whether the host-shell fence refuses one tool call.
 * @param {object} options - the decision input.
 * @param {string} options.toolName - the name the model called.
 * @param {ReadonlySet<string>} options.denied - the refused names.
 * @returns {{kind: 'deny', reason: string}|undefined} the refusal, or undefined to delegate.
 */
export function hostShellRefusal({ toolName, denied }) {
  if (!denied.has(toolName)) return undefined
  return {
    kind: 'deny',
    reason: `\`${toolName}\` is disabled in this session by the dsh-ops plugin. Repository work `
      + `runs through FastCtx: \`${publicToolName('inspect_local_file')}\` to read, `
      + `\`${publicToolName('grep')}\` to search, \`${publicToolName('glob')}\` to `
      + `find files, \`${publicToolName('replace')}\` to replace, and `
      + `\`${publicToolName('run')}\` to execute a command. Retry the operation with those `
      + 'tools.',
  }
}
