#!/usr/bin/env node
/**
 * Allocate the next free `benchmark-test-NN` group directory under `bench/runs/`.
 *
 * `ab` allocates this **exactly once per sweep** and hands the answer to both sides
 * and to the comparison: letting each process default on its own would put the
 * baseline in `benchmark-test-01` and the candidate in `benchmark-test-02` (that
 * group exists by then), and the comparison would have nothing to pair.
 *
 * The scan is read-only and non-exclusive on purpose: two sweeps started in the same
 * instant can both see `benchmark-test-01` free, and the failure mode is two runs
 * landing in one group — visible in the report, never lost data. A number is skipped
 * when *any* entry has that name, so a leftover empty directory from a failed sweep
 * is skipped rather than reused.
 *
 * @module dsh-ops/bench/next-folder
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BENCH_DIR } from './env.mjs'

/** Where `run.json` archives land, one directory per sweep. */
export const RUNS_DIR = path.join(BENCH_DIR, 'runs')
/** The group prefix both the CLI help text and this scan agree on. */
export const FOLDER_PREFIX = 'benchmark-test-'
/** Zero-padded to two digits; numbers past 99 simply grow (`benchmark-test-100`). */
const WIDTH = 2

/**
 * The group names already present under the runs root, lower-cased so the answer
 * holds on a case-insensitive filesystem (Windows) as well as a case-sensitive one.
 */
export function takenFolders(runsDir) {
  let entries
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true })
  } catch {
    return new Set()
  }
  return new Set(entries.map((entry) => entry.name.toLowerCase()))
}

/** The first `benchmark-test-NN` nobody is using yet. */
export function nextFolderName(runsDir = RUNS_DIR) {
  const taken = takenFolders(runsDir)
  for (let number = 1; ; number += 1) {
    const name = `${FOLDER_PREFIX}${String(number).padStart(WIDTH, '0')}`
    if (!taken.has(name.toLowerCase())) return name
  }
}

// Only when executed, not when imported by the suite or the CLI.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    console.log(nextFolderName(process.argv[2]))
  } catch (error) {
    console.error(`next-folder: ${error.message}`)
    process.exitCode = 1
  }
}
