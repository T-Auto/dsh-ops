/**
 * Why the private restricted Bash runtime could not be prepared, as a
 * distinguishable failure (#512).
 *
 * `confinedBash` has always known the difference between five conditions: the
 * pinned payload layout is missing, the IPC compatibility receipt does not match
 * this installation, a staging copy was interrupted or refused, an unverifiable
 * generation could not be quarantined, and the cache lifecycle lock was left by
 * a process that died. Before this module the session layer wrapped every one of
 * them in one parameterless `catch` and replaced the reason with a single
 * paragraph that ended "Do not retry" — so a caller could neither tell an
 * unfixable payload from a recoverable staging interruption nor learn what to do
 * about either. The staging path is deliberately recoverable (`bash-ipc.ts`:
 * verify → quarantine → stage again), so telling the model not to retry was wrong
 * for exactly the failures that a retry repairs.
 *
 * The message keeps the `EXECUTOR_UNAVAILABLE:` prefix because the host shell
 * contract derives `failure.code` from that prefix (`shells/failure.ts`); the
 * sub-reason is a second segment so the caller can see which stage failed without
 * changing that contract.
 *
 * @module dsh-ops/bash-runtime-failure
 */

import { errorMessage } from './shells/types.js'

/**
 * The named stages a confined-Bash preparation can fail at.
 *
 * The names are part of the model-facing text, so they are stable and lowercase,
 * matching the sub-reason vocabulary the issue asked for (#512).
 */
export type BashRuntimeFailureCode =
  /** The pinned MSYS payload layout (or its `msys-2.0.dll`) is missing. */
  | 'bash-runtime-missing'
  /** The resolved bash is not the pinned MSYS build restricted modes can run. */
  | 'bash-runtime-incompatible'
  /** The payload and this installation's IPC compatibility receipt disagree. */
  | 'bash-ipc-mismatch'
  /** Copying, verifying or publishing the private generation did not complete. */
  | 'bash-staging-failed'
  /** An unverifiable generation exists but could not be moved aside. */
  | 'bash-generation-quarantine-failed'
  /** The cache lifecycle lock is held, or was left by an interrupted process. */
  | 'bash-lifecycle-lock-busy'
  /** The cache path itself is unusable (a link, or not a directory). */
  | 'bash-cache-unusable'

/** One classified preparation failure: an `Error` carrying its stage. */
export interface BashRuntimeFailure extends Error {
  readonly code: BashRuntimeFailureCode
}

/**
 * What to tell the caller once a stage has failed.
 *
 * `retryable` is not serialized anywhere: the host output contract for
 * `failure.retry` only accepts `never` / `after-input-change`
 * (`shells/host-contract.ts`), and a staging interruption is a state change the
 * next call repairs by itself. The advice therefore lives in the message, where
 * the model reads it, instead of widening a contract this issue does not own.
 */
interface FailureRemedy {
  /** Whether another call can plausibly complete the preparation. */
  retryable: boolean
  /** The actionable sentence appended to the model-facing message. */
  remedy: string
}

/** The one remedy per stage. Every sentence says whether a retry helps and what to do when it does not. */
const REMEDIES: Readonly<Record<BashRuntimeFailureCode, FailureRemedy>> = Object.freeze({
  'bash-runtime-missing': {
    retryable: false,
    remedy: 'Restore the pinned Bash payload from the profile dependencies, or run '
      + '`dsh-ops provision-shells --bash` to fetch it; retrying this call cannot create a missing payload.',
  },
  'bash-runtime-incompatible': {
    retryable: false,
    remedy: 'This is a configuration problem, not a transient failure; retrying repeats it unchanged.',
  },
  'bash-ipc-mismatch': {
    retryable: false,
    remedy: 'Reinstall the pinned payload and this installation\'s IPC compatibility proxies; a retry cannot repair '
      + 'a verified receipt mismatch, and changing the DSH selector is not a repair.',
  },
  'bash-staging-failed': {
    retryable: true,
    remedy: 'Retry this call once: the next attempt stages a fresh private copy automatically. If it fails again, '
      + 'run `dsh-ops bash-runtime clean-cache --yes --all-hosts-stopped` while no confined shell is running, '
      + 'then retry. Do not switch shells to bypass confinement.',
  },
  'bash-generation-quarantine-failed': {
    retryable: true,
    remedy: 'Stop any confined shell that may still use the previous generation, then retry: the next call '
      + 'quarantines it and stages a fresh one. Do not delete a generation while a confined shell is running.',
  },
  'bash-lifecycle-lock-busy': {
    retryable: false,
    remedy: 'Retrying does not repair this: the lock is never stolen from an owner that may still be alive. '
      + 'Stop every OPS host and confined Bash, run `dsh-ops bash-runtime clean-cache --yes --all-hosts-stopped`, '
      + 'then retry.',
  },
  'bash-cache-unusable': {
    retryable: false,
    remedy: 'Inspect the cache path and remove the link or file manually after stopping all confined shells; '
      + 'the runtime never follows a link and never falls back to an unconfined shell.',
  },
})

/** Whether a value names one of the stages above. */
function isFailureCode(value: unknown): value is BashRuntimeFailureCode {
  return typeof value === 'string' && Object.hasOwn(REMEDIES, value)
}

/**
 * Build one classified failure.
 *
 * `cause` keeps the underlying filesystem error available to logs and tests
 * without flattening it into the message twice.
 * @param code - the stage that failed.
 * @param message - the concrete condition, without the `EXECUTOR_UNAVAILABLE:` prefix.
 * @param options.cause - the original error, if this wraps one.
 * @returns an `Error` whose `code` is the stage.
 */
export function bashRuntimeFailure(code: BashRuntimeFailureCode, message: string, { cause }: { cause?: unknown } = {}): BashRuntimeFailure {
  const failure = new Error(message, cause === undefined ? undefined : { cause }) as Error & { code: BashRuntimeFailureCode }
  failure.code = code
  return failure
}

/**
 * The stage of a thrown value, when it carries one.
 *
 * Duck-typed rather than `instanceof` so a failure that crossed a module
 * boundary (a second copy of this module, a serialized error) is still reported
 * as the condition it is.
 * @param error - the thrown value.
 * @returns the stage, or `undefined` for an unclassified error.
 */
export function bashRuntimeFailureCode(error: unknown): BashRuntimeFailureCode | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return isFailureCode(code) ? code : undefined
}

/**
 * The model-facing `EXECUTOR_UNAVAILABLE` text for one preparation failure.
 *
 * Three shapes are kept apart on purpose:
 * · `bash-runtime-incompatible` already owns a complete, actionable message
 *   (`restrictedRemedy` in `bash-ipc.ts`), so it is passed through unchanged —
 *   re-wrapping it lost the "which bash, why, what to change" facts before.
 * · Every other classified stage gets its name and its own remedy.
 * · An unclassified error keeps its original message and makes no claim about
 *   retryability, which is the honest answer when the stage is unknown.
 * @param error - what `confinedBash` (or the lifecycle lock) raised.
 * @returns the message the caller sees.
 */
export function executorUnavailableMessage(error: unknown): string {
  const code = bashRuntimeFailureCode(error)
  const reason = errorMessage(error)
  if (code === 'bash-runtime-incompatible') return reason
  if (code !== undefined) {
    return `EXECUTOR_UNAVAILABLE: ${code}: ${reason} ${REMEDIES[code].remedy}`
  }
  return 'EXECUTOR_UNAVAILABLE: the restricted Bash runtime could not be prepared: '
    + `${reason}. No command was executed. If this was a transient filesystem refusal, one retry may complete the `
    + 'private copy; do not switch shells to bypass confinement.'
}

/**
 * Whether the failure is one this code considers recoverable by another call.
 * Kept exported so a future retry decision has one source of truth; nothing
 * retries automatically today, because the repository forbids retries that hide
 * a flaky cause (AGENTS.md, hard rule 4).
 * @param error - the thrown value.
 * @returns `true` only for a classified, retryable stage.
 */
export function isRetryableBashRuntimeFailure(error: unknown): boolean {
  const code = bashRuntimeFailureCode(error)
  return code !== undefined && REMEDIES[code].retryable
}
