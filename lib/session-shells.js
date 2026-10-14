/** Plugin-owned bash layers; permission changes never mutate the shared registry. */
import { BASH_TOOL } from './policy.js'
import { bashToolDefinition } from './shells.js'
import { MODES, denied } from './permissions.js'
import { prepareWorkspace } from './workspace-preparation.js'
import { confinedBash } from './bash-ipc.js'

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
  let warnedNoProvider = false
  // Fail closed at publication: a RESTRICTED session may see ops_bash only while
  // the host can actually confine it. Without `ctx.sandbox.confine` this is
  // false, so the tool is never registered for that agent (and an inherited one
  // is masked below); a missing sandbox can never degrade into an unconfined
  // bash run. `danger-full-access` is the one mode that needs no provider,
  // because it is the mode whose contract is "no fencing".
  const allowed = agent => {
    if (!ready || stopped || !agent?.session) return false
    try {
      const policy = ctx.get('sandboxPolicy')?.resolve({ session: agent.session })
      return MODES.includes(policy?.mode) && (policy.mode === 'danger-full-access' || !!ctx.get('sandbox')?.confine)
    }
    catch { return false }
  }
  const clear = entry => {
    entry.dispose?.()
    entry.dispose = undefined
  }
  const reconcile = () => {
    for (const entry of entries.values()) clear(entry)
    // Say out loud why a restricted session has no bash: "not published" and
    // "published but unusable" look identical from the model's side, and an
    // operator whose host has no confinement provider needs the reason (once).
    if (!warnedNoProvider && ctx.get('sandbox')?.confine === undefined) {
      for (const agent of entries.keys()) {
        let mode
        try { mode = ctx.get('sandboxPolicy')?.resolve({ session: agent?.session })?.mode } catch { mode = undefined }
        if (!MODES.includes(mode) || mode === 'danger-full-access') continue
        warnedNoProvider = true
        ctx.logger?.warn?.('dsh-ops: the host confinement provider (ctx.sandbox.confine) is unavailable, '
          + 'so ops_bash is not published for restricted sessions and never runs unconfined.')
        break
      }
    }
    // Publish authorized ancestors before masking inheritance in restricted children.
    for (const [agent, entry] of entries) {
      if (!entry.ctx || !allowed(agent)) continue
      const definition = bashToolDefinition({ file: bash.file, source: bash.source, subprocess: ctx.get('subprocess') })
      definition.execute = async (args, exec) => {
        const session = exec?.agent?.session
        if (!session || !ready || stopped) throw new Error('Bash requires an authoritative DSH session and executor.')
        const policy = ctx.get('sandboxPolicy')?.resolve({ session })
        if (!MODES.includes(policy?.mode)) throw new Error('Invalid authoritative DSH permission mode.')
        let confinement
        // The private-runtime half of confinement is Windows-only: PortableGit
        // carries its own MSYS layer, so on win32 `confinedBash` builds the
        // verified IPC copy the host fences. Everywhere else the executable is
        // already the machine's own bash and `confinedBash` hands the file back
        // unchanged (`lib/bash-ipc.js`), because on Linux the fence belongs to
        // the host alone (`sandbox.confine`: landlock or bwrap, reported as
        // full/partial enforcement). A Linux run is therefore never
        // "unconfined because there is no MSYS layer" — the provider below is
        // required, and without it no command is started at all.
        const runtime = policy.mode === 'danger-full-access' ? { file: bash.file } : confinedBash(bash.file)
        // The host sandbox publishes its denial dialect in English, so a
        // confined command runs under a locale whose messages are English too.
        // Without it a localized shell reports a denial in its own language and
        // the host cannot tell a policy refusal from an ordinary command
        // failure. Scoped to Linux on purpose: `C.UTF-8` is a Linux locale, and
        // `bash-ipc` already hands a POSIX host's own bash through unchanged, so
        // this only decides how that host's shell words its errors.
        const locale = process.platform === 'linux' ? { LC_ALL: 'C.UTF-8' } : {}
        const definitionForCall = bashToolDefinition({ file: runtime.file, source: bash.source, env: { ...runtime.env, ...locale },
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
        const value = await definitionForCall.execute({ ...args, workdir: args?.workdir ?? session.header?.cwd }, exec)
        const text = `${value.stderr?.text ?? ''}\n${value.error ?? ''}`.toLowerCase()
        const runnerFailed = value.exitCode !== 0 && confinement?.runnerFailureRules?.some(rule =>
          (!rule.allowedExitCodes || rule.allowedExitCodes.includes(value.exitCode)) &&
          rule.fatalSignatures?.some(s => text.includes(s.toLowerCase())))
        if (runnerFailed || /couldn't create signal pipe|fatal error.*win32 error|sandbox_unavailable/.test(text)) {
          return { ...value, error: 'EXECUTOR_UNAVAILABLE: The bash runtime could not initialize under the DSH sandbox; the command did not run. This is not a user authorization denial. Do not retry or bypass confinement.' }
        }
        const refused = value.exitCode !== 0 && confinement?.denialSignatures?.some(s => text.includes(s.toLowerCase()))
        if (refused) {
          const permission = denied(policy, 'command file effects', policy.mode === 'read-only' ? 'workspace-write' : 'danger-full-access').error
          return { ...value, permission: { ...permission, phase: 'execute', effectState: 'unknown', nextAction: `${permission.nextAction} Inspect any earlier command effects before a new attempt.` } }
        }
        return { ...value, sandbox: { mode: policy.mode, ...(confinement ? { enforcement: confinement.enforcement } : {}) } }
      }
      try { entry.dispose = entry.ctx.tools.register(definition) }
      catch (error) { ctx.logger?.warn?.(`dsh-ops: bash publication failed: ${error.message}`) }
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
    const entry = { ctx: undefined, fiber: undefined, dispose: undefined }
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
    await Promise.all([...entries.keys()].map(detach))
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
