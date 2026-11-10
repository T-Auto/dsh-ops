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

/** The slice of the host `agentPresets` service this registration needs. */
export interface PresetRegistry {
  register(definition: PresetDefinition): Promise<() => Promise<void>>
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

/** Roots already handled, so a second apply on the same fiber cannot register twice. */
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
 * registration through the same fiber that created it.
 * @param root - this plugin row's context.
 * @param options - test seams; production passes none.
 * @returns nothing; the work continues in the background.
 */
export function registerOpsPtcPreset(root: Context, options: RegistrationOptions = {}): void {
  if (registered.has(root)) return
  registered.add(root)
  root.inject(['agentPresets'], ctx => {
    const registry = service<PresetRegistry>(ctx, 'agentPresets')
    if (registry === undefined || typeof registry.register !== 'function') return
    const slot: Slot = { disposed: false }
    ctx.effect(() => () => {
      slot.disposed = true
      if (slot.release !== undefined) void slot.release()
    }, 'dsh-ops: ops-ptc preset')
    void activate(ctx, registry, slot, options).catch(error => {
      warn(options, ctx, `dsh-ops: cannot register the ops-ptc agent preset: ${errorText(error)}; the preset stays unavailable.`)
    })
  })
}

/**
 * Read and register the definition inside one injected context.
 * @param ctx - the context the registry service is injected into.
 * @param registry - the host preset registry.
 * @param slot - release holder the fiber cleanup reads.
 * @param options - test seams; production passes none.
 * @returns resolves once the registration is owned by {@link slot}.
 */
async function activate(ctx: Context, registry: PresetRegistry, slot: Slot, options: RegistrationOptions): Promise<void> {
  const definition = await readOpsPtcDefinition(options, ctx)
  if (definition === undefined || slot.disposed) return
  const release = await registry.register(definition)
  if (slot.disposed) {
    await release()
    return
  }
  slot.release = release
}
