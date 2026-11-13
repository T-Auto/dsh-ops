/** Runtime half of the DSH product adapter. Optional host services stay optional. */
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { homedir } from 'node:os'
import { realpathSync } from 'node:fs'
import type { AtomicApi, BootApi, Context } from './types.js'

export interface CarrierHost { boot: BootApi; yaml: typeof import('yaml'); atomic: AtomicApi }

/** Resolve a DSH message constructor only when an admitted message is created. */
export async function loadUserMessage(): Promise<typeof import('@deepseek-ai/dsh-llm').createUserMessage> {
  const llm = await import('@deepseek-ai/dsh-llm')
  return llm.createUserMessage
}

/** Use the running host's public scrub, including its active proxy environment. */
export async function loadScrubbedParentEnv(): Promise<Record<string, string>> {
  const anchor = hostEntryAnchor()
  let source: string
  try { source = anchor ? pathToFileURL(createRequire(anchor).resolve('@deepseek-ai/dsh-subprocess')).href : import.meta.resolve('@deepseek-ai/dsh-subprocess') }
  catch { throw new Error('EXECUTOR_UNAVAILABLE: the host public subprocess environment API is unavailable.') }
  const host = await import(source) as typeof import('@deepseek-ai/dsh-subprocess')
  if (typeof host.scrubbedParentEnv !== 'function') throw new Error('EXECUTOR_UNAVAILABLE: the host public environment scrub is unavailable.')
  return host.scrubbedParentEnv()
}

export function service<T>(ctx: Pick<Context, 'get'>, name: string): T | undefined {
  try {
    const value = ctx.get(name as never)
    return value === undefined || value === null ? undefined : value as T
  } catch { return undefined }
}

type Scopes = typeof import('@deepseek-ai/dsh-scope')

/** Whether two file URLs name the same module on disk, whatever their spelling. */
export function sameModule(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false
  if (a === b) return true
  try { return realpathSync.native(fileURLToPath(a)) === realpathSync.native(fileURLToPath(b)) } catch { return false }
}

/** This package's own install root: a copy resolved inside it is never the running host's. */
const packageRoot = new URL('../../../', import.meta.url).href

/** The module the running host was started from, when argv names one (not a single executable). */
export function hostEntry(): string | undefined {
  const entry = process.argv[1]
  return entry !== undefined && path.isAbsolute(entry) ? entry : undefined
}

/** The copy resolved from the host's own entry: the module tree the running process actually uses. */
function hostScopesUrl(): string | undefined {
  const entry = hostEntry()
  if (entry === undefined) return undefined
  try { return pathToFileURL(createRequire(entry).resolve('@deepseek-ai/dsh-scope')).href } catch { return undefined }
}

/** The copy resolved from the profile layer, for hosts that only expose it there. */
function profileScopesUrl(): string | undefined {
  try { return pathToFileURL(createRequire(path.join(profileLayer(), 'package.json')).resolve('@deepseek-ai/dsh-scope')).href } catch { return undefined }
}

/** The profile tree this process serves; a copy resolved there may be another bundle's hoist. */
export function profileLayer(): string {
  return path.join(process.env.DSH_HOME ?? path.join(homedir(), '.dsh'), 'profiles')
}

/**
 * The running host entry through its real path, for a module-resolution anchor.
 *
 * A published bin is a symlink (`bin/dsh` → `lib/bin.js`), and a require
 * anchored on the link resolves from the `bin` directory instead of the host
 * package's module tree. Resolving the link first points the anchor at the host
 * copy every other module in this process uses.
 * @param entry - the entry path; defaults to {@link hostEntry}.
 * @returns the canonical absolute entry, or undefined when there is none.
 */
export function hostEntryAnchor(entry: string | undefined = hostEntry()): string | undefined {
  if (entry === undefined) return undefined
  try { return realpathSync.native(entry) } catch { return undefined }
}

/** Whether one URL sits inside this package's checkout or the profile tree that loads it. */
function untrustedSource(url: string): boolean {
  return url.startsWith(packageRoot) || url.startsWith(`${pathToFileURL(profileLayer()).href}/`)
}

/**
 * Pick which `@deepseek-ai/dsh-scope` copy to load.
 *
 * The package tags a context with `Symbol('dsh.scope')` and keeps ancestry in a
 * module-private `WeakMap`, so a second copy reads neither: `scopeOf` returns
 * `undefined`, every ancestor lookup collapses to the key itself, and session
 * publication fails its scope check. Two copies can shadow the host's when the
 * resolution starts inside a tree that installs its own: a `link:`ed checkout
 * resolves the copy inside that checkout, and a profile install can resolve a
 * copy another bundle hoisted into the profile tree ahead of the host's
 * interception layer. Only those two positions are re-pointed at the host's
 * copy; every other resolution already is the host's. Re-pointing uses the
 * bare URL when both names already agree on the file, so a spelling difference
 * cannot load it twice.
 * @param bare - URL the bare specifier resolves to from this package.
 * @param host - URL the running host entry resolves to, when it resolves one.
 * @param profile - URL the profile layer resolves to, when it resolves one.
 * @returns the URL to import, or `undefined` when no copy can be resolved.
 */
export function chooseScopeSource(bare: string | undefined, host: string | undefined, profile?: string): string | undefined {
  if (bare === undefined) return host ?? profile
  if (!untrustedSource(bare)) return bare
  if (host === undefined) return profile ?? bare
  return sameModule(bare, host) ? bare : host
}

/** Chosen once: the running host's module tree does not change inside one process. */
let scopeSource: string | undefined

/** Load the scope helpers from the copy the running host uses, not a second copy. */
export async function loadScopes(): Promise<Scopes> {
  if (scopeSource === undefined) {
    let bare: string | undefined
    try { bare = import.meta.resolve('@deepseek-ai/dsh-scope') } catch { bare = undefined }
    const source = chooseScopeSource(bare, hostScopesUrl(), profileScopesUrl())
    if (source === undefined) throw new Error('The host provides no @deepseek-ai/dsh-scope to load')
    scopeSource = source
  }
  return import(scopeSource) as Promise<Scopes>
}

export async function loadCarrierHost(anchor: string): Promise<CarrierHost> {
  if (!path.isAbsolute(anchor)) throw new Error('--host-anchor must be an absolute path to the host package.json.')
  const require = createRequire(anchor)
  const editorRequire = createRequire(require.resolve('@deepseek-ai/dsh-config-editor'))
  const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href) as unknown as BootApi
  const yaml = await import(pathToFileURL(editorRequire.resolve('yaml')).href) as typeof import('yaml')
  const atomic = await import(pathToFileURL(editorRequire.resolve('@deepseek-ai/dsh-atomic-write')).href) as unknown as AtomicApi
  for (const name of ['loadProfileDirectory', 'composeEntries', 'readProfilePatches', 'resolveBundleDir', 'loadOverlayPatches'] as const) {
    if (typeof boot[name] !== 'function') throw new Error(`Host profile API unavailable: ${name}`)
  }
  return { boot, yaml, atomic }
}
