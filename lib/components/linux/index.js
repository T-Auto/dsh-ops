/** dsh-ops Linux host component. Same worker and bash as Windows, resolved for Linux. */
import { applyComponent } from '../../index.js'

export const name = 'dsh-ops-linux'

/**
 * Reject a config value this component cannot honour, naming the key.
 *
 * The Linux component owns exactly the keys it reads. It deliberately has no
 * `binaryPath` (the worker is resolved from the installed package), no
 * `shellPolicy` (the host shell denial belongs to the Windows shell component),
 * and no background or PTC keys (those are their own opt-in components).
 * @param {unknown} raw - the `config` value from the loader row.
 * @returns {object} the validated config.
 */
export function resolveLinuxConfig(raw) {
  if (raw === undefined || raw === null) raw = {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Linux config must be an object, got ${JSON.stringify(raw)}`)
  const known = ['bashPath', 'publishBashTool', 'allowSystemShellFallback', 'denyCredentialReads', 'promptPolicy', 'required', 'extraGuidance', 'configUpdateVersion']
  const unknown = Object.keys(raw).filter(key => !known.includes(key))
  if (unknown.length > 0) throw new Error(`Unknown Linux config key(s): ${unknown.join(', ')}; accepted keys are ${known.join(', ')}`)
  if (raw.bashPath !== undefined && typeof raw.bashPath !== 'string') throw new Error('bashPath must be a string')
  for (const key of ['publishBashTool', 'allowSystemShellFallback', 'denyCredentialReads', 'promptPolicy', 'required']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') throw new Error(`${key} must be boolean`)
  }
  if (raw.extraGuidance !== undefined && typeof raw.extraGuidance !== 'string') throw new Error('extraGuidance must be a string')
  if (raw.configUpdateVersion !== undefined && (!Number.isSafeInteger(raw.configUpdateVersion) || raw.configUpdateVersion < 0)) {
    throw new Error('configUpdateVersion must be a non-negative safe integer')
  }
  return raw
}

export function apply(ctx, config) {
  if (process.platform !== 'linux') throw new Error('dsh-ops-linux only loads on Linux; Windows uses the shell and file components.')
  resolveLinuxConfig(config)
  // Mounting this beside the shell component is supported and deliberately
  // harmless: the tool registry keys by name, so the duplicate registration
  // collapses to one `ops_bash` and one set of file tools (asserted in
  // `test/linux.test.mjs`). The component stays the single switch a Linux
  // deployment needs, and an operator who also runs the Windows shell row does
  // not get two shells.
  return applyComponent(ctx, config, 'linux')
}
