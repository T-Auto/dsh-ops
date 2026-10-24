/** Plugin-owned bash layers; permission changes never mutate the shared registry. */
import path from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ResolvedConfig } from './config.js'
import type { ShellResolution } from './shells/paths.js'
import type { HostShellDefinition, ShellJobs, ShellResult } from './shells/types.js'
import { errorMessage } from './shells/types.js'
import { BASH_TOOL } from './policy.js'
import { bashToolDefinition, DEFAULT_BASH_TIMEOUT_MS } from './shells.js'
import { BashArgumentError } from './shells/argument-error.js'
import { MODES } from './permissions.js'
import { hostBashDefinition } from './shells/host-tool.js'
import { withToolChange } from './tool-changes.js'
import { startSessionBash } from './shells/session-execution.js'

/**
 * Whether a session workspace is written in a Windows form.
 *
 * The flavour comes from the workspace itself, not from `process.platform`: a
 * Windows session must be resolved with Windows rules even when this helper runs
 * on another host (the same reason `lib/shells/paths.js` probes foreign layouts
 * with `path.win32`), and a POSIX workspace must never borrow a drive's ambient
 * current directory. A drive-absolute (`C:\ws`) or UNC (`\\server\share`) root
 * is unambiguous; everything else is POSIX.
 * @param {unknown} cwd - the session workspace.
 * @returns {boolean} whether Windows path rules apply.
 */
function windowsFlavoured(cwd: unknown) {
  return typeof cwd === 'string' && (/^[A-Za-z]:[\\/]/.test(cwd) || (cwd[0] === '\\' && cwd[1] === '\\'))
}

/**
 * The workdir one session bash call runs in. Adapter placeholders for an unset
 * optional string are "" or whitespace, not a directory to run in: they fall
 * back to the session directory like an omitted value instead of failing the
 * spawn (the executor rejects paths that do not exist).
 *
 * A relative workdir is anchored at `session.header.cwd`, never at the helper
 * process's own cwd: that process belongs to the plugin host, and a caller's `.`
 * means the calling session's workspace (#180, #204 P3). Absolute paths are
 * returned unchanged, and a non-string still reaches the executor's own
 * validation rather than being coerced to the default. On Windows a
 * drive-relative path (`C:child`) is anchored at the session's drive when the
 * drives match and refused when they do not, because resolving it would consult
 * that drive's process-wide current directory — state a session does not own.
 *
 * A POSIX-style absolute workdir on a Windows session (#318) follows bash's own
 * spelling, which writes `/d/…` for `D:\…`: the drive-letter form is mapped
 * onto the Windows form and then anchored and validated like any other
 * absolute path, while a drive-less POSIX absolute (`/`, `/tmp/x`) is refused
 * outright — Windows would read it against the helper process's current drive,
 * the exact ambient base the anchoring here exists to remove, and where a decoy
 * directory made the command run in the wrong tree with exit 0.
 * @param {object} args - the tool call arguments.
 * @param {object} session - the authoritative DSH session.
 * @returns {string|undefined} the absolute workdir, or the session directory.
 * @throws {BashArgumentError} when a relative path has no absolute session workspace to anchor at,
 *   names a drive other than the session's, or is a drive-less POSIX absolute path on Windows.
 */
export function sessionWorkdir(args: { workdir?: unknown } | null | undefined, session: { header?: { cwd?: string } } | undefined) {
  const raw = args?.workdir
  const explicit = typeof raw === 'string' && raw.trim() === '' ? undefined : raw
  const cwd = session?.header?.cwd
  if (explicit === undefined || explicit === null) return cwd
  if (typeof explicit !== 'string') return explicit
  const win = windowsFlavoured(cwd)
  const p = win ? path.win32 : path.posix
  let candidate = explicit
  // A `/`-rooted path's `parse().root` is `'/'`, not `'\\'`, so the
  // `driveRooted` escape below lets `/d/…` through untouched and Node's `fs`
  // later reads it against the helper process's current drive (#318).
  // `//server/share` keeps its existing forward-slash UNC passthrough. The
  // flavour comes from the session workspace's own spelling: a POSIX-spelled
  // workspace on a Windows host keeps POSIX rules by design — pinned by the
  // POSIX-session test, not guessed at from `process.platform`.
  if (win && candidate.startsWith('/') && !candidate.startsWith('//')) {
    const driveForm = /^\/([A-Za-z])(?:\/(.*))?$/.exec(candidate)
    if (driveForm === null) {
      throw new BashArgumentError('invalid workdir: '
        + `${JSON.stringify(candidate)} starts with "/" but carries no usable drive letter; `
        + 'Windows would read it against the host process\'s current drive. '
        + 'Write it as "D:/path" or "/d/path", or cd to it inside the command.', 'workdir')
    }
    candidate = `${driveForm[1].toUpperCase()}:\\${(driveForm[2] ?? '').replaceAll('/', '\\')}`
  }
  // On Windows, `\child` is rooted but still needs the session's drive.
  const driveRooted = win && path.win32.parse(candidate).root === '\\'
  if (p.isAbsolute(candidate) && !driveRooted) return candidate
  if (typeof cwd !== 'string' || !p.isAbsolute(cwd) || (win && path.win32.parse(cwd).root === '\\')) {
    throw new BashArgumentError('invalid workdir: resolving the relative path '
      + `${JSON.stringify(candidate)} needs an absolute session workspace, but the session reported `
      + `${JSON.stringify(cwd ?? null)}; pass an absolute workdir instead.`, 'workdir')
  }
  const drive = win ? /^([A-Za-z]):/.exec(candidate) : null
  if (drive !== null) {
    const sessionDrive = /^([A-Za-z]):/.exec(cwd)
    if (sessionDrive === null || sessionDrive[1].toLowerCase() !== drive[1].toLowerCase()) {
      throw new BashArgumentError('invalid workdir: the drive-relative path '
        + `${JSON.stringify(candidate)} names drive ${drive[1].toUpperCase()}:, but the session workspace is on `
        + `${sessionDrive === null ? 'no drive' : `${sessionDrive[1].toUpperCase()}:`}; `
        + 'write it as an absolute path instead of relying on another drive\'s current directory.', 'workdir')
    }
    // The drive matches: resolve against the session workspace, never `C:`'s own cwd.
    return p.resolve(cwd, candidate.slice(2))
  }
  return p.resolve(cwd, candidate)
}

/**
 * The canonical value one refusing bash layer settles on.
 *
 * It is a complete `BASH_OUTPUT_SCHEMA` value rather than a bare `{ error }`.
 * The host validates every returned value against the schema this tool registers
 * (`ToolRuntime.createSuccessResult` → `validateJsonSchemaValue`) and throws
 * `ToolOutputError` — "returned invalid output" — for a value missing
 * `timedOut`/`timeoutMs`/`stdout`/`stderr`, which is exactly how a real failure's
 * cause was lost (#235).
 * @param {unknown} error - the failure the executor raised.
 * @returns {object} the settled value, still to be stamped with `status`.
 */
export function bashRefusalValue(error: unknown): ShellResult {
  return {
    error: errorMessage(error),
    timedOut: false,
    timeoutMs: DEFAULT_BASH_TIMEOUT_MS,
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false },
  }
}

interface Entry {
  agent: Agent; ctx?: Context; fiber?: Fiber; dispose?: () => void; definition?: HostShellDefinition
  published?: boolean; generation?: number
}

export function mountSessionBash(ctx: Context, config: Pick<ResolvedConfig, 'publishBashTool'>, shells: { bash: ShellResolution }) {
  if (!config.publishBashTool) return
  const bash = shells.bash
  if (!bash.available) {
    ctx.logger?.warn?.(`dsh-ops: bash unavailable: ${bash.detail}`)
    return
  }
  const entries = new Map<Agent, Entry>()
  let ready = false
  let stopped = false
  let generation = 0
  // Bound once by the jobs injection below; the host's registry is a tracked service, so every
  // `ctx.get('jobs')` hands out a fresh traceable proxy and cannot be compared by identity.
  let jobs: ShellJobs | undefined
  const allowed = (agent: Agent) => {
    if (!ready || stopped || !agent?.session) return false
    try {
      const policy = ctx.get('sandboxPolicy')?.resolve({ session: agent.session })
      return policy !== undefined && MODES.includes(policy.mode) && (policy.mode === 'danger-full-access' || !!ctx.get('sandbox')?.confine)
    }
    catch { return false }
  }
  const clear = (entry: Entry) => {
    // Keep cleanup isolated: one failed layer must not strand other sessions.
    try {
      withToolChange([entry.agent], () => entry.dispose?.())
    } catch (error) {
      ctx.logger?.warn?.(`dsh-ops: bash tool teardown failed; continuing with the remaining sessions: ${errorMessage(error)}`)
    } finally {
      entry.dispose = undefined
      entry.published = undefined
      entry.generation = undefined
    }
  }
  const publish = (entry: Entry, definition: HostShellDefinition) => {
    if (!entry.ctx) return
    // A failed publication must leave the session with the definition that last worked rather than
    // with no bash tool at all (#30). `entry.definition` survives `clear()`, so it holds the last
    // definition registered successfully for this entry.
    try {
      entry.dispose = withToolChange([entry.agent], () => entry.ctx!.tools.register(definition))
      entry.definition = definition
    } catch (error) {
      ctx.logger?.warn?.(`dsh-ops: bash publication failed: ${errorMessage(error)}`)
      if (entry.definition === undefined) return
      try { entry.dispose = withToolChange([entry.agent], () => entry.ctx!.tools.register(entry.definition!)) }
      catch (restoreError) { ctx.logger?.warn?.(`dsh-ops: bash restoration failed: ${errorMessage(restoreError)}`) }
    }
  }
  const reconcile = (refreshDefinitions = false) => {
    if (refreshDefinitions) ++generation
    // Resolve live authority cheaply, but never withdraw an unrelated, unchanged layer.
    // Publish ancestors before adding masks, so a newly available parent is also hidden
    // from already tracked restricted children. Existing masks remain authoritative.
    const permitted = new Map([...entries].map(([agent]) => [agent, allowed(agent)]))
    for (const [agent, entry] of entries) {
      if (!entry.ctx) continue
      const publishable = permitted.get(agent) === true
      if (entry.dispose && entry.published === publishable && (!publishable || entry.generation === generation)) continue
      clear(entry)
      if (!publishable) continue
      const base = bashToolDefinition({ file: bash.file, source: bash.source, subprocess: ctx.get('subprocess') })
      const definition = hostBashDefinition(ctx, base,
        (args, exec, standing, policy, dshEnv, options) => startSessionBash({ ctx, bash, active: () => ready && !stopped && exec.agent !== undefined && entries.has(exec.agent) },
          args, exec, standing, policy, dshEnv, options), sessionWorkdir, jobs)
      publish(entry, definition)
      if (entry.dispose) { entry.published = true; entry.generation = generation }
    }
    for (const [agent, entry] of entries) {
      if (!entry.ctx || permitted.get(agent) || stopped || entry.dispose) continue
      if (ctx.get('tools')?.get(BASH_TOOL, agent)) {
        try { entry.dispose = withToolChange([agent], () => entry.ctx!.tools.restrict({ deny: [BASH_TOOL] })); entry.published = false }
        catch (error) { ctx.logger?.warn?.(`dsh-ops: inherited bash restriction failed: ${errorMessage(error)}`) }
      }
    }
  }
  const attach = (agent: Agent) => {
    if (stopped || !agent?.ctx || entries.has(agent)) return
    const entry: Entry = { agent, ctx: undefined, fiber: undefined, dispose: undefined, definition: undefined }
    entries.set(agent, entry)
    entry.fiber = agent.ctx.plugin(child => {
      child.inject(['tools'], toolsCtx => {
        entry.ctx = toolsCtx
        reconcile()
      })
    })
  }
  const detach = (agent: Agent) => {
    const entry = entries.get(agent)
    if (!entry) return
    entries.delete(agent)
    clear(entry)
    reconcile()
    return entry.fiber?.dispose()
  }
  ctx.effect(() => async () => {
    stopped = true
    // allSettled: one failing detach must not leave the remaining sessions' bash layers published.
    await Promise.allSettled([...entries.keys()].map(detach))
  }, 'dsh-ops: session bash layers')
  ctx.on('agent/created', ({ agent }) => { attach(agent) })
  ctx.on('agent/disposed', ({ agent }) => detach(agent))
  ctx.on('session/event', (_session, event) => { if (event.type === 'sandbox/mode') reconcile() })
  ctx.inject(['sandbox'], () => { reconcile() })
  ctx.inject(['jobs'], jobsCtx => {
    jobs = jobsCtx.get('jobs') as ShellJobs | undefined
    reconcile(true)
    jobsCtx.effect(() => () => { jobs = undefined; reconcile(true) })
  })
  ctx.inject(['sandboxPolicy', 'subprocess'], authorityCtx => {
    ready = true
    reconcile(true)
    authorityCtx.effect(() => () => { ready = false; reconcile() }, 'dsh-ops: bash authority and executor')
  })
  for (const agent of ctx.get('agents')?.list?.() ?? []) attach(agent)
}
