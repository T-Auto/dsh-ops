/** Add retry/effect facts without changing the host Bash string error contract. */
import type { OpsErrorPayload } from '../kernel/outcome.js'
import type { ShellResult } from './types.js'

/**
 * `STATUS_DLL_INIT_FAILED` (0xC0000142) as an exit code, in both spellings.
 *
 * A Windows child that cannot load its own DLLs dies before `main()` and the platform reports the
 * NTSTATUS as the process exit code: 3221225794 unsigned, -1073741502 when the host hands the value
 * back as a signed 32-bit integer. The command text never ran, so the shell prints nothing at all —
 * which is what makes the generic "correct the command and retry" advice wrong (#417).
 */
const DLL_INIT_FAILED_EXIT_CODES: ReadonlySet<number> = new Set([3221225794, -1073741502])

/**
 * The exit code of a loader failure, when nothing else explains the failure first.
 *
 * Only a bare exit code qualifies: an explicit `error`, a restriction, a permission refusal, a
 * signal, a timeout or a cancellation each keep their own, more specific classification. `0xC0000142`
 * is used as an NTSTATUS by every Windows process, so it means the same thing under any sandbox
 * mode; the remedy differs, which is why the message names the condition instead of guessing one.
 * @param {import('./types.js').ShellResult} value - the settled result, before `status`.
 * @returns {number|undefined} the observed exit code, or `undefined` when this is not a loader failure.
 */
function dllInitExitCode(value: ShellResult): number | undefined {
  const exit = value.exitCode
  if (typeof exit !== 'number' || !Number.isSafeInteger(exit) || !DLL_INIT_FAILED_EXIT_CODES.has(exit)) return undefined
  if (value.error !== undefined || value.restriction !== undefined || value.permission !== undefined
    || value.signal != null || value.timedOut === true || value.cancelled === true) return undefined
  return exit
}

export function bashFailure(value: ShellResult, effectState: 'none' | 'unknown'): OpsErrorPayload {
  const loader = dllInitExitCode(value)
  const message = value.error ?? value.restriction?.message ?? value.permission?.message
    ?? (loader !== undefined
      ? `The process could not initialise its DLLs (exit code ${loader} = 0x${(loader >>> 0).toString(16).toUpperCase().padStart(8, '0')} STATUS_DLL_INIT_FAILED), so no command ran.`
      : value.timedOut ? 'Command timed out.' : value.cancelled ? 'Command cancelled.' : `Command exited with ${value.exitCode ?? value.signal ?? 'unknown status'}.`)
  const argument = message.startsWith('INVALID_BASH_ARGUMENT:')
  // A normally exited command has a known terminal status, not an unknown execution outcome.
  // Its side effects are still opaque: a command can write successfully before returning nonzero.
  const exited = loader === undefined && Number.isSafeInteger(value.exitCode) && value.exitCode !== 0 && value.signal == null
    && value.error === undefined && value.restriction === undefined && value.permission === undefined
    && value.timedOut !== true && value.cancelled !== true
  // A loader failure is the executor's, not the command's: reuse the code the same class of failure
  // already carries when the shell prints its Win32 text, so one taxonomy answers both shapes.
  const code = argument ? 'INVALID_BASH_ARGUMENT' : value.timedOut ? 'TIMEOUT' : value.cancelled ? 'CANCELLED'
    : value.restriction?.code ?? value.permission?.code
      ?? (loader !== undefined ? 'EXECUTOR_UNAVAILABLE' : exited ? 'EXIT_CODE' : (/^([A-Z][A-Z_]+):/.exec(message)?.[1]) ?? 'COMMAND_FAILED')
  return { code, message, effectState, retry: exited || (argument && effectState === 'none') ? 'after-input-change' : 'never',
    nextAction: loader !== undefined
      ? 'This is a Windows loader or sandbox-token condition, not a command result: no command ran, so editing the command or its arguments cannot change it. Repair the shell runtime or the DSH sandbox before another call, and do not repeat this command in the same mode.'
      : exited ? 'Inspect the exit code and output, then correct the command or its inputs before retrying. Prior side effects may remain.'
      : effectState === 'unknown' ? 'Do not repeat the command. Inspect its effects with a read-only operation first.'
      : argument ? 'Correct the named argument before submitting another call.'
        : 'No command effects were applied. Resolve the reported authority or runtime condition before another call; do not bypass a rejection.' }
}
