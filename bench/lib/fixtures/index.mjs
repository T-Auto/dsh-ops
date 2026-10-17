/**
 * The benchmark fixture barrel: the seeded PRNG scaffold every family shares, the
 * name -> builder registry, and the derivation functions that recompute each
 * builder's expectation from the bytes it wrote.
 *
 * The catalogue is split by family — `csv` / `log` / `tree` / `symbol` here,
 * `corpus` / `deep` are P3 — but re-exported from this one path so the tasks,
 * `run.mjs` and the suites keep a single import. The PRNG lives here because
 * every family draws the same stream, so the families import it back from this
 * barrel; that mutual import is safe because every shared binding is a function
 * declaration and the one `const`, `WORDS`, is only read inside a builder call.
 *
 * @module dsh-ops/bench/fixtures
 */

import { largeCsv } from './csv.mjs'
import { logStats, noisySuite } from './log.mjs'
import { configTree, grepTree, renameTree } from './tree.mjs'
import { deepModule, symbolTree } from './symbol.mjs'

export { deriveLargeCsv, largeCsv } from './csv.mjs'
export { deriveLogStats, deriveNoisySuite, logStats, noisySuite } from './log.mjs'
export { configTree, deriveConfigTree, deriveGrepTree, deriveRenameTree, grepTree, renameTree } from './tree.mjs'
export { deepModule, deriveDeepModule, deriveSymbolTree, symbolTree } from './symbol.mjs'

/** mulberry32: a 32-bit seeded PRNG, small enough to inline and stable across engines. */
export function mulberry32(seed) {
  let state = seed >>> 0
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

/** Inclusive integer draw from the stream. */
export function randInt(next, min, max) {
  return min + Math.floor(next() * (max - min + 1))
}

/** Uniform element draw from a pool. */
export function pick(next, from) {
  return from[Math.floor(next() * from.length)]
}

/** Zero-padded decimal. */
export function pad(value, width) {
  return String(value).padStart(width, '0')
}

/** Draw `count` distinct indices from `[0, total)` by partial Fisher-Yates. */
export function drawIndices(next, total, count) {
  if (count > total) throw new RangeError(`cannot draw ${count} of ${total} items`)
  const pool = Array.from({ length: total }, (_unused, index) => index)
  const drawn = new Set()
  for (let i = 0; i < count; i += 1) {
    const j = i + Math.floor(next() * (total - i))
    const swap = pool[i]
    pool[i] = pool[j]
    pool[j] = swap
    drawn.add(pool[i])
  }
  return drawn
}

/** Lowercase identifier pool for filler text; never contains an uppercase token. */
export const WORDS = [
  'alpha', 'bravo', 'cache', 'delta', 'entry', 'final', 'graph', 'host', 'index',
  'json', 'kernel', 'link', 'map', 'node', 'queue', 'route', 'scope', 'token',
  'utf', 'value', 'width', 'yield', 'zero', 'atlas', 'cipher', 'shard', 'vector',
]

/** A run of uppercase hex digits, so a letters-and-digits needle cannot appear by accident. */
export function hexRun(next, length) {
  let out = ''
  for (let i = 0; i < length; i += 1) out += '0123456789ABCDEF'[randInt(next, 0, 15)]
  return out
}

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

// P3 extends the registry with the corpus (deepCorpus) and deep (gatePipeline)
// families; `generate()` reads it, so an unlisted generator is unreachable.
export const GENERATORS = { grepTree, renameTree, largeCsv, logStats, configTree, deepModule, noisySuite, symbolTree }
