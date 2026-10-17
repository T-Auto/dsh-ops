/**
 * Shared host-side bridge for the native DSH workers.
 *
 * `file` and `ptc` keep deliberately different safety semantics — trusted file operations versus
 * a confined, audited batch runner — so their failure wording and post-parse shaping stay separate.
 * Only the pieces that are byte-for-byte identical across both bridges live here: service discovery,
 * authority resolution, the 2 MiB request budget, the pre-spawn authority recheck, the spawn +
 * stdout/stderr collection cycle, the tool-output JSON renderer, and the shared error-object core.
 * Collapsing these removes the copy-paste drift risk (a policy or budget fix landing in one bridge
 * but not the other) that the previous duplicated `invoke` implementations carried.
 */
import path from 'node:path'
import { encode as toonEncode } from '@toon-format/toon'

const VALID_MODES = ['read-only', 'workspace-write', 'danger-full-access']
const BYTE_BUDGET = 2 * 1024 * 1024

/** Resolve the policy + subprocess services both bridges require, or a failure value. */
export function requireServices(ctx, failure) {
  const policyService = ctx.get('sandboxPolicy')
  const subprocess = ctx.get('subprocess')
  if (!policyService?.resolve || !subprocess?.spawn) {
    return { ok: false, failure: failure('EXECUTOR_UNAVAILABLE', 'DSH policy and subprocess services are required.') }
  }
  return { ok: true, policyService, subprocess }
}

/** Resolve and validate the authoritative DSH policy for a session, or a failure value. */
export function resolveAuthority(policyService, session, failure) {
  let policy
  try { policy = policyService.resolve({ session }) }
  catch (error) { return { ok: false, failure: failure('POLICY_DENIED', String(error?.message ?? error)) } }
  if (!VALID_MODES.includes(policy?.mode) || typeof policy.workspaceRoot !== 'string' || !path.isAbsolute(policy.workspaceRoot)) {
    // Wording unified with the file bridge (was "Invalid authoritative policy." in PTC); identical meaning.
    return { ok: false, failure: failure('POLICY_DENIED', 'Invalid authoritative DSH policy.') }
  }
  return { ok: true, policy }
}

/** Reject if DSH authority changed between resolution and spawn (TOCTOU on the policy). */
export function recheckAuthority(policyService, session, policy, failure) {
  const current = policyService.resolve({ session })
  if (current.mode !== policy.mode || current.workspaceRoot !== policy.workspaceRoot) {
    return failure('POLICY_DENIED', 'Authority changed during preparation.')
  }
  return undefined
}

/** Enforce the 2 MiB request byte budget, or return undefined when within budget. */
export function checkRequestBudget(input, failure) {
  if (Buffer.byteLength(input) > BYTE_BUDGET) return failure('OUTPUT_LIMIT', 'Request exceeds the 2 MiB byte budget.')
  return undefined
}

/**
 * Spawn the native worker and collect its stdout/stderr. `spawned` is true whenever the process
 * started — including when the wait itself fails — so the caller's catch branch can still report a
 * post-spawn failure (RESULT_UNKNOWN) rather than a pre-spawn one (EXECUTOR_UNAVAILABLE / SANDBOX_UNAVAILABLE).
 */
export async function spawnAndCollect(subprocess, argv, cwd, input, signal) {
  const handle = subprocess.spawn({ argv, cwd, stdio: { stdin: { data: input }, stdout: { maxBytes: 128 * 1024 }, stderr: { maxBytes: 16 * 1024 } }, graceMs: 1000, signal })
  try {
    const outcome = await handle.done
    return { spawned: true, outcome, stdout: handle.collected.stdout.readFrom(0), stderr: handle.collected.stderr.readFrom(0) }
  } catch (error) {
    return { spawned: true, error }
  }
}

// TOON columnar encoding collapses repeated object keys, but only pays off for a multi-field object
// list of sufficient size. Thresholds are calibrated to o200k_base measurements of the eight real
// dsh-ops output shapes (2026-10-16): N=1 regresses, N=2 breaks even, N>=3 wins; single-keyed object
// arrays (grep files_with_matches) and flat scalar arrays (glob paths) do not beat JSON at all.
const TOON_MIN_ITEMS = 3
const TOON_MIN_KEYS = 2

/**
 * True only for the shape where TOON reliably costs fewer o200k tokens than JSON: `value.items` is an
 * array of at least TOON_MIN_ITEMS objects that all carry the same at-least-TOON_MIN_KEYS keys (a
 * uniform table). Anything else — flat arrays, single-key objects, ragged keys, small lists — keeps
 * JSON. The final char-length guard is a belt-and-suspenders backstop (no tokenizer is shipped at
 * runtime); the structural gate alone already reproduces every measured real-token decision.
 */
function toonBeatsJson(value, json, toon) {
  const items = value !== null && typeof value === 'object' && !Array.isArray(value) ? value.items : undefined
  if (!Array.isArray(items) || items.length < TOON_MIN_ITEMS) return false
  let keys = null
  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return false
    const itemKeys = Object.keys(item)
    if (keys === null) {
      keys = itemKeys
      if (keys.length < TOON_MIN_KEYS) return false
    } else if (itemKeys.length !== keys.length || itemKeys.some((key, index) => key !== keys[index])) {
      return false // ragged keys: TOON would not use its compact columnar form
    }
  }
  return toon.length < json.length
}

/**
 * Tool-output renderer shared by both contracts. Emits JSON by default and switches to TOON columnar
 * encoding only for the multi-field object-list shape where it is measurably smaller under o200k.
 * Fail-closed: any other shape, or any encode error, returns the exact prior JSON — zero behavior
 * change outside the winning regime, so this stays independently revertable.
 */
export function jsonRender(_args, value) {
  const json = JSON.stringify(value)
  try {
    const toon = toonEncode(value)
    if (toonBeatsJson(value, json, toon)) return [{ type: 'text', text: toon }]
  } catch { /* TOON unavailable or unencodable: keep the exact prior JSON output */ }
  return [{ type: 'text', text: json }]
}

/** Core of every bridge error object: the fields both `file` and `ptc` failures share. */
export function buildError(code, message, { phase, effectState }) {
  return { code, phase, retryable: false, effectState, message }
}
