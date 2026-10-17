#!/usr/bin/env node
/**
 * Allocate the next free `benchmark-test-NN` group directory under `bench/runs/`.
 *
 * `win-ab.bat` calls this exactly once per sweep and hands the answer to both sides and to
 * the compare, because all three commands must share one `--folder`: letting each process
 * default on its own would put the baseline in `benchmark-test-01` and the candidate in
 * `benchmark-test-02` (that group exists by then), and the comparison would have nothing
 * to pair.
 *
 * The scan is read-only and non-exclusive on purpose. Two sweeps started in the same
 * instant can both see `benchmark-test-01` free; a lock file would be more machinery than a
 * fixture tool run by one person needs, and the failure mode is two runs landing in one
 * group — visible in the report, never lost data. A number is only skipped when *any* entry
 * has that name, so a leftover empty directory from a failed sweep is skipped rather than
 * reused.
 *
 * @module dsh-ops/bench/next-folder
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The bench directory: this module lives one level below it. */
const BENCH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** Where `run.mjs --folder` and `compare.mjs --folder` look for groups. */
export const RUNS_DIR = path.join(BENCH_DIR, 'runs')
/** The group prefix both the wrapper's help text and this scan agree on. */
export const FOLDER_PREFIX = 'benchmark-test-'
/** Zero-padded to two digits; numbers past 99 simply grow (`benchmark-test-100`). */
const WIDTH = 2

/**
 * The group names already present under the runs root, lower-cased so the answer holds on
 * a case-insensitive filesystem (Windows) as well as a case-sensitive one.
 * @param {string} runsDir - the runs root.
 * @returns {Set<string>} the taken names, lower-cased.
 */
export function takenFolders(runsDir) {
  let entries
  try { entries = fs.readdirSync(runsDir, { withFileTypes: true }) } catch { return new Set() }
  return new Set(entries.map(entry => entry.name.toLowerCase()))
}

/**
 * The first `benchmark-test-NN` nobody is using yet.
 * @param {string} [runsDir] - the runs root (defaults to `bench/runs`).
 * @returns {string} a free group name, e.g. `benchmark-test-01`.
 */
export function nextFolderName(runsDir = RUNS_DIR) {
  const taken = takenFolders(runsDir)
  for (let number = 1; ; number += 1) {
    const name = `${FOLDER_PREFIX}${String(number).padStart(WIDTH, '0')}`
    if (!taken.has(name.toLowerCase())) return name
  }
}

// Only when executed, not when imported by the suite.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    console.log(nextFolderName())
  } catch (error) {
    console.error(`next-folder: ${error.message}`)
    process.exitCode = 1
  }
}
