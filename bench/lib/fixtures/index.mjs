/**
 * The benchmark fixture barrel: the seeded PRNG scaffold every family shares, the
 * name -> builder registry, and the derivation functions that recompute each
 * builder's expectation from the bytes it wrote.
 *
 * The catalogue is split by family — `csv` / `log` / `tree` / `symbol` / `corpus`
 * / `deep` / `repair` — but re-exported from this one path so the tasks, `run.mjs`
 * and the suites keep a single import. The scaffold itself lives in
 * `./internal.mjs`, which imports nothing, so the graph is a DAG: barrel ->
 * family -> scaffold. The shared names are still re-exported from here, because
 * that is the path the rest of the bench has always imported them from.
 *
 * @module dsh-ops/bench/fixtures
 */

import { largeCsv } from './csv.mjs'
import { logStats, noisySuite } from './log.mjs'
import { configTree, grepTree, renameTree } from './tree.mjs'
import { symbolTree } from './symbol.mjs'
import { deepModule } from './deep.mjs'
import { deepCorpus } from './corpus.mjs'
import { brokenProject, gatePipeline } from './repair.mjs'

export { deriveLargeCsv, largeCsv } from './csv.mjs'
export { deriveLogStats, deriveNoisySuite, logStats, noisySuite } from './log.mjs'
export { configTree, deriveConfigTree, deriveGrepTree, deriveRenameTree, grepTree, renameTree } from './tree.mjs'
export { deriveSymbolTree, symbolTree } from './symbol.mjs'
export { deepModule, deriveDeepModule } from './deep.mjs'
export { deepCorpus } from './corpus.mjs'
export { brokenProject, gatePipeline } from './repair.mjs'
export { drawIndices, hexRun, mulberry32, pad, pick, randInt, WORDS } from './internal.mjs'

/**
 * Run a generator by name.
 * @param {string} name - the generator name from `fixture.generator`.
 * @param {Record<string, unknown>} [params] - the generator params.
 * @returns {{files: {path: string, content: string}[], exports: Record<string, unknown>}} the fixture.
 */
export function generate(name, params = {}) {
  const builder = GENERATORS[name]
  if (!builder) {
    const known = Object.keys(GENERATORS).sort().join(', ')
    throw new Error(`unknown fixture generator "${name}" (known: ${known})`)
  }
  const fixture = builder(params)
  if (!Array.isArray(fixture?.files)) throw new Error(`generator "${name}" returned no file list`)
  if (fixture.files.some((file) => typeof file?.path !== 'string' || typeof file?.content !== 'string')) {
    throw new Error(`generator "${name}" returned a file entry without string path/content`)
  }
  return { files: fixture.files, exports: fixture.exports ?? {} }
}

/**
 * The generator registry: `fixture.generator` in a task file names exactly one of
 * these. It is the complete catalogue — the eleven builders above, one entry each —
 * and `test/bench-fixtures.test.mjs` asserts the exact list, so a family that is
 * implemented but never registered fails the suite instead of becoming unreachable.
 */
export const GENERATORS = {
  grepTree, renameTree, largeCsv, brokenProject, logStats, configTree,
  deepModule, deepCorpus, noisySuite, symbolTree, gatePipeline,
}
