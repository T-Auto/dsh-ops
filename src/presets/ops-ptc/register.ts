/**
 * Register the ops-ptc agent preset at runtime through the host registry.
 *
 * The preset is this plugin's own contribution, so it is not a bundle row: the
 * bundle patch stays the single `dsh-ops` row, and a profile that disables that
 * row loses the preset together with the plugin instead of keeping a selected
 * default that can no longer compose a session.
 *
 * The definition lives in a loader patch fragment (`presets/ops-ptc.patch.yml`)
 * generated from the installed host preset. Parsing it with the host's own
 * `loadOverlayPatches` keeps the `!!js` platform expressions unevaluated, so the
 * registry receives exactly the dialect every other preset declaration uses.
 *
 * @module dsh-ops/presets/ops-ptc/register
 */
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '../../adapter/dsh/types.js'
import { hostEntry, hostEntryAnchor, profileLayer, sameModule, service } from '../../adapter/dsh/host.js'

/** Diagnostic prefix the host prints for this package's patch loads. */
const BIN_NAME = 'dsh-ops'

/** The host package that owns the loader patch parser. */
const APP_BOOT = '@deepseek-ai/dsh-app-boot'

/** The host plugin that declares one preset row. */
export const PRESET_PLUGIN = '@deepseek-ai/dsh-agent-preset'

/** The preset id the host preset registry publishes under. */
export const PRESET_ID = 'ops-ptc'

/** The profile entry whose volatile `selectedDefault` names the default preset. */
export const REGISTRY_NAMESPACE = 'agent-preset-registry'

/**
 * The shipped preset fragment, resolved from the compiled module (so
 * `lib/presets/ops-ptc/register.js` finds `<package>/presets/ops-ptc.patch.yml`).
 */
export const FRAGMENT_FILE = fileURLToPath(new URL('../../../presets/ops-ptc.patch.yml', import.meta.url))

/** One child plugin row of a preset declaration, in the loader's own dialect. */
export interface PresetPlugin {
  readonly id?: string
  readonly name: string
  readonly group?: boolean
  readonly disabled?: unknown
  readonly config?: unknown
}

/** Identity, display fields and child plugins the registry accepts for one preset. */
export interface PresetDefinition {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly order?: number
  readonly plugins: readonly PresetPlugin[]
}

/** The registry's `selectedDefault` reference: a read-only volatile snapshot. */
export interface DefaultSelection {
  get(): string | undefined
}

/** The registry fields the default-preset switch reads. */
export interface PresetRegistryConfig {
  readonly default: string
  readonly selectedDefault?: DefaultSelection
}

/** The slice of the host `agentPresets` service this registration needs. */
export interface PresetRegistry {
  readonly config: PresetRegistryConfig
  readonly defaultId: string
  register(definition: PresetDefinition): Promise<() => Promise<void>>
}

/** The slice of the host settings service used to persist the selected default. */
export interface SettingsService {
  update(namespace: string, patch: Record<string, unknown>): Promise<unknown>
}

/** One parsed loader patch list, as the host's `loadOverlayPatches` returns it. */
export type FragmentLoader = (binName: string, file: string) => readonly unknown[]

/** Test seams; production calls pass nothing. */
export interface RegistrationOptions {
  /** Replace the host fragment parser (tests only). */
  load?: FragmentLoader
  /** Replace the warning sink (tests only); defaults to the row logger. */
  warn?: (message: string) => void
  /** Replace the fragment path (tests only); defaults to {@link FRAGMENT_FILE}. */
  file?: string
  /** Replace the host entry anchor (tests only); defaults to `process.argv[1]`. */
  hostEntry?: string
}

/** The subset of the host boot package this registration needs. */
export interface AppBootApi {
  loadOverlayPatches?: FragmentLoader
}

/** One loaded host boot copy: the module file and the parser this module needs. */
export interface ResolvedAppBoot {
  readonly file: string
  readonly load: FragmentLoader
}

/**
 * Injected activations already handled.
 *
 * The Loader reuses a row's fiber across a config remount (it re-runs `apply` on
 * the same fiber), so the injected child is the activation identity: one
 * registration per injection, and a remount injects a fresh child.
 */
const registered = new WeakSet<object>()

/** The live registration of one injected context. */
interface Slot {
  release?: () => Promise<void>
  disposed: boolean
}

/** One human-readable error message. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Report a failure without failing the row: the preset is an enhancement, not a dependency. */
function warn(options: RegistrationOptions, root: Context, message: string): void {
  if (options.warn !== undefined) {
    options.warn(message)
    return
  }
  root.logger?.warn?.(message)
}

/** The host settings service, or undefined when this deployment has none. */
function settingsOf(ctx: Context): SettingsService | undefined {
  return service<SettingsService>(ctx, 'settings')
}

/** The preset new sessions currently default to. */
function currentDefault(registry: PresetRegistry): string | undefined {
  try {
    const value = registry.defaultId
    return typeof value === 'string' && value !== '' ? value : undefined
  } catch { return undefined }
}

/**
 * Persist one default-preset selection through the host settings service.
 *
 * This is the same mechanism the settings page uses, so the write lands in the
 * profile layer and hot-applies to the live registry.
 * @param ctx - the context whose settings service persists the value.
 * @param value - the default preset id to write.
 * @param captured - a settings service the caller resolved while it was live;
 *   the unload lease passes one because its own context may already be gone.
 * @returns the failure message, or undefined when the host accepted the write.
 */
async function writeSelectedDefault(ctx: Context, value: string, captured?: SettingsService): Promise<string | undefined> {
  const settings = captured ?? settingsOf(ctx)
  if (typeof settings?.update !== 'function') {
    return 'the host settings service is unavailable, so the default preset was not changed'
  }
  try {
    await settings.update(REGISTRY_NAMESPACE, { selectedDefault: value })
    return undefined
  } catch (error) {
    return `cannot persist the default agent preset: ${errorText(error)}`
  }
}

/**
 * The operator action behind the page's button.
 *
 * Nothing writes the profile's default preset on its own: not an apply, not a
 * remount, not an unload. This action is the only path, so a default the operator
 * chose anywhere else is never overridden behind their back.
 */
export interface PresetDefaultAction {
  status: 'applied' | 'no-update' | 'unavailable' | 'failed'
  message: string
  /** The default preset after the call, when the host can report it. */
  defaultPreset?: string
}

/** What {@link registerOpsPtcPreset} hands back: the one action an operator can run. */
export interface OpsPtcPreset {
  applyDefault(): Promise<PresetDefaultAction>
}

/**
 * The live registration the action writes through; empty when none is mounted.
 *
 * `settings` is captured while the injected child is alive: the unload lease
 * writes through it after the child is gone (#928), when the child context can
 * no longer resolve the service.
 */
interface LiveRegistration {
  ctx?: Context
  registry?: PresetRegistry
  settings?: SettingsService
}

/**
 * Make OPS (PTC) the default preset for new sessions, once.
 *
 * The write goes through the host settings service — the same mechanism the
 * settings page uses — so it lands in the profile layer and hot-applies.
 * @param live - the current registration; empty means there is no preset to point at.
 * @param options - test seams; production passes none.
 * @returns what happened; never throws.
 */
async function applyDefaultPreset(live: LiveRegistration, options: RegistrationOptions): Promise<PresetDefaultAction> {
  const { ctx, registry } = live
  if (ctx === undefined || registry === undefined) {
    return { status: 'unavailable',
      message: 'the OPS (PTC) preset is not registered right now (the dsh-ops row is disabled or still starting), so the default preset was not changed' }
  }
  const before = currentDefault(registry)
  if (before === PRESET_ID) return { status: 'no-update', message: 'new sessions already default to OPS (PTC)', defaultPreset: before }
  const failure = await writeSelectedDefault(ctx, PRESET_ID)
  if (failure !== undefined) {
    warn(options, ctx, `dsh-ops: ${failure}.`)
    return { status: 'failed', message: failure }
  }
  const after = currentDefault(registry)
  if (after !== PRESET_ID) return { status: 'failed', message: `the host did not keep the new default (it reports ${after ?? 'no default'})` }
  return { status: 'applied', message: 'new sessions now default to OPS (PTC)', defaultPreset: after }
}

/**
 * Release the registration on teardown.
 *
 * The default preset is left exactly as it is: reverting an operator's selection
 * would be the same surprise the removed forced default used to cause. Only the
 * preset declaration is released.
 */
function releaseRegistration(ctx: Context, slot: Slot, options: RegistrationOptions): void {
  try {
    const released = slot.release?.()
    if (released !== undefined) released.catch(error => warn(options, ctx, `dsh-ops: cannot release the ops-ptc preset: ${errorText(error)}`))
  } catch (error) {
    warn(options, ctx, `dsh-ops: cannot release the ops-ptc preset: ${errorText(error)}`)
  }
}

/**
 * The host's own default preset, when it is a usable id distinct from this
 * row's preset.
 * @param registry - the registry whose config declares the host default.
 * @returns the host default id, or undefined when there is none to fall back to.
 */
function hostDefaultOf(registry: PresetRegistry): string | undefined {
  try {
    const value = registry.config?.default
    return typeof value === 'string' && value !== '' && value !== PRESET_ID ? value : undefined
  } catch { return undefined }
}

/**
 * Restore the profile default this row is about to strand.
 *
 * Unload and disable remove the ops-ptc preset, but the profile keeps the
 * `selectedDefault` the operator's one click wrote: every new session then
 * fails to compose against a preset that no longer exists (#928). The lease
 * writes the host default back — only when the live value still names this
 * row's preset; a default naming any other preset is an operator choice and is
 * never touched. Best effort with a warning: a host without a usable settings
 * service, or one that refuses the write, reports the leftover and its
 * remediation instead of guessing.
 * @param served - the last registration this row served.
 * @param options - test seams; production passes none.
 */
async function restoreLeftoverDefault(served: LiveRegistration, options: RegistrationOptions): Promise<void> {
  const { ctx, registry } = served
  if (ctx === undefined || registry === undefined) return
  if (currentDefault(registry) !== PRESET_ID) return
  const fallback = hostDefaultOf(registry)
  if (fallback === undefined) {
    warn(options, ctx, 'dsh-ops: the profile still names the removed ops-ptc preset as its default; choose another default on the host settings page.')
    return
  }
  const failure = await writeSelectedDefault(ctx, fallback, served.settings)
  if (failure !== undefined) {
    warn(options, ctx, `dsh-ops: ${failure}; the profile still names the removed ops-ptc preset, so new sessions may fail to compose until another default is chosen.`)
    return
  }
  warn(options, ctx, `dsh-ops: restored the default agent preset to ${fallback}, because the ops-ptc preset was removed with this row.`)
}

/**
 * Resolve one package from a require anchor.
 * @param anchor - the absolute module path resolution starts from.
 * @returns the resolved module file, or undefined when the anchor cannot see it.
 */
function requireFrom(anchor: string): string | undefined {
  try { return createRequire(anchor).resolve(APP_BOOT) } catch { return undefined }
}

/** Every package directory under one `node_modules`, scoped packages included. */
function packageDirectories(modules: string): string[] {
  let entries
  try { entries = readdirSync(modules, { withFileTypes: true }) } catch { return [] }
  const directories: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.name.startsWith('@')) {
      const scope = path.join(modules, entry.name)
      try {
        for (const child of readdirSync(scope, { withFileTypes: true })) {
          if (child.isDirectory() || child.isSymbolicLink()) directories.push(path.join(scope, child.name))
        }
      } catch { /* an unreadable scope contributes no anchor */ }
      continue
    }
    if (entry.name === '.bin' || entry.name === '.pnpm') continue
    directories.push(path.join(modules, entry.name))
  }
  return directories
}

/**
 * Installed packages in this DSH home's profile layer, as require anchors.
 *
 * A nonstandard layout can leave the running host unreachable through `argv`,
 * while a profile package still resolves the host copy from its own
 * `node_modules`. This is the last anchor, so it costs nothing on a normal boot.
 * @returns `package.json` anchors for the installed profile packages.
 */
function profilePackageAnchors(): string[] {
  let profiles
  const layer = profileLayer()
  try { profiles = readdirSync(layer, { withFileTypes: true }) } catch { return [] }
  const anchors: string[] = []
  for (const profile of profiles) {
    if (!profile.isDirectory()) continue
    const modules = path.join(layer, profile.name, 'node_modules')
    for (const directory of packageDirectories(modules)) anchors.push(path.join(directory, 'package.json'))
  }
  return anchors
}

/**
 * Every require anchor this process may resolve the host boot package from.
 *
 * The order is deliberate: this package's own tree first (a hoisted profile
 * copy), then the running host entry's real path, then whatever the profile
 * layer installed. Only the first and last can resolve a non-host copy; the
 * host entry is the authoritative one.
 * @param hostEntryPath - entry to anchor on; defaults to {@link hostEntry}.
 * @returns absolute anchor paths, in priority order.
 */
export function appBootAnchors(hostEntryPath?: string): string[] {
  const anchors = [fileURLToPath(import.meta.url)]
  const anchor = hostEntryAnchor(hostEntryPath ?? hostEntry())
  if (anchor !== undefined) anchors.push(anchor)
  for (const profileAnchor of profilePackageAnchors()) anchors.push(profileAnchor)
  return anchors
}

/**
 * Resolve and load the host boot package that owns `loadOverlayPatches`.
 *
 * A bare import from this installed package misses the host copy in a profile
 * layout that does not hoist it. The host entry is reached through its real path
 * because the published bin is a symlink. A copy that resolves but does not load
 * (or lacks the parser) is skipped instead of failing the registration.
 * @param hostEntryPath - entry to anchor on; tests inject one; defaults to argv.
 * @returns the resolved module file and its loader, or undefined when no copy loads.
 */
export async function resolveAppBoot(hostEntryPath?: string): Promise<ResolvedAppBoot | undefined> {
  const seen: string[] = []
  for (const anchor of appBootAnchors(hostEntryPath)) {
    const file = requireFrom(anchor)
    if (file === undefined) continue
    const url = pathToFileURL(file).href
    if (seen.some(previous => sameModule(previous, url))) continue
    seen.push(url)
    try {
      const boot = await import(url) as AppBootApi
      if (typeof boot.loadOverlayPatches === 'function') return { file, load: boot.loadOverlayPatches }
    } catch { /* try the next anchor */ }
  }
  return undefined
}

/**
 * Load the host's own patch parser.
 *
 * Loaded at call time, never at module load: the host half must stay free of
 * `@deepseek-ai/*` value imports, and a deployment without the host package
 * must still load this plugin's tools.
 * @param options - test seams; production passes none.
 * @returns the host `loadOverlayPatches` function, or undefined when unresolved.
 */
async function hostLoader(options: RegistrationOptions): Promise<FragmentLoader | undefined> {
  return (await resolveAppBoot(options.hostEntry))?.load
}

/**
 * Find the ops-ptc declaration in one parsed patch list.
 * @param patches - the parsed loader patch entries.
 * @returns the preset definition, or undefined when no row declares the preset.
 * @throws when the row declares the preset but carries no child plugin list.
 */
export function definitionFromPatches(patches: readonly unknown[]): PresetDefinition | undefined {
  for (const entry of patches) {
    if (typeof entry !== 'object' || entry === null) continue
    const rows = (entry as { insert?: unknown }).insert
    if (!Array.isArray(rows)) continue
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue
      const candidate = row as { name?: unknown; config?: unknown }
      if (candidate.name !== PRESET_PLUGIN) continue
      const config = candidate.config
      if (typeof config !== 'object' || config === null || (config as { id?: unknown }).id !== PRESET_ID) continue
      const plugins = (config as { plugins?: unknown }).plugins
      if (!Array.isArray(plugins) || plugins.length === 0) {
        throw new Error(`the ops-ptc preset declares no child plugins in ${FRAGMENT_FILE}`)
      }
      return config as PresetDefinition
    }
  }
  return undefined
}

/**
 * Parse the fragment and read the ops-ptc definition.
 *
 * Every failure is a warning: a missing, unreadable or malformed fragment only
 * costs this preset, it must never take the plugin row (and its tools) down.
 * @param options - test seams; production passes none.
 * @param root - the row context that owns the warning sink.
 * @returns the definition, or undefined when the preset cannot be registered.
 */
export async function readOpsPtcDefinition(options: RegistrationOptions, root: Context): Promise<PresetDefinition | undefined> {
  try {
    const load = options.load ?? await hostLoader(options)
    if (load === undefined) {
      warn(options, root, `dsh-ops: cannot resolve ${APP_BOOT} from this plugin or the running host; the ops-ptc preset stays unavailable.`)
      return undefined
    }
    const definition = definitionFromPatches(load(BIN_NAME, options.file ?? FRAGMENT_FILE))
    if (definition === undefined) {
      warn(options, root, `dsh-ops: preset fragment ${options.file ?? FRAGMENT_FILE} declares no ops-ptc preset; the preset stays unavailable.`)
      return undefined
    }
    return definition
  } catch (error) {
    warn(options, root, `dsh-ops: cannot read the ops-ptc preset fragment: ${errorText(error)}; the preset stays unavailable.`)
    return undefined
  }
}

/**
 * Register the ops-ptc preset once the host registry is available.
 *
 * The call is synchronous by design: the registration itself is asynchronous,
 * and a delay or failure must never delay the row's tools. Disposal releases the
 * registration through the same injected context that created it; a remount
 * injects a new context and registers again.
 * @param root - this plugin row's context.
 * @param options - test seams; production passes none.
 * @returns the registration's one operator action; the work itself continues in the background.
 */
export function registerOpsPtcPreset(root: Context, options: RegistrationOptions = {}): OpsPtcPreset {
  const live: LiveRegistration = {}
  /**
   * The last registration this row served: the injected child clears `live`
   * when it goes away, while this holder stays readable for the unload lease,
   * and a remount overwrites it with the fresh child's registration.
   */
  const served: LiveRegistration = {}
  root.inject(['agentPresets'], ctx => {
    const registry = service<PresetRegistry>(ctx, 'agentPresets')
    if (registry === undefined || typeof registry.register !== 'function') return
    // One registration per injection: the same activation cannot register twice,
    // while a remount injects a fresh child and registers again.
    const activation: object = ctx.fiber ?? ctx
    if (registered.has(activation)) return
    registered.add(activation)
    const slot: Slot = { disposed: false }
    ctx.effect(() => () => {
      slot.disposed = true
      if (live.ctx === ctx) { live.ctx = undefined; live.registry = undefined }
      releaseRegistration(ctx, slot, options)
    }, 'dsh-ops: ops-ptc preset')
    void activate(ctx, registry, slot, options, live, served).catch(error => {
      warn(options, ctx, `dsh-ops: cannot register the ops-ptc agent preset: ${errorText(error)}; the preset stays unavailable.`)
    })
  })
  // The lease below is the row's own lifetime: the Loader reuses a row's fiber
  // across a config remount, so a remount never fires it. It fires when the row
  // is disabled or unloaded — the one moment the profile can be left naming a
  // preset that no longer exists (#928).
  root.effect(() => () => { void restoreLeftoverDefault(served, options) }, 'dsh-ops: ops-ptc preset default lease')
  return { applyDefault: () => applyDefaultPreset(live, options) }
}

/** The service bili's compaction takeover publishes; its presence means "let bili own compaction". */
export const BILI_COMPACTION_POLICY_SERVICE = 'biliBasicCompactionPolicy'

/** The preset rows that run DSH's own compaction, which bili's takeover replaces. */
export const COMPACTION_PLUGIN_NAMES: readonly string[] = Object.freeze([
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-command-compact',
])

/** One child-list rewrite: the rows to register, and whether any row changed. */
interface CompactionRewrite {
  readonly rows: readonly PresetPlugin[]
  readonly changed: boolean
}

/**
 * Disable DSH's own compaction rows in one child list, recursing into groups.
 *
 * bili's takeover disables these rows on every loader-declared preset through
 * an `internal/config` overlay. This preset is a runtime registration that
 * overlay cannot see, so the same rows are disabled here, in the definition
 * handed to the registry.
 * @param rows - the child plugin rows of one preset or group.
 * @returns the rewritten rows and whether anything changed.
 */
function disableCompactionRows(rows: readonly PresetPlugin[]): CompactionRewrite {
  let changed = false
  const next = rows.map(row => {
    if (COMPACTION_PLUGIN_NAMES.includes(row.name)) {
      if (row.disabled === true) return row
      changed = true
      return { ...row, disabled: true }
    }
    if (row.group === true && Array.isArray(row.config)) {
      const children = disableCompactionRows(row.config as readonly PresetPlugin[])
      if (!children.changed) return row
      changed = true
      return { ...row, config: children.rows }
    }
    return row
  })
  return { rows: changed ? next : rows, changed }
}

/**
 * Apply bili's compaction takeover to one preset definition, when present.
 *
 * The bili gate publishes {@link BILI_COMPACTION_POLICY_SERVICE} as a sentinel;
 * only its presence matters. When it is absent the definition is returned
 * unchanged, so a deployment without bili keeps DSH's own compaction.
 * @param ctx - the injected context that may expose the sentinel.
 * @param definition - the parsed preset definition.
 * @returns the definition to register, with bili-covered compaction rows off.
 */
export function respectBiliCompactionPolicy(ctx: Pick<Context, 'get'>, definition: PresetDefinition): PresetDefinition {
  if (service<unknown>(ctx, BILI_COMPACTION_POLICY_SERVICE) === undefined) return definition
  const rewrite = disableCompactionRows(definition.plugins)
  if (!rewrite.changed) return definition
  return { ...definition, plugins: rewrite.rows }
}

/**
 * Read and register the definition inside one injected context.
 * @param ctx - the context the registry service is injected into.
 * @param registry - the host preset registry.
 * @param slot - release holder the fiber cleanup reads.
 * @param options - test seams; production passes none.
 * @param live - the holder the operator action reads; the child clears it on teardown.
 * @param served - the holder the unload lease reads; it survives the child teardown.
 * @returns resolves once the registration is owned by {@link slot}.
 */
async function activate(ctx: Context, registry: PresetRegistry, slot: Slot, options: RegistrationOptions, live: LiveRegistration, served: LiveRegistration): Promise<void> {
  const definition = await readOpsPtcDefinition(options, ctx)
  if (definition === undefined || slot.disposed) return
  // bili's compaction takeover cannot reach this runtime registration through
  // its loader overlay, so the definition it covers is rewritten here.
  const effective = respectBiliCompactionPolicy(ctx, definition)
  // A failed registration leaves the default preset exactly as it was: this row
  // never points new sessions at a preset it could not register.
  const release = await registry.register(effective)
  if (slot.disposed) {
    await release()
    return
  }
  slot.release = release
  // The operator action reads this: only a registered preset may be made the default.
  live.ctx = ctx
  live.registry = registry
  // The unload lease reads this after the injected child is gone (#928).
  served.ctx = ctx
  served.registry = registry
  served.settings = settingsOf(ctx)
}
