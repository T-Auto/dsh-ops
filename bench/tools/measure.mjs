/**
 * The measurement primitives behind the model-free tool-level comparison (#103).
 *
 * Nothing in this module decides anything from a duration. {@link compare} derives
 * its state from output hashes, error envelopes and harness failures only; the
 * watchdog classifies a hung run as `TIMEOUT` (a harness failure, not a speed
 * threshold), and `medianMs` is human evidence that is printed, never asserted.
 *
 * @module dsh-ops/bench/tools/measure
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'

/** SHA-256 of arbitrary bytes, as hex. */
export const sha256 = value => createHash('sha256').update(value).digest('hex')

/**
 * Query-specific reviewed semantic migrations, keyed `<fixture>/<id>`.
 *
 * The allowlist is deliberately empty: a future change must document the
 * migration and add its own correctness test before an entry appears here. An
 * entry means "this output difference is intended", never "this is faster".
 */
export const EXPECTED_DIFFERENCES = Object.freeze({}) // 'fixture/query': 'specific reviewed semantic migration'

/**
 * Canonical JSON for equality: object keys sorted, array order preserved, and
 * the timing noise (`elapsedMs` / `durationMs`) dropped at every level.
 *
 * Paths, text, totals, completion and truncation fields are all preserved on
 * purpose — a difference in any of them is a semantic difference.
 * @param {unknown} value - the value to canonicalize.
 * @returns {string} a stable JSON string.
 */
export function canonical(value) {
  const normalize = item => {
    if (Array.isArray(item)) return item.map(normalize)
    if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort()
      .filter(key => !['elapsedMs', 'durationMs'].includes(key)).map(key => [key, normalize(item[key])]))
    return item
  }
  return JSON.stringify(normalize(value))
}

/**
 * The median of the given numbers, or `null` for an empty list. Even counts
 * average the two middle values.
 * @param {number[]} values - the samples.
 * @returns {number|null} the median.
 */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length ? (sorted[middle] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2 : null
}

/**
 * Spawn one worker, deliver one request on stdin, collect one JSON envelope.
 *
 * Direct native workers have no subprocess descendants, so the watchdog kills
 * only the direct child this call owns and still waits for `close` before the
 * next run: a killed process that is not reaped would make the next measurement
 * run against a busy machine. Stdout has a separate harness cap; overflow is a
 * failed run, never a truncated JSON success.
 *
 * @param {string} binary - the worker executable.
 * @param {unknown} request - the JSON request written to stdin.
 * @param {object} [options] - run inputs.
 * @param {number} [options.timeoutMs] - per-process watchdog.
 * @param {number} [options.maxOutputBytes] - harness stdout cap.
 * @param {string[]} [options.args] - extra argv before the request.
 * @returns {Promise<{state: string, ms: number, outputBytes: number, value: unknown, error: string, stderr: string, pid: number|undefined}>} the run.
 */
export function runWorker(binary, request, { timeoutMs = 60000, maxOutputBytes = 16 * 1024 * 1024, args = [] } = {}) {
  return new Promise(resolve => {
    const started = performance.now()
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let state = 'OK', error = '', outputBytes = 0, stderr = ''
    const chunks = []
    const stop = reason => { if (state === 'OK') { state = reason; child.kill('SIGKILL') } }
    const timer = setTimeout(() => stop('TIMEOUT'), timeoutMs)
    child.on('error', cause => { state = 'ERROR'; error = cause.message })
    child.stdin.on('error', cause => { if (cause.code !== 'EPIPE' && state === 'OK') { error = cause.message; stop('ERROR') } })
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length
      if (outputBytes > maxOutputBytes) stop('OUTPUT_LIMIT')
      else if (state === 'OK') chunks.push(chunk)
    })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(0, 4096) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const ms = performance.now() - started
      let value
      if (state === 'OK') {
        try {
          if (code !== 0 || signal) throw new Error(`worker exited ${code ?? signal}`)
          value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (!value || !['completed', 'error'].includes(value.status)) throw new Error('worker returned an invalid result envelope')
        } catch (cause) { state = 'ERROR'; error = cause.message }
      }
      resolve({ state, ms, outputBytes, value, error, stderr, pid: child.pid })
    })
    child.stdin.end(JSON.stringify(request))
  })
}

/**
 * Reduce one engine's runs to the evidence and eligibility flags {@link compare}
 * needs. The warmup is included in stability and eligibility checks, but the
 * medians cover the timed runs only, and timeout/error runs are excluded from
 * every median — a hung or crashed sample must not move the number that is
 * printed.
 *
 * @param {object[]} runs - the timed runs of one engine.
 * @param {object|null} [warmup] - the separate warmup run.
 * @returns {object} the summary.
 */
export function summarize(runs, warmup = null) {
  const all = warmup ? [warmup, ...runs] : runs
  const valid = runs.filter(run => run.state === 'OK' && run.value?.status === 'completed')
  const rejections = runs.filter(run => run.state === 'OK' && run.value?.status === 'error')
  const hashes = [...new Set(all.filter(run => run.state === 'OK').map(run => sha256(canonical(run.value))))]
  return {
    runsMs: valid.map(run => run.ms), medianMs: median(valid.map(run => run.ms)),
    rejectedRunsMs: rejections.map(run => run.ms), rejectionMedianMs: median(rejections.map(run => run.ms)),
    timeouts: runs.filter(run => run.state === 'TIMEOUT').length,
    errors: runs.filter(run => run.state !== 'OK' && run.state !== 'TIMEOUT').length,
    warmupState: warmup?.state ?? null,
    outputBytes: Math.max(0, ...runs.map(run => run.outputBytes ?? 0)),
    resultHash: hashes.length === 1 ? hashes[0] : null,
    unstable: hashes.length > 1,
    eligible: all.length > 0 && all.every(run => run.state === 'OK' && run.value?.status === 'completed') && hashes.length === 1,
    sample: all.find(run => run.state === 'OK')?.value,
    nativeErrors: [...new Map(all.filter(run => run.state === 'OK' && run.value?.status === 'error')
      .map(run => [canonical(run.value.error), run.value.error])).values()],
    failures: all.filter(run => run.state !== 'OK').map(({ state, error, stderr }) => ({ state, error, stderr })),
  }
}

/**
 * Classify one baseline/candidate pair. The order of the branches IS the
 * semantics and must not be reordered:
 *
 * 1. `TIMEOUT` — a timed run or a warmup hit the watchdog;
 * 2. `ERROR` — the harness failed, or the worker never answered with an envelope;
 * 3. `UNSTABLE` — either side produced more than one distinct output. Both sides
 *    unstable is still `UNSTABLE`, even when their hash sets happen to match:
 *    two engines that cannot repeat themselves cannot be compared;
 * 4. `EXPECTED_DIFFERENCE` / `MISMATCH` — stable but different output;
 * 5. `EXPECTED_REJECTION` — both sides returned the SAME error envelope whose
 *    code was declared for this query. Identical errors that were not declared
 *    fall through to `WORKER_ERROR` at step 6, so a crash can never be reported
 *    as a successful (let alone faster) comparison;
 * 6. `WORKER_ERROR` — an unexpected native error envelope on either side;
 * 7. `MATCH` — stable identical successful JSON.
 *
 * `speedup` is filled in only for `MATCH`; all other states carry `null`. (Issue
 * #205 called `MISMATCH` `UNEXPECTED_DIFFERENCE`; the code name is kept.)
 *
 * @param {object} baseline - the baseline summary.
 * @param {object} candidate - the candidate summary.
 * @param {string|null} [expectedDifference] - a reviewed migration reason.
 * @param {string|null} [expectedError] - a declared rejection code for this query.
 * @returns {{state: string, sameAsBaseline: boolean, expectedDifference: string|null, speedup: number|null}} the comparison.
 */
export function compare(baseline, candidate, expectedDifference = null, expectedError = null) {
  const sameAsBaseline = baseline.resultHash !== null && baseline.resultHash === candidate.resultHash
  let state
  if (baseline.timeouts || candidate.timeouts || baseline.warmupState === 'TIMEOUT' || candidate.warmupState === 'TIMEOUT') state = 'TIMEOUT'
  else if (baseline.errors || candidate.errors || baseline.failures.length || candidate.failures.length) state = 'ERROR'
  else if (baseline.unstable || candidate.unstable) state = 'UNSTABLE'
  else if (!sameAsBaseline) state = expectedDifference ? 'EXPECTED_DIFFERENCE' : 'MISMATCH'
  else if (expectedError && baseline.sample?.error?.code === expectedError && candidate.sample?.error?.code === expectedError) state = 'EXPECTED_REJECTION'
  else if (!baseline.eligible || !candidate.eligible) state = 'WORKER_ERROR'
  else state = 'MATCH'
  return { state, sameAsBaseline, expectedDifference, speedup: state === 'MATCH' && candidate.medianMs > 0 ? baseline.medianMs / candidate.medianMs : null }
}

/**
 * The first differing JSON location between two samples, for the report's
 * diagnostic column. `null` means the two values are canonically equal.
 * @param {unknown} left - the baseline value.
 * @param {unknown} right - the candidate value.
 * @param {string} [location] - the JSON path prefix.
 * @returns {string|null} the described difference.
 */
export function firstDifference(left, right, location = '$') {
  if (canonical(left) === canonical(right)) return null
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      const difference = firstDifference(left[key], right[key], `${location}.${key}`)
      if (difference) return difference
    }
  }
  const preview = value => String(canonical(value)).slice(0, 160)
  return `${location}: ${preview(left)} -> ${preview(right)}`
}
