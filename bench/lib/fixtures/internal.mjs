/**
 * The fixture scaffold: the seeded PRNG, the draw helpers and the filler pools
 * every family shares.
 *
 * This module exists so that a family never has to import the barrel that
 * imports it. Before the split a family imported `./index.mjs` to reach the
 * PRNG, while `index.mjs` imported the family to build `GENERATORS` — an ESM
 * cycle that happened to work only because every shared binding was a function
 * declaration (hoisted) and the one `const`, `WORDS`, is read inside a builder
 * call rather than at module evaluation. `internal.mjs` has no imports at all,
 * so the graph is a DAG: barrel -> family -> scaffold.
 *
 * The barrel still re-exports every name here, because the tasks, `run.mjs` and
 * the suites import the scaffold from the public path and must keep working.
 *
 * @module dsh-ops/bench/fixtures/internal
 */

/**
 * mulberry32: a 32-bit seeded PRNG, small enough to inline and stable across
 * engines because it only ever uses `Math.imul` and integer shifts.
 * @param {number} seed - integer seed from the task definition.
 * @returns {() => number} a function returning floats in `[0, 1)`.
 */
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

/**
 * Inclusive integer draw.
 * @param {() => number} next - the PRNG stream.
 * @param {number} min - lowest value.
 * @param {number} max - highest value.
 * @returns {number} an integer in `[min, max]`.
 */
export function randInt(next, min, max) {
  return min + Math.floor(next() * (max - min + 1))
}

/**
 * Uniform element draw.
 * @param {() => number} next - the PRNG stream.
 * @param {unknown[]} from - the pool.
 * @returns {unknown} one element of the pool.
 */
export function pick(next, from) {
  return from[Math.floor(next() * from.length)]
}

/**
 * Zero-padded decimal.
 * @param {number} value - the number to render.
 * @param {number} width - the field width.
 * @returns {string} the padded value.
 */
export function pad(value, width) {
  return String(value).padStart(width, '0')
}

/**
 * Draw `count` distinct indices from `[0, total)` without sorting the whole pool:
 * a partial Fisher-Yates over the head of the array.
 * @param {() => number} next - the PRNG stream.
 * @param {number} total - the size of the index space.
 * @param {number} count - how many indices to draw.
 * @returns {Set<number>} the drawn indices.
 */
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

/**
 * A run of uppercase hex digits, e.g. `4F2A9C`. Hex alphabet only, so a needle
 * made of letters-and-digits can never appear by accident.
 * @param {() => number} next - the PRNG stream.
 * @param {number} length - how many digits.
 * @returns {string} the run.
 */
export function hexRun(next, length) {
  let out = ''
  for (let i = 0; i < length; i += 1) out += '0123456789ABCDEF'[randInt(next, 0, 15)]
  return out
}
