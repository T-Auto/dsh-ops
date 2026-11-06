/** Runtime half of the DSH product adapter. Optional host services stay optional. */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { homedir } from 'node:os'
import type { AtomicApi, BootApi, Context } from './types.js'

export interface CarrierHost { boot: BootApi; yaml: typeof import('yaml'); atomic: AtomicApi }

/** Resolve a DSH message constructor only when an admitted message is created. */
export async function loadUserMessage(): Promise<typeof import('@deepseek-ai/dsh-llm').createUserMessage> {
  const llm = await import('@deepseek-ai/dsh-llm')
  return llm.createUserMessage
}

export function service<T>(ctx: Pick<Context, 'get'>, name: string): T | undefined {
  try {
    const value = ctx.get(name as never)
    return value === undefined || value === null ? undefined : value as T
  } catch { return undefined }
}

/** Scope helpers are deliberately lazy: load-time plugin evaluation needs no DSH scope package. */
type Scopes = typeof import('@deepseek-ai/dsh-scope')

/** This package's own install root: a dependency resolved inside it is never the host's copy. */
const packageRoot = new URL('../../../', import.meta.url).href

/** Resolve the host's install tree: profiles hold the packages a plugin row loads. */
function profileAnchor(): string {
  const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
  return path.join(home, 'profiles', 'package.json')
}

/** The host's copy, when the profile tree resolves one. */
function hostScopesUrl(): string | undefined {
  try { return pathToFileURL(createRequire(profileAnchor()).resolve('@deepseek-ai/dsh-scope')).href } catch { return undefined }
}

/**
 * Pick which `@deepseek-ai/dsh-scope` copy to load. The package tags a context
 * with `Symbol('dsh.scope')` and keeps ancestry in a module-private `WeakMap`,
 * so a second copy reads neither: `scopeOf` returns `undefined`, every ancestor
 * lookup collapses to the key itself, and publication fails its scope check. A
 * packaged install resolves the host's tree because this package ships no
 * `node_modules` of its own; a `link:`ed development checkout instead resolves
 * the copy installed inside this package, which is never the host's.
 * @param bare - URL the bare specifier resolves to from this package.
 * @param host - URL the host install tree resolves to, when it resolves one.
 * @returns the URL to import.
 */
export function chooseScopeSource(bare: string, host?: string): string {
  if (host === undefined || host === bare) return bare
  return bare.startsWith(packageRoot) ? host : bare
}

/** Load the scope helpers from the copy the host uses. */
export async function loadScopes(): Promise<Scopes> {
  const bare = import.meta.resolve('@deepseek-ai/dsh-scope')
  return import(chooseScopeSource(bare, hostScopesUrl())) as Promise<Scopes>
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
