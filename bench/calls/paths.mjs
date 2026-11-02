/**
 * Path templates shared by corpus resolution and pin resolution. Only three placeholders
 * exist, and an unexpanded one is an error: a literal `${repo}` must never become a
 * relative path that happens to point somewhere.
 *
 * @module dsh-ops/bench/calls/paths
 */

import os from 'node:os'
import path from 'node:path'

/**
 * Expand one template.
 *
 * @param {string} template - `${repo}`, `${home}`, `${root}` or `${env:NAME}` segments.
 * @param {{repoRoot: string, home?: string, env?: NodeJS.ProcessEnv, root?: string}} context - expansion values.
 * @returns {string} the absolute path.
 * @throws {Error} when a placeholder has no value.
 */
export function expandTemplate(template, { repoRoot, home = os.homedir(), env = process.env, root }) {
  const expanded = String(template).replace(/\$\{(repo|home|root|env:[A-Za-z_][A-Za-z0-9_]*)\}/g, (match, token) => {
    if (token === 'repo') return repoRoot
    if (token === 'home') return home
    if (token === 'root') {
      if (root === undefined) throw new Error('${root} is only available once the corpus root is resolved')
      return root
    }
    const name = token.slice(4)
    const value = env[name]
    if (!value) throw new Error(`${match} is not set in this environment`)
    return value
  })
  if (expanded.includes('${')) throw new Error(`unknown placeholder in "${template}"`)
  return path.resolve(expanded)
}
