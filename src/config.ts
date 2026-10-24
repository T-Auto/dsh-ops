/**
 * Plugin configuration: one plain object read from the `dsh-ops` row in
 * `cordis.yml`, validated here.
 *
 * Validation uses plain data and Standard Schema without host value imports. This host half must
 * resolve with no `@deepseek-ai/*` value import of its own (the profile loader
 * supplies those names, and every extra one is another way for the plugin to
 * fail to load). Validation is therefore explicit and fails loud, naming the
 * offending key, which is what the loader's own schema would have done.
 *
 * @module dsh-ops/config
 */


/**
 * Keys only the removed FastCtx surface read. Existing rows still carry them
 * (the bundle patch wrote `enableShellTools` and `toolCallTimeoutMs` into every
 * file row), so they stay accepted and type-checked, are never returned, and
 * config update 2 removes them from saved rows (`lib/config-updates.js`).
 */
export const LEGACY_FASTCTX_KEYS = Object.freeze(['serverName', 'enableShellTools', 'toolCallTimeoutMs'])
export const CORE_CONFIG_KEYS = Object.freeze([
  ...LEGACY_FASTCTX_KEYS, 'binaryPath', 'required', 'shellPolicy', 'deniedHostTools', 'promptPolicy',
  'extraGuidance', 'bashPath', 'publishBashTool', 'allowSystemShellFallback', 'denyCredentialReads', 'configUpdateVersion',
])

/** Upper bound accepted for the legacy `toolCallTimeoutMs`, matching the loader's timer ceiling. */
const MAX_TOOL_CALL_TIMEOUT_MS = 2_147_483_647

/** How the plugin treats the host's own shell tools. */
export const SHELL_POLICIES = ['advise', 'deny-host-shell']

/** Host tool names the `deny-host-shell` policy refuses by default. */
export const DEFAULT_DENIED_HOST_TOOLS = ['pwsh', 'bash', 'pwsh_persistent']

import { ConfigError } from './config-error.js'
export { ConfigError } from './config-error.js'

/**
 * Reject a key the plugin does not implement instead of silently ignoring it.
 * @param {Record<string, unknown>} raw - the whole row config.
 * @param {string[]} known - accepted keys.
 * @returns {void}
 */
function rejectUnknownKeys(raw: Record<string, unknown>, known: readonly string[]): void {
  const unknown = Object.keys(raw).filter((key) => !known.includes(key))
  if (unknown.length > 0) {
    throw new ConfigError(
      `unknown key(s) ${unknown.map((key) => JSON.stringify(key)).join(', ')}; `
      + `accepted keys are ${known.map((key) => JSON.stringify(key)).join(', ')}`,
    )
  }
}

/**
 * Read an optional string.
 * @param {Record<string, unknown>} raw - the whole row config.
 * @param {string} key - the key to read.
 * @returns {string|undefined} the value, or undefined when absent.
 */
function optionalString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${key} must be a non-empty string, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Read an optional boolean.
 * @param {Record<string, unknown>} raw - the whole row config.
 * @param {string} key - the key to read.
 * @param {boolean} fallback - the value when the key is absent.
 * @returns {boolean} the value.
 */
function optionalBoolean(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${key} must be a boolean, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Read an optional list of non-empty strings.
 * @param {Record<string, unknown>} raw - the whole row config.
 * @param {string} key - the key to read.
 * @param {string[]} fallback - the value when the key is absent.
 * @returns {string[]} the value.
 */
function optionalStringList(raw: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new ConfigError(`${key} must be an array of non-empty strings, got ${JSON.stringify(value)}`)
  }
  return [...value]
}

/** The resolved configuration, with every default applied. */
export interface ResolvedConfig {
  configUpdateVersion: number
  binaryPath: string | undefined
  required: boolean
  denyCredentialReads: boolean
  shellPolicy: 'advise' | 'deny-host-shell'
  deniedHostTools: string[]
  promptPolicy: boolean
  extraGuidance: string
  bashPath: string | undefined
  publishBashTool: boolean
  allowSystemShellFallback: boolean
}

/**
 * Validate one plugin row's config.
 * @param {unknown} rawConfig - the `config` value from the loader row.
 * @returns {ResolvedConfig} the resolved configuration.
 */
export function resolveConfig(rawConfig?: unknown): ResolvedConfig {
  if (rawConfig === undefined || rawConfig === null) rawConfig = {}
  if (typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new ConfigError(`config must be an object, got ${JSON.stringify(rawConfig)}`)
  }
  const raw = rawConfig as Record<string, unknown>
  rejectUnknownKeys(raw, CORE_CONFIG_KEYS)

  const configUpdateVersion = raw.configUpdateVersion ?? 0
  if (typeof configUpdateVersion !== 'number' || !Number.isSafeInteger(configUpdateVersion) || configUpdateVersion < 0) {
    throw new ConfigError('configUpdateVersion must be a non-negative safe integer')
  }

  // Legacy FastCtx keys: validated exactly as before so a malformed row still fails loud, then dropped.
  const serverName = optionalString(raw, 'serverName')
  if (serverName !== undefined && !/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) {
    throw new ConfigError(`serverName must match [A-Za-z0-9_-]{1,32}, got ${JSON.stringify(serverName)}`)
  }
  optionalBoolean(raw, 'enableShellTools', true)
  const timeout = raw.toolCallTimeoutMs
  if (timeout !== undefined && timeout !== null
    && (!Number.isFinite(timeout) || Number(timeout) <= 0 || Number(timeout) > MAX_TOOL_CALL_TIMEOUT_MS)) {
    throw new ConfigError(
      `toolCallTimeoutMs must be a positive finite number of milliseconds, got ${JSON.stringify(timeout)}`,
    )
  }

  const shellPolicy = optionalString(raw, 'shellPolicy') ?? 'advise'
  if (!SHELL_POLICIES.includes(shellPolicy)) {
    throw new ConfigError(
      `shellPolicy must be one of ${SHELL_POLICIES.map((value) => JSON.stringify(value)).join(', ')}, `
      + `got ${JSON.stringify(shellPolicy)}`,
    )
  }

  return {
    configUpdateVersion,
    binaryPath: optionalString(raw, 'binaryPath'),
    required: optionalBoolean(raw, 'required', false),
    shellPolicy: shellPolicy as ResolvedConfig['shellPolicy'],
    deniedHostTools: optionalStringList(raw, 'deniedHostTools', DEFAULT_DENIED_HOST_TOOLS),
    promptPolicy: optionalBoolean(raw, 'promptPolicy', true),
    extraGuidance: optionalString(raw, 'extraGuidance') ?? '',
    bashPath: optionalString(raw, 'bashPath'),
    publishBashTool: optionalBoolean(raw, 'publishBashTool', true),
    // There is deliberately no `pwshPath`: the host owns its PowerShell
    // selection. Ambient bash discovery requires explicit operator opt-in.
    allowSystemShellFallback: optionalBoolean(raw, 'allowSystemShellFallback', false),
    // The file tools refuse credential locations by default. An operator who
    // needs one of them can turn the fence off for this row; the environment
    // variable only ever widens the list, so a model cannot open it.
    denyCredentialReads: optionalBoolean(raw, 'denyCredentialReads', true),
  }
}

export { resolveHidingConfig } from './official-tool-config.js'

/** Independent PTC row configuration uses the same central validation entry point. */
export { parsePtcConfig as resolvePtcConfig } from './ptc/config.js'
export { resolveDiscoveryConfig } from './discovery/config.js'

