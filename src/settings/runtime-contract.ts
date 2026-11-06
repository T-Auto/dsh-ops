/** Shared strict descriptors for operator-only settings actions; no host value imports. */
import type { InvocationDescriptor, RemoteResult, TypertCodec } from '../adapter/dsh/types.js'
export const RUNTIME_ACTIONS = ['install-bash', 'remove-bash', 'upgrade-pwsh'] as const
export type RuntimeAction = typeof RUNTIME_ACTIONS[number]
/** The executors an operator may choose: the packaged Niubash rung, or a Git Bash/MSYS executable. */
export const BASH_SOURCES = ['niubash', 'git'] as const
export type BashSource = typeof BASH_SOURCES[number]
/** Which shell implementation sits behind a resolved path. */
export type BashEngine = 'niubash' | 'msys' | 'none'
/** Where a resolved Bash came from, mirroring the host's own resolution ladder. */
export type BashSourceKind = 'config' | 'provisioned' | 'bundled' | 'path' | 'well-known' | 'missing' | 'disabled'
/** One resolved Bash: the only shape the page may call "what runs". */
export interface BashResolutionView {
  available: boolean
  source: BashSourceKind
  file?: string
  engine: BashEngine
  detail: string
}
/** One mode row's resolution; modes may disagree, so the page must see each. */
export interface ModeBashView extends BashResolutionView {
  id: string
  enabled: boolean
  /** Whether this mode publishes ops_bash at all. */
  publishesBash: boolean
}
/** One receipt-owned installation under `<DSH_HOME>/dsh-ops/shells`. */
export interface ManagedBashView {
  version: string
  directory: string
  owned: boolean
  backend?: 'niubash'
}
export interface RuntimePlan { id: string; action: RuntimeAction; available: boolean; details: string[]; reason?: string }
export interface RuntimeSnapshot {
  platform: string
  /** The single resolution every enabled mode shares; absent when they disagree. */
  bash?: BashResolutionView
  modes: ModeBashView[]
  /** Detected Git Bash/MSYS executables the operator may pick. */
  git: string[]
  managed: ManagedBashView[]
  powerShell: { supported: boolean; guidance: string; unavailable?: string; version?: string }
  companion?: string
}
/** The operator's choice, resolved by the host before anything is written. */
export interface RuntimeSelection {
  source: BashSource
  /** The executable the choice resolves to, when the deployment has one. */
  file?: string
  /** Whether saving means removing the explicit bashPath key (the default rung). */
  clear: boolean
  engine: Exclude<BashEngine, 'none'>
  detail: string
  restriction: string
}
export interface RuntimeResult {
  status: 'completed' | 'no-update' | 'failed' | 'cancelled' | 'stale' | 'unavailable' | 'busy'
  effectState: 'none' | 'applied' | 'unknown'
  message: string
  exitCode?: number | null
}
/** What `select` receives: a source, plus the explicit path for `git`. */
export interface RuntimeSelectionRequest {
  source: BashSource
  path?: string
}
export interface RuntimeRemote {
  snapshot(): Promise<RemoteResult<RuntimeSnapshot>>
  plan(action: RuntimeAction): Promise<RemoteResult<RuntimePlan>>
  select(selection: RuntimeSelectionRequest): Promise<RemoteResult<RuntimeSelection>>
  execute(id: string, signal?: AbortSignal): Promise<RemoteResult<RuntimeResult>>
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap { opsSettings: RuntimeRemote }
}
const codec = (name: string, parse: (value: unknown) => unknown): TypertCodec => ({
  mode: 'strict', typeSymbol: `dsh-ops#${name}`, create: () => ({ parse }),
})
function enumValue<const T extends readonly string[]>(value: unknown, choices: T): T[number] {
  if (typeof value !== 'string' || !choices.includes(value)) throw new Error(`Expected one of: ${choices.join(', ')}`)
  return value
}
export const parseAction = (value: unknown): RuntimeAction => enumValue(value, RUNTIME_ACTIONS)
export const parseSource = (value: unknown): BashSource => enumValue(value, BASH_SOURCES)
/**
 * Validate one selection request. `path` is only meaningful for `git`, so a
 * request that carries it beside `niubash` is refused instead of ignored.
 * @param value - the wire value.
 * @returns the parsed request.
 */
export function parseSelection(value: unknown): RuntimeSelectionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a selection object')
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'source' && key !== 'path') throw new Error(`unexpected selection key ${JSON.stringify(key)}`)
  }
  const source = parseSource(record.source)
  if (record.path === undefined) return { source }
  if (typeof record.path !== 'string') throw new Error('path must be a string')
  if (source !== 'git') throw new Error('path applies only to the git source')
  return { source, path: record.path }
}
function planId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) throw new Error('Expected a current runtime plan identifier')
  return value
}
const jsonResult = codec('RuntimeResult', value => value)
function method(name: string, parameter?: { wire: string; codec: TypertCodec }, cancellable = false): InvocationDescriptor {
  return { id: `dsh-ops#opsSettings/${name}`, service: 'opsSettings', namespace: 'opsSettings', method: name,
    invocation: { kind: 'direct' }, result: jsonResult,
    parameters: parameter ? [{ name: parameter.wire, wire: parameter.wire, source: 'json', codec: parameter.codec }] : [],
    ...(cancellable ? { cancellation: { parameter: 'signal' as const } } : {}),
  }
}
export const RUNTIME_DESCRIPTORS: readonly InvocationDescriptor[] = Object.freeze([
  method('snapshot'), method('plan', { wire: 'action', codec: codec('RuntimeAction', parseAction) }),
  method('select', { wire: 'selection', codec: codec('BashSelection', parseSelection) }),
  method('execute', { wire: 'id', codec: codec('RuntimePlanId', planId) }, true),
])
export const RUNTIME_REMOTE = Object.freeze({ package: 'dsh-ops', descriptors: RUNTIME_DESCRIPTORS })
