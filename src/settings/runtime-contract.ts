/** Shared strict descriptors for operator-only settings actions; no host value imports. */
import type { InvocationDescriptor, RemoteResult, TypertCodec } from '../adapter/dsh/types.js'
export const RUNTIME_ACTIONS = ['install-bash', 'remove-bash', 'upgrade-pwsh'] as const
export type RuntimeAction = typeof RUNTIME_ACTIONS[number]
export type BashSource = 'managed' | 'git'
export interface RuntimePlan { id: string; action: RuntimeAction; available: boolean; details: string[]; reason?: string }
export interface RuntimeSnapshot {
  platform: string
  managed: { version: string; directory: string; owned: boolean }[]
  git: string[]
  powerShell: { supported: boolean; guidance: string; unavailable?: string; version?: string }
  /** Installed version of dsh-win-pwsh7, when the profile has it. */
  companion?: string
}
export interface RuntimeSelection { bashPath: string; restriction: string }
export interface RuntimeResult {
  status: 'completed' | 'no-update' | 'failed' | 'cancelled' | 'stale' | 'unavailable' | 'busy'
  effectState: 'none' | 'applied' | 'unknown'
  message: string
  exitCode?: number | null
}
export interface RuntimeRemote {
  snapshot(): Promise<RemoteResult<RuntimeSnapshot>>
  plan(action: RuntimeAction): Promise<RemoteResult<RuntimePlan>>
  select(source: BashSource): Promise<RemoteResult<RuntimeSelection>>
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
export const parseSource = (value: unknown): BashSource => enumValue(value, ['managed', 'git'] as const)
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
  method('select', { wire: 'source', codec: codec('BashSource', parseSource) }),
  method('execute', { wire: 'id', codec: codec('RuntimePlanId', planId) }, true),
])
export const RUNTIME_REMOTE = Object.freeze({ package: 'dsh-ops', descriptors: RUNTIME_DESCRIPTORS })
