/**
 * The private temporary directory one session may write through the file tools.
 *
 * The host sandbox grants the whole system temporary directory to
 * workspace-write on Linux (Landlock's read-write list is `["/dev/null", "/tmp",
 * workspaceRoot]`), so the OS will let a confined command touch another
 * session's temporary files. The plugin cannot change that grant, but it does
 * not have to endorse it: the write fence the file tools enforce is narrower
 * than the one the kernel applies, and every session gets its own directory
 * below the system temp root.
 *
 * The name is derived from the session id, so the same session keeps the same
 * directory across calls and two sessions cannot address each other's. It is
 * created lazily, on the first write the fence allows, and never deleted by the
 * plugin: a later call in the same session may still expect it.
 *
 * @module dsh-ops/session-temp
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

/** The prefix every session directory shares, so an operator can find and prune them. */
export const SESSION_TEMP_PREFIX = 'dsh-ops-session-'

/**
 * The directory this session owns below the system temporary root.
 * @param {string} sessionId - the authoritative session identity.
 * @param {string} [tempRoot] - the system temporary root; defaults to `os.tmpdir()`.
 * @returns {string} the absolute path.
 */
export function sessionTempDir(sessionId, tempRoot = tmpdir()) {
  const root = tempRoot
  const candidate = path.join(root, `${SESSION_TEMP_PREFIX}${createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 16)}`)
  // A path the platform cannot address is worse than a shared directory: a
  // session whose id produces an over-long name falls back to the temporary
  // root the host sandbox already grants, rather than failing every write.
  const limit = process.platform === 'win32' ? 200 : 4096
  return candidate.length > limit ? root : candidate
}

/**
 * Create the session's directory if it is missing.
 *
 * A directory that cannot be created is reported as a denied write rather than
 * an exception: the caller's fence has already decided the write is allowed,
 * and the failure to provide the one place it may go is the operator's answer
 * to give, not a crash.
 * @param {string} directory - the absolute directory.
 * @returns {{ok: true}|{ok: false, message: string}} the outcome.
 */
export function ensureSessionTemp(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    return { ok: true }
  } catch (error) {
    return { ok: false, message: `could not create the session temporary directory ${directory}: ${String(error?.message ?? error)}` }
  }
}
