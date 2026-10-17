/**
 * The tool-level comparison run (#103): one unchanged corpus, two explicitly
 * selected worker binaries, one warmup per engine, five alternating paired
 * rounds, and one exclusively created JSON report.
 *
 * This module owns the run loop, the report shape and the readable table. It
 * owns no fixtures and no argv parsing: the corpus arrives through
 * {@link compareFiles}'s options (see `./index.mjs` for the default corpus and
 * `runTools`) and the future CLI parses flags. Timing is printed and never
 * asserted; the returned `exitCode` is 1 only when some state is outside
 * {@link ACCEPTED_STATES}.
 *
 * @module dsh-ops/bench/tools/files
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { compare, EXPECTED_DIFFERENCES, firstDifference, runWorker, sha256, summarize } from './measure.mjs'

/** Always one warmup per engine, then five alternating paired rounds. */
export const WARMUPS = 1
export const ROUNDS = 5

/** The states that are an intended outcome; everything else is a finding and exits nonzero. */
export const ACCEPTED_STATES = Object.freeze(['MATCH', 'EXPECTED_DIFFERENCE', 'EXPECTED_REJECTION'])

/**
 * Write the report, exclusively. Evidence is never overwritten: an existing
 * path makes the write fail (`wx`) instead of silently replacing a previous
 * run's JSON.
 * @param {string} output - the resolved report path.
 * @param {object} report - the report document.
 * @returns {string} the path written.
 */
export function writeReportExclusive(output, report) {
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  return output
}

/**
 * Run the paired comparison and write the report.
 *
 * @param {object} options - the run inputs.
 * @param {string} options.baseline - the baseline worker binary.
 * @param {string} options.candidate - the candidate worker binary.
 * @param {string} options.out - the report path; must not exist.
 * @param {{root: string, cases: object[]}} options.corpus - the built corpus.
 * @param {string} [options.tempDir] - the corpus parent; must exist.
 * @param {number} [options.scale] - the recorded scale multiplier.
 * @param {number} [options.timeoutMs] - the per-process watchdog.
 * @param {number|null} [options.seed] - the recorded fixture seed.
 * @param {Record<string, string[]>} [options.args] - extra argv per engine
 *   (`{ baseline: [], candidate: [] }`); native workers take none, the suites
 *   use Node stand-ins.
 * @param {{out?: Function, err?: Function, table?: Function}} [options.io] - the
 *   output sinks, defaulting to `console`.
 * @returns {Promise<{report: object, output: string, exitCode: number}>} the result.
 */
export async function compareFiles(options = {}) {
  const {
    baseline, candidate, out, tempDir = os.tmpdir(), scale = 1, timeoutMs = 60000,
    seed = null, corpus, args = {}, io = console,
  } = options
  const emit = {
    out: io.out ?? (line => console.log(line)),
    err: io.err ?? (line => console.error(line)),
    table: io.table ?? (rows => console.table(rows)),
  }
  if (!baseline || !candidate || !out) throw new Error('baseline, candidate and out are required')
  if (!Number.isFinite(scale) || scale <= 0 || scale > 10) throw new Error('scale must be > 0 and <= 10')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error('timeout-ms must be an integer in 1..2147483647')
  if (!corpus || !Array.isArray(corpus.cases)) throw new Error('a corpus with a cases array is required')
  const output = path.resolve(out), parent = path.resolve(tempDir)
  if (fs.existsSync(output)) throw new Error(`Refusing to overwrite report: ${output}`)
  if (!fs.statSync(path.dirname(output)).isDirectory() || !fs.statSync(parent).isDirectory()) throw new Error('Output and temporary parent directories must exist')
  const engines = Object.fromEntries(['baseline', 'candidate'].map(engine => {
    const binary = fs.realpathSync(path.resolve(options[engine]))
    if (!fs.statSync(binary).isFile()) throw new Error(`Not a worker file: ${binary}`)
    const binarySha256 = sha256(fs.readFileSync(binary))
    emit.out(`${engine}: ${binary}\n  SHA-256 ${binarySha256}`)
    return [engine, { binary, binarySha256 }]
  }))
  emit.out(`seed=${seed}, scale=${scale}, watchdog=${timeoutMs}ms; warm runs, spawn-to-close; no timing gate`)
  emit.out('Release provenance is caller-supplied; binary hashes identify files, not build profiles or source commits.')
  const rows = [], comparisons = []
  for (const query of corpus.cases) {
    const id = `${query.fixture}/${query.id}`
    emit.out(`Running ${id}`)
    const request = { root: corpus.root, scope: 'file-benchmark-87', read_only: true, tool: query.tool, args: query.args }
    const runs = { baseline: [], candidate: [] }, warmup = {}
    for (const engine of ['baseline', 'candidate']) warmup[engine] = await runWorker(engines[engine].binary, request, { timeoutMs, args: args[engine] ?? [] })
    for (let round = 0; round < ROUNDS; round++) {
      for (const engine of round % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
        runs[engine].push(await runWorker(engines[engine].binary, request, { timeoutMs, args: args[engine] ?? [] }))
      }
    }
    const summaries = Object.fromEntries(['baseline', 'candidate'].map(engine => [engine, summarize(runs[engine], warmup[engine])]))
    const comparison = compare(summaries.baseline, summaries.candidate, EXPECTED_DIFFERENCES[id], query.expectedError)
    comparisons.push({ id, ...comparison, difference: firstDifference(summaries.baseline.sample, summaries.candidate.sample) })
    for (const engine of ['baseline', 'candidate']) {
      const { sample, ...summary } = summaries[engine]
      rows.push({ fixture: query.fixture, query: { id: query.id, tool: query.tool, ...query.args }, engine,
        binarySha256: engines[engine].binarySha256, ...summary, ...comparison })
    }
    if (!comparison.sameAsBaseline) emit.err(`${id}: ${comparison.state}: ${comparisons.at(-1).difference ?? 'no comparable complete JSON'}`)
    if (comparison.state === 'WORKER_ERROR') emit.err(`${id}: WORKER_ERROR: ${JSON.stringify({ baseline: summaries.baseline.nativeErrors, candidate: summaries.candidate.nativeErrors })}`)
  }
  const report = { version: 1, createdAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, node: process.version,
    seed, scale, timeoutMs, warmups: WARMUPS, rounds: ROUNDS, cache: 'warm', measurement: 'direct spawn-to-close', engines, rows, comparisons }
  writeReportExclusive(output, report)
  emit.table(comparisons.map(({ id, state, speedup }) => ({ query: id, state,
    baselineMs: rows.find(row => `${row.fixture}/${row.query.id}` === id && row.engine === 'baseline').medianMs?.toFixed(2) ?? '-',
    candidateMs: rows.find(row => `${row.fixture}/${row.query.id}` === id && row.engine === 'candidate').medianMs?.toFixed(2) ?? '-',
    baselineTimeouts: rows.find(row => `${row.fixture}/${row.query.id}` === id && row.engine === 'baseline').timeouts,
    candidateTimeouts: rows.find(row => `${row.fixture}/${row.query.id}` === id && row.engine === 'candidate').timeouts,
    speedup: speedup === null ? '-' : `${speedup.toFixed(2)}x` })))
  emit.out(`Report: ${output}`)
  return { report, output, exitCode: comparisons.some(({ state }) => !ACCEPTED_STATES.includes(state)) ? 1 : 0 }
}
