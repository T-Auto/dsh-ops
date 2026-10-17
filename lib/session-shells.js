/** Plugin-owned bash layers; permission changes never mutate the shared registry. */
import path from 'node:path'
import { BASH_TOOL } from './policy.js'
import { bashToolDefinition, withBashStatus } from './shells.js'
import { MODES, denied } from './permissions.js'
import { prepareWorkspace } from './workspace-preparation.js'
import { confinedBash } from './bash-ipc.js'

/**
 * The workdir one session bash call runs in. Adapter placeholders for an unset
 * optional string are "" or whitespace, not a directory to run in: they fall
 * back to the session directory like an omitted value. Relative directories
 * are anchored there before the executor checks them, never at process.cwd().
 * @param {object} args - the tool call arguments.
 * @param {object} session - the authoritative DSH session.
 * @returns {string|undefined} the absolute workdir, or the session directory.
 */
export function sessionWorkdir(args, session) {
  const raw = args?.workdir
  const explicit = typeof raw === 'string' && raw.trim() === '' ? undefined : raw
  const cwd = session?.header?.cwd
  if (explicit == null) return cwd
  // Leave invalid types to the executor's parameter validation; never coerce them.
  if (typeof explicit !== 'string') return explicit
  // On Windows, \child is rooted but still needs the session's drive.
  const driveRooted = path.sep === '\\' && path.parse(explicit).root === '\\'
  if (path.isAbsolute(explicit) && !driveRooted) return explicit
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)
    || (path.sep === '\\' && path.parse(cwd).root === '\\')) {
    throw new Error('invalid workdir: resolving a relative path requires an absolute session workspace')
  }
  // A different drive's relative cwd would come from process state, not this session.
  if (path.sep === '\\' && /^[a-z]:/i.test(explicit) && explicit.slice(0, 2).toLowerCase() !== cwd.slice(0, 2).toLowerCase()) {
    throw new Error('invalid workdir: a drive-relative path on another drive requires an absolute path')
  }
  return path.resolve(cwd, explicit)
}

export function mountSessionBash(ctx, config, shells) {
  if (!config.publishBashTool) return
  const bash = shells.bash
  if (!bash.available) {
    ctx.logger?.warn?.(`dsh-ops: bash unavailable: ${bash.detail}`)
    return
  }
  const entries = new Map()
  let ready = false
  let stopped = false
  const allowed = agent => {
    if (!ready || stopped || !agent?.session) return false
    try {
      const policy = ctx.get('sandboxPolicy')?.resolve({ session: agent.session })
      return MODES.includes(policy?.mode) && (policy.mode === 'danger-full-access' || !!ctx.get('sandbox')?.confine)
    }
    catch { return false }
  }
  const clear = entry => {
    // One broken teardown must not strand the rest: `reconcile()` clears every entry before
    // republishing, so an exception escaping here stops the loop at the first entry and leaves the
    // later sessions without a bash tool. Log it — a silently swallowed dispose failure would hide
    // a real leak.
    try {
      entry.dispose?.()
    } catch (error) {
      ctx.logger?.warn?.(`dsh-ops: bash tool teardown failed; continuing with the remaining sessions: ${error?.message ?? error}`)
    } finally {
      entry.dispose = undefined
    }
  }
  const publish = (entry, definition) => {
    // A failed publication must leave the session with the definition that last worked rather than
    // with no bash tool at all (#30). `entry.definition` survives `clear()`, so it holds the last
    // definition registered successfully for this entry.
    try {
      entry.dispose = entry.ctx.tools.register(definition)
      entry.definition = definition
    } catch (error) {
      ctx.logger?.warn?.(`dsh-ops: bash publication failed: ${error.message}`)
      if (entry.definition === undefined) return
      try { entry.dispose = entry.ctx.tools.register(entry.definition) }
      catch (restoreError) { ctx.logger?.warn?.(`dsh-ops: bash restoration failed: ${restoreError.message}`) }
    }
  }
  const reconcile = () => {
    for (const entry of entries.values()) clear(entry)
    // Publish authorized ancestors before masking inheritance in restricted children.
    for (const [agent, entry] of entries) {
      if (!entry.ctx || !allowed(agent)) continue
      const definition = bashToolDefinition({ file: bash.file, source: bash.source, subprocess: ctx.get('subprocess') })
      const run = async (args, exec) => {
        const session = exec?.agent?.session
        if (!session || !ready || stopped) throw new Error('Bash requires an authoritative DSH session and executor.')
        const policy = ctx.get('sandboxPolicy')?.resolve({ session })
        if (!MODES.includes(policy?.mode)) throw new Error('Invalid authoritative DSH permission mode.')
        let confinement
        const runtime = policy.mode === 'danger-full-access' ? { file: bash.file } : confinedBash(bash.file, { source: bash.source })
        const definitionForCall = bashToolDefinition({ file: runtime.file, source: bash.source, env: runtime.env,
          prepareArgv: async (argv, signal) => {
            await prepareWorkspace(policy)
            if (policy.mode !== 'danger-full-access') {
              const sandbox = ctx.get('sandbox')
              if (!sandbox?.confine) throw new Error('SANDBOX_UNAVAILABLE: DSH confinement provider is unavailable; no command executed.')
              confinement = await sandbox.confine(argv, policy, signal)
              if (!['full', 'partial'].includes(confinement?.enforcement) || !confinement.argv?.length) throw new Error('SANDBOX_UNAVAILABLE: invalid DSH confinement result.')
            }
            const current = ctx.get('sandboxPolicy').resolve({ session })
            if (current.mode !== policy.mode || current.workspaceRoot !== policy.workspaceRoot) throw new Error('DSH permissions changed before execution; no command was started.')
            return confinement?.argv ?? argv
          }, subprocess: ctx.get('subprocess'),
        })
        const value = await definitionForCall.execute({ ...args, workdir: sessionWorkdir(args, session) }, exec)
        const text = `${value.stderr?.text ?? ''}\n${value.error ?? ''}`.toLowerCase()
        const runnerFailed = value.exitCode !== 0 && confinement?.runnerFailureRules?.some(rule =>
          (!rule.allowedExitCodes || rule.allowedExitCodes.includes(value.exitCode)) &&
          rule.fatalSignatures?.some(s => text.includes(s.toLowerCase())))
        if (runnerFailed || /couldn't create signal pipe|fatal error.*win32 error|sandbox_unavailable/.test(text)) {
          return { ...value, error: 'EXECUTOR_UNAVAILABLE: The bash runtime could not initialize under the DSH sandbox; the command did not run. This is not a user authorization denial. Do not retry or bypass confinement. If this command is needed now, ask the user to switch the session to danger-full-access; ops_bash has no per-call sandbox_permissions escalation.' }
        }
        const refused = value.exitCode !== 0 && confinement?.denialSignatures?.some(s => text.includes(s.toLowerCase()))
        if (refused) {
          const permission = denied(policy, 'command file effects', policy.mode === 'read-only' ? 'workspace-write' : 'danger-full-access').error
          return { ...value, permission: { ...permission, phase: 'execute', effectState: 'unknown', nextAction: `${permission.nextAction} Inspect any earlier command effects before a new attempt.` } }
        }
        return { ...value, sandbox: { mode: policy.mode, ...(confinement ? { enforcement: confinement.enforcement } : {}) } }
      }
      // Stamp status after every wrapper above, so an added error/permission always reads as failed (#44).
      definition.execute = async (args, exec) => withBashStatus(await run(args, exec))
      publish(entry, definition)
    }
    for (const [agent, entry] of entries) {
      if (!entry.ctx || allowed(agent) || stopped) continue
      if ((ctx.get('tools').schemas(agent) ?? []).some(tool => tool.name === BASH_TOOL)) {
        try { entry.dispose = entry.ctx.tools.restrict({ deny: [BASH_TOOL] }) }
        catch (error) { ctx.logger?.warn?.(`dsh-ops: inherited bash restriction failed: ${error.message}`) }
      }
    }
  }
  const attach = agent => {
    if (stopped || !agent?.ctx || entries.has(agent)) return
    const entry = { ctx: undefined, fiber: undefined, dispose: undefined, definition: undefined }
    entries.set(agent, entry)
    entry.fiber = agent.ctx.plugin(child => {
      child.inject(['tools'], toolsCtx => {
        entry.ctx = toolsCtx
        reconcile()
      })
    })
  }
  const detach = agent => {
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
  ctx.on('agent/created', ({ agent }) => attach(agent))
  ctx.on('agent/disposed', ({ agent }) => detach(agent))
  ctx.on('session/event', (_session, event) => { if (event.type === 'sandbox/mode') reconcile() })
  ctx.inject(['sandbox'], () => { reconcile() })
  ctx.inject(['sandboxPolicy', 'subprocess'], authorityCtx => {
    ready = true
    reconcile()
    authorityCtx.effect(() => () => { ready = false; reconcile() }, 'dsh-ops: bash authority and executor')
  })
  for (const agent of ctx.get('agents')?.list?.() ?? []) attach(agent)
}
