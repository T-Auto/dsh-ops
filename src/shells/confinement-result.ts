/** Observed confinement diagnostics; these do not establish command effect state. */
import type { ConfinedArgv } from '../adapter/dsh/types.js'
import type { ShellPolicy, ShellResult } from './types.js'
import { executionRestriction } from '../permissions.js'
import { withBashStatus } from './tool.js'

export function confinementResult(value: ShellResult, policy: ShellPolicy, confinement?: ConfinedArgv) {
  const stderr = `${value.stderr?.text ?? ''}\n${value.error ?? ''}`
  const runnerFailed = value.exitCode !== 0 && confinement?.runnerFailureRules?.some(rule =>
    (!rule.allowedExitCodes || (value.exitCode != null && rule.allowedExitCodes.includes(value.exitCode))) &&
    stderr.split(/\r?\n/).filter(line => !rule.informationalLines?.some(info => info.toLowerCase() === line.toLowerCase()))
      .some(line => rule.fatalSignatures?.some(signature => line.toLowerCase().includes(signature.toLowerCase()))))
  const unavailable = runnerFailed || /couldn't create signal pipe|fatal error.*win32 error|sandbox_unavailable/i.test(stderr)
  const denied = !unavailable && value.exitCode !== 0 && confinement?.denialSignatures?.some(signature => stderr.toLowerCase().includes(signature.toLowerCase()))
  return withBashStatus({ ...value,
    ...(unavailable ? { error: 'EXECUTOR_UNAVAILABLE: the sandbox runtime failed before the command ran; this is not a user authorization denial. Restore the runtime or confinement provider; changing the DSH selector is not a repair. Do not bypass confinement.' } : {}),
    ...(denied ? { restriction: executionRestriction('command file effects') } : {}),
    sandbox: { mode: policy.mode, denied: denied === true,
      ...(confinement ? { enforcement: confinement.enforcement } : {}), ...(unavailable ? { runnerFailed: true } : {}) },
  })
}
