/**
 * The only source-level boundary to DSH product APIs.
 *
 * OPS owns its kernels and contracts; this module is the product adapter's type
 * surface. It contains type-only exports, so importing OPS never evaluates a
 * DSH package at load time. Runtime host lookups belong in host.ts.
 */
export type { Context, Fiber } from '@deepseek-ai/cordis'
export type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
export type { Agent } from '@deepseek-ai/dsh-agent'
export type { FileSystem, FsTarget, FsInfo, FsObservation } from '@deepseek-ai/dsh-fs'
export type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
export type { Session } from '@deepseek-ai/dsh-session'
export type { SettingsPathOpView } from '@deepseek-ai/dsh-settings/types'
export type { AssembleContext, PromptAssembly, SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
/**
 * The waterfall's presentation shape, declared structurally. The rc2 line only
 * ships `PromptAssembly` (sections, contexts, variables and the tool array in one
 * interface), while DSH 0.2.2 splits the presentation from the assembly and
 * attaches tools after the waterfall. Both satisfy these fields, so assemble-path
 * code that judges sections and contexts compiles against either end of the
 * declared host range without importing a version-specific name.
 */
export interface PromptPresentation {
  sections: ReadonlyArray<{ name: string; text: string }>
  contexts: readonly unknown[]
  variables: Record<string, string | undefined>
}
export type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
export type { SubprocessHandle, SubprocessOutputRead, SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
export type { InvocationDescriptor, RemoteResult, TypertCodec, TypertGatewayBinding } from '@deepseek-ai/dsh-typert-protocol'
export type { JsonSchemaNode, JsonSchemaType, ObjectJsonSchema, ToolDefinition, ToolExecution,
  ToolExecutionResult, ToolExecutionToken, ToolGuard, ToolRunContext } from '@deepseek-ai/dsh-tools'
export type { default as ToolRuntime } from '@deepseek-ai/dsh-tools'
export type { ConfinedArgv, RunnerFailureRule, SandboxExecutionPolicy, SandboxMode, SandboxProvider } from '@deepseek-ai/dsh-sandbox'
export type { ConfigPageForm, PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
export type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
export type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
export type * as Atomic from '@deepseek-ai/dsh-atomic-write'
export type * as Boot from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-config-editor'
import type {} from '@deepseek-ai/dsh-typert-registry'

/** Narrow runtime shapes consumed by the profile carrier. */
export type BootApi = Pick<typeof import('@deepseek-ai/dsh-app-boot'),
  'loadProfileDirectory' | 'composeEntries' | 'readProfilePatches' | 'resolveBundleDir' | 'loadOverlayPatches' | 'readProfilePlugins'>
export type AtomicApi = Pick<typeof import('@deepseek-ai/dsh-atomic-write'), 'withFileLock' | 'writeFileAtomic'>