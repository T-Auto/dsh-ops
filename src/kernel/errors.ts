import type { EffectState, FailureStatus, RetryPolicy } from './outcome.js'

export interface ErrorPolicy { readonly status: FailureStatus, readonly retry: RetryPolicy }
const policy = (status: FailureStatus, retry: RetryPolicy): ErrorPolicy => Object.freeze({ status, retry })
const rejected = policy('rejected', 'never')
const invalid = policy('error', 'after-input-change')
const changed = policy('error', 'after-state-change')
const settled = policy('error', 'never')
const unknown = policy('unknown', 'never')

/** Stable native/host codes retain their spelling. This table does not change current wire errors. */
export const ERROR_POLICIES: Readonly<Record<string, ErrorPolicy>> = Object.freeze({
  POLICY_DENIED: rejected,
  PUBLICATION_DENIED: rejected,
  CREDENTIAL_DENIED: rejected,
  PATH_RESTRICTED: rejected,
  REVISION_CONFLICT: policy('conflict', 'after-state-change'),
  INVALID_ARGUMENT: invalid,
  EDIT_CONFLICT: invalid,
  SEARCH_STALE: invalid,
  NOT_FOUND: invalid,
  IS_DIRECTORY: invalid,
  OUTPUT_LIMIT: invalid,
  CROSS_DEVICE: invalid,
  ERR_INVALID_ENCODING: invalid,
  TABLE_PARSE_ERROR: invalid,
  DOCUMENT_PARSE_ERROR: invalid,
  // Explicit exception, documented here because the Bash contract differs from the generic rule:
  // a command that ran to completion and exited nonzero keeps `effectState: 'unknown'` (a write
  // may have succeeded before the exit) yet reports `retry: 'after-input-change'` (inspect the
  // exit code and output, correct the command or its inputs, then run it again). The producer is
  // `src/shells/failure.ts`, which applies the exception when it emits `EXIT_CODE`; this entry
  // records the code's intended advice so it stays discoverable and cannot be reclassified by
  // accident. The exception is narrow: timeouts, cancellation, signal death, permission/policy
  // refusals and spawn/runtime failures keep their own codes and never become `EXIT_CODE`.
  // Effects still dominate inside `errorPolicy`, so an `EXIT_CODE` lookup with
  // `effectState: 'unknown'` still answers `unknown`/`never`; only the Bash failure payload
  // carries the exception.
  EXIT_CODE: invalid,
  UNSUPPORTED_DOCUMENT: settled,
  FILE_CHANGED: changed,
  REFERENCE_EXPIRED: changed,
  AUTHORITY_CHANGED: changed,
  ACCESS_DENIED: changed,
  EXECUTOR_UNAVAILABLE: changed,
  JOB_BUSY: policy('error', 'bounded-transient'),
  CALL_LIMIT: policy('error', 'after-state-change'),
  CANCELLED: settled,
  METADATA_UNSUPPORTED: settled,
  LOCK_UNSUPPORTED: settled,
  PATH_CHANGED: changed,
  IO_ERROR: settled,
  SYNC_FAILED: settled,
  CLEANUP_FAILED: settled,
  RESULT_PARTIAL: settled,
  EXECUTION_RESTRICTED: unknown,
  RESULT_UNKNOWN: unknown,
})

/** Effects dominate retry advice: a failed receipt never licenses replaying a possible write. */
export function errorPolicy(code: string, effectState: EffectState = 'none'): ErrorPolicy {
  if (effectState === 'unknown' || code === 'RESULT_UNKNOWN' || code === 'EXECUTION_RESTRICTED') return unknown
  if (effectState !== 'none') return settled
  return Object.hasOwn(ERROR_POLICIES, code) ? ERROR_POLICIES[code]! : settled
}
