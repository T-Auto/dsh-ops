/** Operator runtime plans: fixed actions, one-use previews, serialized execution. */
import { randomUUID, createHash } from 'node:crypto'
import path from 'node:path'
import type { TypertGatewayBinding } from '../adapter/dsh/types.js'
import { PACKAGE_ROOT } from '../paths.js'
import { gitBashCandidates, managedBashInventory, removeManagedBash, selectBashRuntime } from '../shells/manager.js'
import { shellUpstreamPin, provisionedShellVersionDir } from '../shells/pins.js'
import { hostPwshUpgradePlan, upgradeHostPwsh, hostPwshVersion } from '../shells/pwsh-upgrade.js'
import { companionVersion } from './companion.js'
import type { UpgradeProcessResult } from '../shells/pwsh-upgrade.js'
import { parseAction, parseSource } from './runtime-contract.js'
import type { RuntimeAction, RuntimePlan, RuntimeResult, RuntimeSnapshot, RuntimeSelection, BashSource } from './runtime-contract.js'

export type RuntimeProcessRunner = (argv: readonly string[], signal: AbortSignal) => Promise<UpgradeProcessResult>
export interface RuntimeActionOptions {
  run: RuntimeProcessRunner
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  arch?: string
  now?: () => number
}
type Preview = Omit<RuntimePlan, 'id'>
const failure = (status: RuntimeResult['status'], message: string, effectState: RuntimeResult['effectState'] = 'none'): RuntimeResult => ({ status, message, effectState })
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export class RuntimeActions {
  readonly typertRemote: TypertGatewayBinding<this> = Object.freeze({ service: this, serviceKey: 'opsSettings', namespace: 'opsSettings' })
  private readonly options: Required<Omit<RuntimeActionOptions, 'run'>> & Pick<RuntimeActionOptions, 'run'>
  private readonly plans = new Map<string, { action: RuntimeAction; fingerprint: string; expires: number }>()
  private readonly lifetime = new AbortController()
  private busy = false
  private readonly active = new Set<Promise<RuntimeResult>>()
  constructor(options: RuntimeActionOptions) {
    this.options = { env: process.env, platform: process.platform, arch: process.arch, now: Date.now, ...options }
  }
  snapshot(): RuntimeSnapshot {
    const powerShell = hostPwshUpgradePlan(this.options)
    return { platform: this.options.platform, managed: managedBashInventory(this.options), git: gitBashCandidates(this.options),
      ...(companionVersion(this.options) === undefined ? {} : { companion: companionVersion(this.options) }),
      powerShell: { supported: powerShell.supported, guidance: powerShell.guidance,
        ...(powerShell.unavailable ? { unavailable: powerShell.unavailable } : {}),
        ...(hostPwshVersion(this.options) === undefined ? {} : { version: hostPwshVersion(this.options) }) } }
  }
  select(source: BashSource): RuntimeSelection {
    const selected = selectBashRuntime(parseSource(source), this.options)
    return { bashPath: selected.file, restriction: selected.restricted.compatible
      ? 'This Bash has verified restricted-mode IPC compatibility.'
      : String(selected.restricted.reason ?? 'Restricted modes cannot use this Bash. A supported sandbox/executor remains required.') }
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
      const rawPin = shellUpstreamPin({ kind: 'bash', ...this.options })
      const pin = rawPin && 'url' in rawPin && typeof rawPin.url === 'string'
        && 'version' in rawPin && typeof rawPin.version === 'string'
        && 'bytes' in rawPin && typeof rawPin.bytes === 'number'
        && 'sha256' in rawPin && typeof rawPin.sha256 === 'string'
        ? { url: rawPin.url, version: rawPin.version, bytes: rawPin.bytes, sha256: rawPin.sha256 } : undefined
      const inventory = managedBashInventory(this.options)
      const unowned = inventory.filter(entry => !entry.owned)
      facts = { pin: pin ?? null, inventory }
      preview = { action, available: Boolean(pin) && !unowned.length, details: pin ? [
        `Download ${pin.url}`, `Version: ${pin.version}; bytes: ${pin.bytes}; SHA-256: ${pin.sha256}`,
        `Install into ${provisionedShellVersionDir({ kind: 'bash', version: pin.version, env: this.options.env })}`,
        'The pinned archive and executable are verified. No profile setting is changed. Reload the mode row after selecting the executor.',
        ...inventory.map(entry => 'Old managed version may be replaced: ' + entry.directory),
      ] : [], ...(!pin ? { reason: 'Managed Bash installation is available only for supported Windows builds.' } : {}),
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
