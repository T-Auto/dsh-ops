/**
 * The environment one child of this plugin starts from.
 *
 * Credentials are never inherited implicitly. This plugin spawns FastCtx as its
 * own MCP stdio server, probes candidate executables, and runs shell tools. A
 * child handed the host's `process.env` receives `GH_TOKEN`, `DEEPSEEK_API_KEY`,
 * cloud credentials, and `DSH_HOME`-scoped facts it has no business reading.
 *
 * That matters most on the one path that runs a binary **before** trusting it:
 * `probeBinary` executes its candidate to prove it is a working FastCtx build,
 * and a candidate that came off `PATH` is exactly the thing the probe exists to
 * be suspicious of. Handing it the full environment would make the check a
 * credential-delivery mechanism.
 *
 * `gh` and `git` keep reading their own configuration files, so dropping
 * `GH_TOKEN` costs a child nothing it is entitled to.
 * @module dsh-ops/env
 */

/**
 * Names a child legitimately needs: how to find programs, who it is, where its
 * scratch space is, how it reaches the network, and what language it speaks.
 *
 * **This is an allow-list on purpose.** A deny-list can only drop the shapes
 * somebody thought of, and whatever it misses is handed over silently. The
 * earlier revision matched `/KEY|PASSWORD|SECRET|TOKEN/` plus `DSH_*`, and let
 * `SSH_AUTH_SOCK` through — which authorises the host's SSH keys — along with
 * `DATABASE_URL`, which normally carries a password: neither contains a word
 * that pattern knew about. With an allow-list, an unanticipated name is dropped,
 * and the child says so by failing rather than leaking.
 *
 * `gh` and `git` read their own configuration files, so nothing withheld here
 * costs a child a capability it is entitled to.
 */
const ALLOWED_ENV_NAMES = new Set([
  // Where programs live, and how the platform finds them.
  'PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR',
  // Who the child is.
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'USERDNSDOMAIN',
  'OS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS',
  // Scratch space.
  'TEMP', 'TMP', 'TMPDIR',
  // Where installed software keeps its data (tooling looks these up).
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)',
  'PROGRAMW6432', 'COMMONPROGRAMW6432',
  // Language / locale.
  'LANG', 'LANGUAGE',
  // Network egress: a child behind a corporate proxy still has to work.
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS',
  // Where `gh` looks for its own configuration. That is a *path*, not a secret,
  // and the previous revision deliberately kept it so `gh`/`git` can work from
  // their own config files — dropping it would break tooling the child is meant
  // to have. (`GH_TOKEN` itself stays withheld.)
  'GH_CONFIG_DIR',
])

/**
 * The environment to hand a spawned child: the parent's, restricted to
 * {@link ALLOWED_ENV_NAMES} plus any `LC_*` locale variable.
 *
 * `PATH`, `HOME`, locale and proxy variables survive so child tooling runs
 * normally; everything else — credentials above all — does not.
 * @param {NodeJS.ProcessEnv} [parent] - the environment to scrub.
 * @returns {NodeJS.ProcessEnv} a fresh environment object safe to hand to a spawn.
 */
export function childEnv(parent = process.env) {
  const env = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue
    const upper = key.toUpperCase()
    if (ALLOWED_ENV_NAMES.has(upper) || upper.startsWith('LC_')) env[key] = value
  }
  return env
}
