/**
 * The `csv` fixture family: one wide region/amount table whose expected sum has
 * to be read back out of the bytes that were written.
 * @module dsh-ops/bench/fixtures/csv
 */

import { mulberry32, pick, randInt } from './index.mjs'

/**
 * `largeCsv` — one wide CSV plus the exact integer sum of one region's amounts
 * (PLAN.md §7.3). The sum is computed from the same values that are written out,
 * so `answer.txt` has a single defensible expected content.
 * @param {{seed?: number, rows?: number, targetRegion?: string, regions?: string[], maxAmount?: number}} params - the shape of the table.
 * @returns {{files: {path: string, content: string}[], exports: {sum: number, rows: number, targetRegion: string}}} the fixture.
 */
export function largeCsv(params = {}) {
  const seed = params.seed ?? 7
  const rows = params.rows ?? 20000
  const targetRegion = params.targetRegion ?? 'EU'
  const regions = params.regions ?? ['EU', 'US', 'APAC', 'LATAM']
  const maxAmount = params.maxAmount ?? 10000
  if (!regions.includes(targetRegion)) throw new Error(`targetRegion "${targetRegion}" is not in regions`)

  const next = mulberry32(seed)
  const lines = ['id,region,amount']
  let sum = 0
  let hits = 0
  for (let id = 1; id <= rows; id += 1) {
    const region = pick(next, regions)
    const amount = randInt(next, 1, maxAmount)
    if (region === targetRegion) {
      sum += amount
      hits += 1
    }
    lines.push(`${id},${region},${amount}`)
  }
  // Integer arithmetic only: rows * maxAmount stays far below Number.MAX_SAFE_INTEGER.
  if (!Number.isSafeInteger(sum)) throw new Error(`sum ${sum} exceeds safe integer range`)
  return {
    files: [{ path: 'data.csv', content: `${lines.join('\n')}\n` }],
    exports: { sum, rows, hits, targetRegion },
  }
}

/** Recompute `largeCsv`'s `{sum, hits, rows}` from `files` and `targetRegion`. */
export function deriveLargeCsv(files, targetRegion) {
  const content = files.find((file) => file.path === 'data.csv')?.content ?? ''
  const rows = content.trim().split('\n')
  let sum = 0
  let hits = 0
  for (const line of rows.slice(1)) {
    const [, region, amount] = line.split(',')
    if (region === targetRegion) {
      sum += Number(amount)
      hits += 1
    }
  }
  return { sum, hits, rows: rows.length - 1, targetRegion }
}
