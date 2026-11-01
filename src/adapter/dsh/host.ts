/** Runtime half of the DSH product adapter. Optional host services stay optional. */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
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
export async function loadScopes(): Promise<typeof import('@deepseek-ai/dsh-scope')> {
  return import('@deepseek-ai/dsh-scope')
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
