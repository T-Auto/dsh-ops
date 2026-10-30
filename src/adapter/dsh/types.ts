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
export type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
export type { SubprocessHandle, SubprocessOutputRead, SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
export type { InvocationDescriptor, RemoteResult, TypertCodec, TypertGatewayBinding } from '@deepseek-ai/dsh-typert-protocol'
export type { JsonSchemaNode, JsonSchemaType, ObjectJsonSchema, ToolDefinition, ToolExecution,
  ToolExecutionResult, ToolExecutionToken, ToolGuard, ToolPresentationMode, ToolRunContext } from '@deepseek-ai/dsh-tools'
export type { default as ToolRuntime } from '@deepseek-ai/dsh-tools'
export type { ConfinedArgv, RunnerFailureRule, SandboxExecutionPolicy, SandboxMode, SandboxProvider } from '@deepseek-ai/dsh-sandbox'
// Compile-time types come from the pinned devDependency; the running Host stopped
// shipping .d.ts with these names, so the contract itself is verified against the
// running distribution's own Plugins-page documentation, not against this import.
export type {
  ConfigPageForm, PluginConfigViewProps, PluginDetailProps, PluginPackageRef, PluginRowRef, PluginsSubject,
} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
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