/**
 * Fixtures and the host bridge shared by the symbol-map suites.
 *
 * Extracted from `test/symbol-map.test.mjs` when that file crossed the repository's 1000-line
 * gate: the fixtures are data and the bridge is twelve lines of host modelling, neither of which is
 * the thing under test. Nothing here asserts anything.
 *
 * @module dsh-ops/test/lib/symbol-map-fixtures
 */

import fs from 'node:fs'
import path from 'node:path'

import { canonical, TEST_HOME } from './harness.mjs'
import { invoke } from '../../lib/file/worker.js'

/**
 * The fixture every position assertion is written against.
 *
 * `make` is spelled `static make` on purpose: a method is matched through `method_definition`
 * whether or not it is static, and a regression that only checked instance methods would miss it.
 */
export const GOOD = [
  'export function alpha() {',    // 1
  '  return 1',                   // 2
  '}',                            // 3
  '',                             // 4
  'export class Widget {',        // 5
  '  render() {',                 // 6
  '    return 2',                 // 7
  '  }',                          // 8
  '',                             // 9
  '  static make() {',            // 10
  '    return new Widget()',      // 11
  '  }',                          // 12
  '}',                            // 13
  '',                             // 14
  'function* stream() {',         // 15
  '  yield 1',                    // 16
  '}',                            // 17
  '',                             // 18
  'const handler = async () => {',// 19
  '  return 3',                   // 20
  '}',                            // 21
  '',
].join('\n')

/** A file broken on its first line: the case `recoverSymbols` exists for. */
export const BROKEN = [
  'export function broken( {{{',  // 1
  '',                             // 2
  'export function alpha() {',    // 3
  '  return 1',                   // 4
  '}',                            // 5
  '',                             // 6
  'export class Widget {',        // 7
  '  render() {',                 // 8
  '    return 2',                 // 9
  '  }',                          // 10
  '}',                            // 11
  '',
].join('\n')

/**
 * A broken file whose class has a blank line *inside* it, which is where paragraph splitting
 * fails: `class Widget {` and `static make()` end up in different chunks, and neither fragment
 * parses. Splitting on top-level declarations keeps them together.
 */
export const BROKEN_CLASS = [
  'export function broken( {{{',      // 1
  '',                                 // 2
  'export class Widget {',            // 3
  '  render() {',                     // 4
  '    return 2',                     // 5
  '  }',                              // 6
  '',                                 // 7
  '  static make() {',                // 8
  '    return new Widget()',          // 9
  '  }',                              // 10
  '}',                                // 11
  '',                                 // 12
  'export const handler = async () => 3', // 13
  '',
].join('\n')

/** Two names that differ only by case: the `name` filter's regression fixture. */
export const CASED = [
  'function get() {',      // 1
  '  return 1',            // 2
  '}',                     // 3
  '',                      // 4
  'function GetValue() {', // 5
  '  return 2',            // 6
  '}',                     // 7
  '',
].join('\n')

/**
 * Every way a class body can name a method, plus one object-literal method that must stay out.
 *
 * `property_identifier` is only the plain case: a `property_identifier`-only query also drops
 * `#secret()`, `[Symbol.iterator]()` and `'quoted-name'()` without an error, so the outline looks
 * like a smaller class rather than a broken query.
 */
export const NAMED = [
  'export class Named {',        // 1
  '  plain() {}',                // 2
  '  #secret() {}',              // 3
  '  get value() { return 1 }',  // 4
  '  [Symbol.iterator]() {}',    // 5
  "  'quoted-name'() {}",        // 6
  '}',                           // 7
  '',
  'const literal = {',           // 9
  '  notAMethod() {},',          // 10
  '}',                           // 11
  '',
].join('\n')

/** The expected core outline of {@link GOOD}, in the order the engine sorts it. */
export const GOOD_SYMBOLS = [
  { name: 'alpha', type: 'function', startLine: 1, endLine: 3 },
  { name: 'Widget', type: 'class', startLine: 5, endLine: 13 },
  { name: 'render', type: 'method', startLine: 6, endLine: 8 },
  { name: 'make', type: 'method', startLine: 10, endLine: 12 },
  { name: 'stream', type: 'function', startLine: 15, endLine: 17 },
]

/**
 * Create a workspace holding named fixtures and hand back its path.
 * @param {string} dir - the temporary directory.
 * @param {Record<string, string>} files - file name to contents.
 * @returns {void}
 */
export function seed(dir, files) {
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), contents)
}

/**
 * Create a fixture directory under the runner's temporary home that is removed afterwards.
 *
 * `harness.withTempDir` additionally re-owns the directory with `icacls` on Windows, which exists
 * for elevated hosted runners whose default owner is Administrators. That step is refused outright
 * where the temporary root is not owned by the caller, and it would fail every check before its
 * first assertion; nothing here needs it, because the suite only reads files it just wrote.
 * `TEST_HOME` is still the runner's throwaway `DSH_HOME`, so the isolation `run.mjs` guarantees is
 * unchanged — one suite, one home, removed when the child exits.
 * @param {string} prefix - directory-name infix, for readable leftovers.
 * @param {(dir: string) => unknown | Promise<unknown>} body - the work.
 * @returns {Promise<unknown>} whatever the body returned.
 */
export async function withFixture(prefix, body) {
  const dir = canonical(fs.mkdtempSync(path.join(TEST_HOME, `${prefix}-`)))
  try { return await body(dir) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

let sessions = 0

/**
 * Build the minimal host a `symbol_map` call needs.
 *
 * `invoke` only insists on `session.id`; there is no subprocess service here on purpose, because
 * "answers without one" is the property the in-process branch exists for. Each bridge gets its own
 * session identity: the result lifecycle refuses two live objects that share an id.
 * @param {object} options - call inputs.
 * @param {string} options.workspace - the policy workspace root.
 * @param {string} [options.cwd] - the session cwd; defaults to the workspace.
 * @param {string} [options.mode] - the DSH mode the policy resolves to.
 * @param {boolean} [options.policy] - set false to model a host with no policy service.
 * @returns {{ call: (tool: string, args: unknown, config?: object) => Promise<any> }} the bridge.
 */
export function bridge({ workspace, cwd = workspace, mode = 'read-only', policy = true }) {
  sessions += 1
  const ctx = { get: name => (policy ? { sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: workspace }) } } : {})[name] }
  const exec = { agent: { session: { id: `symbol-map-${sessions}`, header: { cwd } } } }
  return {
    call: (tool, args, config = { denyCredentialReads: true }) => invoke(ctx, '', tool, args, exec, undefined, config),
  }
}
