import type { Context } from '@deepseek-ai/cordis'
import { applyComponent } from '../../index.js'
import { mountRuntimeSettings } from '../../settings/runtime-host.js'
import { resolveConfig } from '../../config.js'
import { editable, settingsConfig, configObject } from '../../settings/schema.js'
export const name = 'dsh-ops-bash & host PowerShell'
// Shared core validator compatibility keys do not configure the shell row's settings form.
export const NON_EDITABLE_CONFIG_KEYS = ['configUpdateVersion', 'binaryPath', 'required', 'denyCredentialReads', 'serverName', 'enableShellTools', 'toolCallTimeoutMs'] as const
export const Config = settingsConfig(value => {
  const raw = configObject(value ?? {}), validated = resolveConfig(raw)
  // Keep raw ordinary keys: applyComponent owns normalization and migration.
  return { ...raw, publishBashTool: validated.publishBashTool }
}, {
  bashPath: editable('string', 'Absolute Bash executor path. Remove the override to select the optional managed installation.'),
  publishBashTool: editable('boolean', 'Publish Bash for authorized sessions.'),
  shellPolicy: editable('string', 'Use advise or deny-host-shell for host shell routing.'),
  deniedHostTools: editable('array', 'Host tool names denied by deny-host-shell policy.', { type: 'string' }),
  promptPolicy: editable('boolean', 'Publish tool routing guidance.'),
  extraGuidance: editable('string', 'Additional tool routing guidance.'),
  allowSystemShellFallback: editable('boolean', 'Allow ambient system Bash when no managed installation is available.'),
})
export function apply(ctx: Context, config: unknown): void {
  applyComponent(ctx, config, 'shell')
  mountRuntimeSettings(ctx)
}
