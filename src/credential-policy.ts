/**
 * Credential locations the file tools refuse to touch.
 *
 * DSH's own filesystem layer does not fence these paths, so a tool that can
 * access any OS-readable file could hand a model the operator's API tokens and
 * private keys. The plugin's file surface is narrower than a general reader on
 * purpose: it is a repository tool, and none of its jobs need a credential file.
 *
 * The fence is on the PATH, not on one direction of access. A credential
 * location is refused as a read (a single path, a batch operation root, and every
 * child of a recursion), a write/edit/replace/remove target, or a copy/move
 * destination, including under danger-full-access. The key remains named
 * `denyCredentialReads` for compatibility: only its name is read-only.
 *
 * @module dsh-ops/credential-policy
 */
import fs from 'node:fs'
import path from 'node:path'

/** Environment variable naming extra denied paths, separated by the platform delimiter. */
export const DENY_ENV = 'DSH_OPS_DENY_READ'

export interface CredentialOptions { home?: string; env?: NodeJS.ProcessEnv }
export type CredentialVerdict = { denied: true; matched: string } | { denied: false }

/**
 * Credential files and directories, as path suffixes below the user's home.
 *
 * A suffix is matched on whole path components, case-insensitively, so
 * `~/.ssh/id_ed25519` is denied by `~/.ssh` and a file merely named
 * `ssh-notes.txt` is not.
 * @type {readonly string[]}
 */
export const CREDENTIAL_SUFFIXES = Object.freeze([
  '.ssh',
  '.aws',
  '.azure',
  '.config/gcloud',
  '.kube',
  '.docker/config.json',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.npmrc',
  '.pypirc',
  '.dsh/.credentials.yaml',
  '.dsh/.credentials.yml',
])

/** The subset of the list that names a directory, used to skip traversals. */
const CREDENTIAL_DIR_SUFFIXES = Object.freeze([
  '.ssh',
  '.aws',
  '.azure',
  '.config/gcloud',
  '.kube',
])

/** Components that name a private key or a credential store wherever they live. */
const CREDENTIAL_NAMES = Object.freeze([
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i,
  /(^|\/)[^/]*credentials[^/]*\.(json|ya?ml|ini)$/i,
  /(^|\/)service-account[^/]*\.json$/i,
  /(^|\/)\.env(\.|$)/i,
])

/** Extra suffixes from the environment, resolved once per call so a deployment can add its own. */
function configuredSuffixes(env: NodeJS.ProcessEnv): string[] {
  const raw = env?.[DENY_ENV]
  if (typeof raw !== 'string' || raw.trim() === '') return []
  return raw.split(path.delimiter).map(entry => entry.trim()).filter(entry => entry !== '')
}

/**
 * The extra denied locations from the environment, as `[comparisonForm, label]` pairs.
 *
 * An absolute entry is used as written; a relative one is resolved below the home.
 * Absolute entries work without a home. Labels stay internal and are never included in refusals.
 * @param {NodeJS.ProcessEnv} env - the environment to read.
 * @param {string|undefined} resolvedHome - the home directory for relative entries.
 * @returns {Array<[string, string]>} the comparison form and the entry as written.
 */
function configuredRoots(env: NodeJS.ProcessEnv, resolvedHome: string | undefined): Array<[string, string]> {
  const roots: Array<[string, string]> = []
  for (const entry of configuredSuffixes(env)) {
    if (path.isAbsolute(entry)) { roots.push([canonical(entry), entry]); continue }
    if (typeof resolvedHome === 'string' && resolvedHome !== '') roots.push([canonical(path.join(resolvedHome, entry)), entry])
  }
  return roots
}

/**
 * Canonicalize a path for comparison: absolute, symlink-resolved where it
 * exists, and separator-normalized. A path that cannot be resolved is compared
 * as written, so a missing target is still matched by suffix.
 * @param {string} value - the path.
 * @returns {string} the comparison form.
 */
function canonical(value: string): string {
  let resolved = path.resolve(value)
  try { resolved = fs.realpathSync.native(resolved) } catch {
    // Resolve the nearest existing parent too: a missing leaf below an 8.3
    // spelling must still compare against the canonical long credential root.
    const parent = path.dirname(resolved)
    if (parent !== resolved) resolved = path.join(canonical(parent), path.basename(resolved))
  }
  return resolved.split(path.sep).join('/')
}

/**
 * The denied roots for one (home, environment) pair, memoised.
 *
 * Deriving the list costs thirteen `realpath` calls plus one per environment entry — measured at
 * 1.9 ms on Windows, and paid by **every** file-tool call before it can do anything. On the symbol
 * map path that was 99% of a warm call (the engine itself takes 0.011 ms). The list depends only
 * on the home directory and one environment variable, so it is derived once and reused.
 *
 * `ROOT_TTL_MS` bounds the one thing that changes without either input changing: a suffix that did
 * not exist at derivation time and was later created as a junction to somewhere else. Such a root
 * is compared in its old spelling for at most this window. Five seconds is short against the
 * lifetime of a session and long against a burst of tool calls; {@link resetCredentialCache} drops
 * the whole thing.
 */
const ROOT_TTL_MS = 5_000

/**
 * One denied root: the canonical spelling for traversal callers, its lowercased form for the
 * comparison, and the label a refusal names.
 *
 * Both spellings are computed once. Lowercasing the root inside the loop instead would re-case the
 * same thirteen strings on every call *and* — as the first version of this cache did — silently
 * compare a lowercased target against a mixed-case root on a drive-letter path, which denies
 * nothing and looks like a working fence.
 */
interface DeniedRoot { root: string; lower: string; suffix: string }

interface RootCache { key: string; roots: DeniedRoot[]; at: number }

let rootCache: RootCache | undefined

/** Drop the memoised root list. Tests use it; a host may call it after changing its home. */
export function resetCredentialCache(): void {
  rootCache = undefined
}

/** Every denied root, memoised per (home, env) pair. */
function deniedRoots(resolvedHome: string | undefined, env: NodeJS.ProcessEnv): DeniedRoot[] {
  const key = `${resolvedHome ?? ''}\u0000${env?.[DENY_ENV] ?? ''}`
  const now = Date.now()
  if (rootCache !== undefined && rootCache.key === key && now - rootCache.at < ROOT_TTL_MS) return rootCache.roots
  const roots: DeniedRoot[] = []
  if (typeof resolvedHome === 'string' && resolvedHome !== '') {
    for (const suffix of CREDENTIAL_SUFFIXES) {
      const root = canonical(path.join(resolvedHome, suffix))
      roots.push({ root, lower: root.toLowerCase(), suffix })
    }
  }
  for (const [root, suffix] of configuredRoots(env, resolvedHome)) roots.push({ root, lower: root.toLowerCase(), suffix })
  rootCache = { key, roots, at: now }
  return roots
}

/**
 * Whether one absolute path is inside a denied credential location.
 *
 * @param {string} candidate - the absolute path to test.
 * @param {object} [options] - comparison inputs.
 * @param {string} [options.home] - the home directory to resolve suffixes against.
 * @param {NodeJS.ProcessEnv} [options.env] - the environment to read extra entries from.
 * @returns {{denied: true, matched: string}|{denied: false}} the verdict and the suffix that matched.
 */
export function credentialPath(candidate: unknown, { home, env = process.env }: CredentialOptions = {}): CredentialVerdict {
  if (typeof candidate !== 'string' || candidate === '') return { denied: false }
  // The candidate is resolved on every call and never memoised: that resolution is what stops a
  // link created after this process started from being walked through. Only the roots are constant.
  const target = canonical(candidate)
  const comparableTarget = target.toLowerCase()
  for (const { lower, suffix } of deniedRoots(home ?? env?.HOME ?? env?.USERPROFILE, env)) {
    if (comparableTarget === lower || comparableTarget.startsWith(`${lower}/`)) return { denied: true, matched: suffix }
  }
  for (const pattern of CREDENTIAL_NAMES) {
    if (pattern.test(target)) return { denied: true, matched: String(pattern) }
  }
  return { denied: false }
}

/**
 * The credential locations as absolute directories, for a caller that wants to
 * skip them during a traversal rather than refuse one path.
 *
 * Only the directory-shaped suffixes are returned: a file such as `.npmrc` is
 * not a root to walk around, and skipping its parent would hide the whole home
 * directory.
 * @param {object} [options] - the same inputs as {@link credentialPath}.
 * @returns {string[]} the absolute directories, deduplicated.
 */
export function credentialRoots({ home, env = process.env }: CredentialOptions = {}): string[] {
  const roots = new Set<string>()
  for (const { root } of deniedRoots(home ?? env?.HOME ?? env?.USERPROFILE, env)) roots.add(root)
  return [...roots]
}

/**
 * The refusal a denied operation reports. The wording names the fence and the way
 * out, because "denied" without either invites a retry loop, and it names both
 * directions: a caller stopped from writing must not read the message as "reads
 * are fenced" (#204 P4).
 * Denied paths and matching rules are intentionally absent: either can reveal a real parent path.
 * @param {string} _candidate - ignored; retained for internal call compatibility.
 * @param {string} _matched - ignored; the refusal does not disclose the matching rule.
 * @returns {{code: string, message: string, nextAction: string}} the refusal.
 */
export function credentialRefusal(_candidate: string, _matched: string) {
  return {
    code: 'POLICY_DENIED',
    message: 'The requested path is inside a credential location; the dsh-ops file tools neither read nor write credentials: reads, writes, copy/move destinations, replace targets and removal are refused.',
    nextAction: 'Use a path inside the workspace. An operator who really needs this path can add it to '
      + `${DENY_ENV} (which only widens the list) or disable the fence with denyCredentialReads: false.`,
  }
}
