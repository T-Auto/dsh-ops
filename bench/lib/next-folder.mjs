#!/usr/bin/env node
/**
 * Allocate the next free date-stamped group directory under `bench/runs/`.
 *
 * The default name is `benchmark-YYYY-MM-DD-NN` — the local calendar date, numbered
 * from `-00` — and `ab` allocates it **exactly once per sweep**, handing the answer
 * to both sides and to the comparison: letting each process default on its own would
 * put the baseline and the candidate in two different groups, and the comparison
 * would have nothing to pair.
 *
 * The scan is read-only and non-exclusive on purpose: two sweeps started in the same
 * instant can both see `-00` free, and the failure mode is two runs landing in one
 * group — visible in the report, never lost data. A number is skipped when *any* entry
 * has that name, so a leftover empty directory from a failed sweep is skipped rather
 * than reused.
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
export const FOLDER_PREFIX = 'benchmark-'
/** Zero-padded to two digits; numbers past 99 simply grow (`benchmark-2026-10-24-100`). */
const WIDTH = 2

/**
 * The local calendar date of `now` as `YYYY-MM-DD`.
 * @param {Date} [now] - the instant to stamp (default the current time).
 * @returns {string} the zero-padded local date.
 */
export function dayStamp(now = new Date()) {
  return [
    String(now.getFullYear()).padStart(4, '0'),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
}

/**
 * The group names already present under the runs root, lower-cased so the answer
 * holds on a case-insensitive filesystem (Windows) as well as a case-sensitive one.
 * @param {string} runsDir - the runs root to scan; a missing or unreadable one counts as empty.
 * @returns {Set<string>} the lower-cased entry names.
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

/**
 * The first `benchmark-YYYY-MM-DD-NN` nobody is using yet.
 * @param {string} [runsDir] - the runs root to scan (default {@link RUNS_DIR}).
 * @param {Date} [now] - the instant whose local date names the group (default now);
 *   injectable so a suite can assert exact names instead of patterns.
 * @returns {string} the free group name, numbered from `-00` on that date.
 */
export function nextFolderName(runsDir = RUNS_DIR, now = new Date()) {
  const taken = takenFolders(runsDir)
  const prefix = `${FOLDER_PREFIX}${dayStamp(now)}-`
  for (let number = 0; ; number += 1) {
    const name = `${prefix}${String(number).padStart(WIDTH, '0')}`
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
