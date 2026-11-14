/** Operator runtime plans: fixed actions, one-use previews, serialized execution. */
import { randomUUID, createHash } from 'node:crypto'
import path from 'node:path'
import type { TypertGatewayBinding } from '../adapter/dsh/types.js'
import { NIUBASH_HOME_PATH, NIUBASH_PIN } from '../cli/niubash-payload.js'
import { MODE_IDS } from '../presets/types.js'
import { resolveModeConfig } from '../presets/config.js'
import { PACKAGE_ROOT, dshHome } from '../paths.js'
import { resolveShells } from '../shells.js'
import { bashEngine, gitBashCandidates, managedBashInventory, removeManagedBash, selectBashRuntime } from '../shells/manager.js'
import { hostPwshUpgradePlan, upgradeHostPwsh, hostPwshVersion } from '../shells/pwsh-upgrade.js'
import { companionVersion } from './companion.js'
import { effectiveMode, resolveMergedConfig } from './merged.js'
import type { UpgradeProcessResult } from '../shells/pwsh-upgrade.js'
import { parseAction, parseSelection } from './runtime-contract.js'
import type { DefaultPresetResult, RuntimeAction, RuntimePlan, RuntimeResult, RuntimeSnapshot, RuntimeSelection, RuntimeSelectionRequest,
  BashResolutionView, BashSourceKind, ModeBashView } from './runtime-contract.js'

export type RuntimeProcessRunner = (argv: readonly string[], signal: AbortSignal) => Promise<UpgradeProcessResult>
export interface RuntimeActionOptions {
  run: RuntimeProcessRunner
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  arch?: string
  now?: () => number
  /** The composed row configuration the mounted fiber owns, for the shell resolutions. */
  config?: () => unknown
  /** The one-shot default-preset action; absent when the preset is not registered. */
  applyDefaultPreset?: () => Promise<DefaultPresetResult>
}
type Preview = Omit<RuntimePlan, 'id'>
const failure = (status: RuntimeResult['status'], message: string, effectState: RuntimeResult['effectState'] = 'none'): RuntimeResult => ({ status, message, effectState })
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export class RuntimeActions {
  readonly typertRemote: TypertGatewayBinding<this> = Object.freeze({ service: this, serviceKey: 'opsSettings', namespace: 'opsSettings' })
  private readonly options: Required<Omit<RuntimeActionOptions, 'run' | 'config' | 'applyDefaultPreset'>>
    & Pick<RuntimeActionOptions, 'run' | 'config' | 'applyDefaultPreset'>
  private readonly plans = new Map<string, { action: RuntimeAction; fingerprint: string; expires: number }>()
  private readonly lifetime = new AbortController()
  private busy = false
  private readonly active = new Set<Promise<RuntimeResult>>()
  constructor(options: RuntimeActionOptions) {
    this.options = { env: process.env, platform: process.platform, arch: process.arch, now: Date.now, ...options }
  }
  snapshot(): RuntimeSnapshot {
    const powerShell = hostPwshUpgradePlan(this.options)
    const modes = this.modeViews()
    const running = modes.filter(mode => mode.enabled && mode.publishesBash)
    const signatures = new Set(running.map(mode => `${mode.engine}|${mode.source}|${mode.file ?? ''}|${mode.available}`))
    // Only an unambiguous answer may be called "the executor": a deployment whose
    // modes disagree reports each of them instead of picking a favourite.
    const uniform = signatures.size === 1 ? running[0] : undefined
    const bash: BashResolutionView | undefined = uniform === undefined ? undefined
      : { available: uniform.available, source: uniform.source, engine: uniform.engine, detail: uniform.detail,
        ...(uniform.file === undefined ? {} : { file: uniform.file }) }
    return { platform: this.options.platform, ...(bash === undefined ? {} : { bash }), modes,
      git: gitBashCandidates(this.options), managed: managedBashInventory(this.options),
      ...(companionVersion(this.options) === undefined ? {} : { companion: companionVersion(this.options) }),
      powerShell: { supported: powerShell.supported, guidance: powerShell.guidance,
        ...(powerShell.unavailable ? { unavailable: powerShell.unavailable } : {}),
        ...(hostPwshVersion(this.options) === undefined ? {} : { version: hostPwshVersion(this.options) }) } }
  }
  /**
   * Every mode's own resolution, resolved from the same row config the fiber mounted.
   * A mode that cannot be resolved reports why instead of borrowing another's answer.
   * @returns one view per built-in mode, in page order.
   */
  private modeViews(): ModeBashView[] {
    let merged
    try { merged = resolveMergedConfig(this.options.config?.()) } catch { merged = resolveMergedConfig({}) }
    const linked = typeof merged.other.raw?.pwsh7Link === 'boolean' ? merged.other.raw.pwsh7Link
      : companionVersion({ sweep: false }) !== undefined
    return MODE_IDS.map(id => {
      const state = merged[id]
      try {
        const effective = resolveModeConfig(effectiveMode(state, merged.global, linked), id)
        const resolved = resolveShells(effective, this.options).bash
        return { id, enabled: state.enabled, publishesBash: effective.bash !== false,
          available: resolved.available, source: resolved.source as BashSourceKind, engine: bashEngine(resolved.file),
          detail: resolved.detail, ...(resolved.file === undefined ? {} : { file: resolved.file }) }
      } catch (error) {
        return { id, enabled: state.enabled, publishesBash: true, available: false, source: 'missing',
          engine: 'none', detail: error instanceof Error ? error.message : String(error) }
      }
    })
  }
  select(request: RuntimeSelectionRequest): RuntimeSelection {
    const parsed = parseSelection(request)
    return selectBashRuntime(parsed.source, { ...this.options, ...(parsed.path === undefined ? {} : { path: parsed.path }) })
  }
  /**
   * Make OPS (PTC) the default preset for new sessions, exactly once.
   *
   * This is the only path that writes the profile default: no apply, remount or
   * unload touches it, so an operator choice can never be overridden behind their back.
   * @returns what the preset registration reported; never throws.
   */
  async applyDefaultPreset(): Promise<DefaultPresetResult> {
    const action = this.options.applyDefaultPreset
    if (action === undefined) return { status: 'unavailable',
      message: 'the OPS (PTC) preset is not registered right now, so the default preset was not changed.' }
    return action()
  }
  private preview(action: RuntimeAction): { public: Preview; fingerprint: string } {
    let preview: Preview, facts: unknown
    if (action === 'upgrade-pwsh') {
      const plan = hostPwshUpgradePlan(this.options)
      facts = plan
      preview = { action, available: plan.supported, details: [plan.guidance,
        ...(plan.file ? [[plan.file, ...plan.args].join(' ')] : [])], ...(plan.unavailable ? { reason: plan.unavailable } : {}) }
    } else if (action === 'remove-bash') {
      const inventory = removeManagedBash({ env: this.options.env })
      facts = inventory
      preview = { action, available: inventory.versions.length > 0,
        details: ['Stop running Bash jobs before removal. Only the listed receipt-owned directories will be deleted.',
          ...inventory.versions.map(entry => entry.directory), ...inventory.kept.map(entry => `Keep unowned directory: ${entry.directory}`)],
        ...(!inventory.versions.length ? { reason: 'No receipt-owned managed Bash installation to remove.' } : {}) }
    } else {
      // The action provisions the pinned Niubash payload; the preview must name
      // those bytes, not a legacy Git for Windows archive it will never fetch.
      const supported = this.options.platform === 'win32' && this.options.arch === 'x64'
      const pin = { url: NIUBASH_PIN.url, version: NIUBASH_PIN.upstreamVersion, bytes: NIUBASH_PIN.archiveBytes, sha256: NIUBASH_PIN.archiveSha256 }
      const target = path.join(dshHome(this.options.env), NIUBASH_HOME_PATH)
      const inventory = managedBashInventory(this.options)
      const unowned = inventory.filter(entry => !entry.owned)
      facts = { pin: supported ? pin : null, inventory }
      preview = { action, available: supported && !unowned.length, details: supported ? [
        `Download ${pin.url}`, `Version: ${pin.version}; bytes: ${pin.bytes}; SHA-256: ${pin.sha256}`,
        `Install into ${target}`,
        'The pinned archive and executable are verified. No profile setting is changed. Choose Niubash on the row page afterwards.',
        ...inventory.map(entry => 'Old managed version may be replaced: ' + entry.directory),
      ] : [], ...(!supported ? { reason: 'Niubash installation is available only on Windows x64; other hosts keep their own Bash.' } : {}),
        ...(unowned.length ? { reason: 'Unowned directories exist in the managed Bash store. Resolve them manually before installing.' } : {}) }
    }
    return { public: preview, fingerprint: digest(facts) }
  }
  plan(action: RuntimeAction): RuntimePlan {
    const checked = parseAction(action), value = this.preview(checked), id = value.public.available ? randomUUID() : ''
    const now = this.options.now()
    for (const [key, item] of this.plans) if (item.expires <= now) this.plans.delete(key)
    if (this.plans.size >= 16) this.plans.delete(this.plans.keys().next().value!)
    if (id) this.plans.set(id, { action: checked, fingerprint: value.fingerprint, expires: now + 600_000 })
    return { id, ...value.public }
  }
  execute(id: string, signal: AbortSignal): Promise<RuntimeResult> {
    const operation = this.executePlan(id, signal).finally(() => this.active.delete(operation))
    this.active.add(operation)
    return operation
  }
  private async executePlan(id: string, signal: AbortSignal): Promise<RuntimeResult> {
    if (this.lifetime.signal.aborted || signal.aborted) return failure('cancelled', 'Action cancelled before execution.')
    if (this.busy) return failure('busy', 'Another runtime action is running. Wait for it to settle before planning again.')
    const plan = this.plans.get(id)
    this.plans.delete(id)
    if (!plan || plan.expires <= this.options.now()) return failure('stale', 'This preview expired or was already used. Preview the action again.')
    const current = this.preview(plan.action)
    if (!current.public.available || current.fingerprint !== plan.fingerprint) return failure('stale', 'The runtime plan changed. Preview it again before executing.')
    this.busy = true
    this.plans.clear()
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    let attempted = false
    try {
      combined.throwIfAborted()
      if (plan.action === 'remove-bash') {
        attempted = true
        removeManagedBash({ env: this.options.env, yes: true })
        return { status: 'completed', effectState: 'applied', message: 'Removed the reviewed managed Bash directories. Other installations were preserved.' }
      }
      if (plan.action === 'upgrade-pwsh') {
        const result = await upgradeHostPwsh({ ...this.options, execute: true, signal: combined,
          runner: (value, active) => this.options.run([value.file, ...value.args], active ?? combined) })
        return { status: result.status === 'preview' ? 'unavailable' : result.status, effectState: result.effectState,
          message: [result.error, result.plan.guidance, result.status === 'failed' ? 'If WinGet requires interactive input, run the displayed command in your terminal.' : ''].filter(Boolean).join(' '),
          ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}) }
      }
      attempted = true
      const result = await this.options.run([process.execPath, path.join(PACKAGE_ROOT, 'bin/dsh-ops.mjs'), 'bash-runtime', 'install'], combined)
      if (combined.aborted || result.signal) return failure('cancelled', 'Installation was cancelled. Inspect managed Bash status before trying again.', result.started ? 'unknown' : 'none')
      return { status: result.started && result.exitCode === 0 && !result.error ? 'completed' : 'failed',
        effectState: result.started && result.exitCode === 0 && !result.error ? 'applied' : result.started ? 'unknown' : 'none',
        message: result.started && result.exitCode === 0 && !result.error ? 'Managed Bash installation completed. Select it and save the shell settings to use it.'
          : `${result.error ?? 'Installer failed.'} Inspect managed Bash status; diagnostic details remain on the host.`, exitCode: result.exitCode }
    } catch (error) {
      return failure(combined.aborted ? 'cancelled' : 'failed', error instanceof Error ? error.message : String(error), attempted ? 'unknown' : 'none')
    } finally { this.busy = false }
  }
  async dispose(): Promise<void> {
    this.lifetime.abort(new Error('Shell settings component unloaded'))
    this.plans.clear()
    await Promise.allSettled([...this.active])
  }
}
