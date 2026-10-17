/**
 * Credential locations the file tools refuse to read.
 *
 * DSH's own filesystem layer does not fence these paths, so a tool that reads
 * any OS-readable file can hand a model the operator's API tokens and private
 * keys. The plugin's file surface is narrower than a general reader on purpose:
 * it is a repository tool, and none of its jobs need a credential file.
 *
 * The fence is on READS only, and it covers the operation root of a batch as
 * well as a single path, so a copy or a snapshot cannot reach a credential
 * either. Writes are already fenced by the DSH permission mode; this closes the
 * remaining direction.
 *
 * @module dsh-ops/credential-policy
 */
import fs from 'node:fs'
import path from 'node:path'

/** Environment variable naming extra denied paths, separated by the platform delimiter. */
export const DENY_ENV = 'DSH_OPS_DENY_READ'

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
/** Backup suffixes that leave the secret intact under a longer name. */
const BACKUP_SUFFIX = /(\.(bak|old|orig|save|tmp|swp|copy)|~|-\d{6,}(-\d+)?)$/i

/** The name with up to three backup suffixes removed. Comparison only; callers keep the original. */
function normalizeForMatch(target) {
  let name = target
  for (let pass = 0; pass < 3; pass++) {
    const next = name.replace(BACKUP_SUFFIX, '')
    if (next === name || next === '') break
    name = next
  }
  return name
}

const CREDENTIAL_NAMES = Object.freeze([
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i,
  /(^|\/)[^/]*credentials[^/]*\.(json|ya?ml|ini)$/i,
  /(^|\/)service-account[^/]*\.json$/i,
  /(^|\/)\.env(\.|$)/i,
])

/** Extra suffixes from the environment, resolved once per call so a deployment can add its own. */
function configuredSuffixes(env) {
  const raw = env?.[DENY_ENV]
  if (typeof raw !== 'string' || raw.trim() === '') return []
  return raw.split(path.delimiter).map(entry => entry.trim()).filter(entry => entry !== '')
}

/**
 * The extra denied locations from the environment, as `[comparisonForm, label]` pairs.
 *
 * An **absolute** entry is used as written; a relative one is resolved below the home. The refusal
 * message prints the absolute path it refused, so the natural thing for an operator to paste back
 * into `DSH_OPS_DENY_READ` is that absolute path — joining it onto the home instead would make the
 * documented way out silently do nothing. An absolute entry also works with no home at all.
 * @param {NodeJS.ProcessEnv} env - the environment to read.
 * @param {string|undefined} resolvedHome - the home directory for relative entries.
 * @returns {Array<[string, string]>} the comparison form and the entry as written.
 */
function configuredRoots(env, resolvedHome) {
  const roots = []
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
function canonical(value) {
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
 * Whether one absolute path is inside a denied credential location.
 *
 * @param {string} candidate - the absolute path to test.
 * @param {object} [options] - comparison inputs.
 * @param {string} [options.home] - the home directory to resolve suffixes against.
 * @param {NodeJS.ProcessEnv} [options.env] - the environment to read extra entries from.
 * @returns {{denied: true, matched: string}|{denied: false}} the verdict and the suffix that matched.
 */
export function credentialPath(candidate, { home, env = process.env } = {}) {
  if (typeof candidate !== 'string' || candidate === '') return { denied: false }
  const target = canonical(candidate)
  const roots = []
  const resolvedHome = home ?? env?.HOME ?? env?.USERPROFILE
  if (typeof resolvedHome === 'string' && resolvedHome !== '') {
    for (const suffix of CREDENTIAL_SUFFIXES) roots.push([canonical(path.join(resolvedHome, suffix)), suffix])
  }
  roots.push(...configuredRoots(env, resolvedHome))
  // A backup copy holds the same secret under a longer name. `~/.dsh/.credentials.yaml.bak`
  // is neither equal to nor below the credential location, and does not end in a credential
  // extension, so the root comparison and the name patterns both matched nothing: the operator's
  // habitual copy stayed readable while the original was refused. Test the de-suffixed spelling
  // too — the refusal still names the location, and the original path keeps its verdict.
  const spellings = [target, normalizeForMatch(target)]
  for (const [root, suffix] of roots) {
    const comparableRoot = root.toLowerCase()
    for (const spelling of spellings) {
      const comparableTarget = spelling.toLowerCase()
      if (comparableTarget === comparableRoot || comparableTarget.startsWith(`${comparableRoot}/`)) return { denied: true, matched: suffix }
    }
  }
  for (const pattern of CREDENTIAL_NAMES) {
    if (spellings.some(spelling => pattern.test(spelling))) return { denied: true, matched: String(pattern) }
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
export function credentialRoots({ home, env = process.env } = {}) {
  const resolvedHome = home ?? env?.HOME ?? env?.USERPROFILE
  const roots = new Set()
  if (typeof resolvedHome === 'string' && resolvedHome !== '') {
    for (const suffix of CREDENTIAL_SUFFIXES) roots.add(canonical(path.join(resolvedHome, suffix)))
  }
  for (const [root] of configuredRoots(env, resolvedHome)) roots.add(root)
  return [...roots]
}

/**
 * The refusal a denied read reports. The wording names the fence and the way
 * out, because "denied" without either invites a retry loop.
 * @param {string} candidate - the denied path.
 * @param {string} matched - the suffix or pattern that matched.
 * @returns {{code: string, message: string, nextAction: string}} the refusal.
 */
export function credentialRefusal(candidate, matched) {
  return {
    code: 'POLICY_DENIED',
    message: `${candidate} is inside a credential location (${matched}); the dsh-ops file tools do not read credentials.`,
    nextAction: 'Use a path inside the workspace. An operator who really needs this path can add it to '
      + `${DENY_ENV} (which only widens the list) or disable the fence with denyCredentialReads: false.`,
  }
}
