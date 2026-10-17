/**
 * P13's gate: the model-free tool-level comparison (#103) — the state machine,
 * the exclusive report, the median exclusion rule, and the one property this
 * whole mode exists for: **no verdict is derived from a duration**.
 *
 * The workers here are Node stand-ins driven over the real spawn/stdin/stdout
 * path (the suites must run without a native build). Each one is recognised by
 * the case marker in `request.args.pattern`, and the two engines get different
 * argv, so baseline and candidate can disagree on purpose without a mock.
 * Deliberately absent: the 168-spawn CPU-bound smoke — per issue #205 that
 * belongs to the opt-in workflow, and `npm run verify` keeps deterministic
 * checks only.
 *
 * @module dsh-ops/test/bench-tools
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { assert, report, test, withTempDir } from './lib/harness.mjs'

import { ACCEPTED_STATES, compareFiles, writeReportExclusive } from '../bench/tools/files.mjs'
import { SEED, cleanupOwned, createToolFixtures, runTools } from '../bench/tools/index.mjs'
import { canonical, compare, EXPECTED_DIFFERENCES, firstDifference, median, runWorker, sha256, summarize } from '../bench/tools/measure.mjs'

const LABEL = 'bench-tools'

/** One successful run envelope, as `summarize` expects it. */
const ok = (value, ms = 10) => ({ state: 'OK', ms, outputBytes: 8, value })
const completed = (extra = {}) => ({ status: 'completed', items: [], ...extra })

/** A Node stand-in worker: real process, real stdin/stdout, no native build. */
const standin = ({ items = ['same'], delayMs = 0 } = {}) => `
const fs = require('node:fs')
let raw = ''
process.stdin.on('data', chunk => { raw += chunk })
process.stdin.on('end', () => {
  const request = JSON.parse(raw)
  const marker = request.args.pattern
  const finish = () => {
    if (marker === 'REJECT') return process.stdout.write(JSON.stringify({ status: 'error', error: { code: 'OUTPUT_LIMIT', message: 'too large' } }))
    if (marker === 'UNSTABLE') {
      const file = request.args.stateFile
      const run = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) + 1 : 1
      fs.writeFileSync(file, String(run))
      return process.stdout.write(JSON.stringify({ status: 'completed', run }))
    }
    process.stdout.write(JSON.stringify({ status: 'completed', items: ${JSON.stringify(items)} }))
  }
  ${delayMs > 0 ? `setTimeout(finish, ${delayMs})` : 'finish()'}
})
`

/** A synthetic corpus: the same case shape the default corpus produces, marker-addressed. */
const syntheticCorpus = (root, cases) => ({
  root,
  cases: cases.map(({ id, marker, expectedError }) => ({
    fixture: 'synthetic', id, tool: 'grep',
    args: { path: path.join(root, id), pattern: marker, outputMode: 'summary', stateFile: path.join(root, `state-${id}`) },
    ...(expectedError === undefined ? {} : { expectedError }),
  })),
})

/** Capture the three output sinks so the readable table can be asserted. */
const capture = () => {
  const lines = [], errors = [], tables = []
  return { lines, errors, tables, io: { out: line => lines.push(line), err: line => errors.push(line), table: rows => tables.push(rows) } }
}

/** Every key name anywhere in a JSON tree. */
const keysOf = value => {
  const keys = new Set()
  const walk = item => {
    if (Array.isArray(item)) return item.forEach(walk)
    if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) { keys.add(key); walk(child) }
  }
  walk(value)
  return keys
}

/** The stand-in argv for one run, so a test only names what it varies. */
const engineArgs = (baseline, candidate) => ({ baseline: ['-e', baseline], candidate: ['-e', candidate] })

// ------------------------------------------------------------ pure helpers

await test('canonical JSON sorts keys, preserves order and drops only timing noise', () => {
  assert.equal(canonical({ b: 2, a: { elapsedMs: 1, durationMs: 3, text: 'x' } }), canonical({ a: { text: 'x', elapsedMs: 2 }, b: 2 }))
  assert.notEqual(canonical({ complete: true }), canonical({ complete: false }))
  assert.notEqual(canonical({ items: [1, 2] }), canonical({ items: [2, 1] }))
  assert.equal(canonical({ text: 'needle' }), canonical({ text: 'needle' }))
  assert.notEqual(canonical({ text: 'needle' }), canonical({ text: 'neele' }))
  assert.equal(median([5, 1, 4, 2, 3]), 3)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  assert.equal(median([]), null)
  assert.equal(sha256('a').length, 64)
  assert.equal(firstDifference({ a: 1 }, { a: 1 }), null)
  assert.match(firstDifference({ a: 1, b: [1, 2] }, { a: 1, b: [1, 3] }), /^\$\.b\.1: 2 -> 3$/)
  assert.deepEqual(EXPECTED_DIFFERENCES, {})
})

await test('the state machine keeps every branch, and EXPECTED_* alone is not a failure', () => {
  const base = summarize([ok(completed()), ok(completed())])
  assert.equal(compare(base, base).state, 'MATCH')
  assert.equal(compare(base, base).speedup, 1)
  const other = summarize([ok(completed({ items: ['x'] })), ok(completed({ items: ['x'] }))])
  assert.equal(compare(base, other).state, 'MISMATCH')
  assert.equal(compare(base, other).speedup, null)
  assert.equal(compare(base, other, 'reviewed semantic migration').state, 'EXPECTED_DIFFERENCE')
  assert.equal(compare(base, other, 'reviewed semantic migration').speedup, null)
  const wobbly = summarize([ok(completed()), ok(completed({ items: ['x'] }))])
  assert.equal(compare(base, wobbly).state, 'UNSTABLE')
  assert.equal(compare(wobbly, base).state, 'UNSTABLE')
  // Both sides wobbling is still UNSTABLE: two engines that cannot repeat themselves are not comparable.
  assert.equal(compare(wobbly, wobbly).state, 'UNSTABLE')
  assert.equal(compare(base, summarize([ok(completed()), { state: 'TIMEOUT', ms: 1 }])).state, 'TIMEOUT')
  assert.equal(compare(base, summarize([ok(completed())], { state: 'TIMEOUT', ms: 1 })).state, 'TIMEOUT')
  assert.equal(compare(base, summarize([ok(completed()), { state: 'ERROR', ms: 1, error: 'boom' }])).state, 'ERROR')
  // Identical error envelopes: declared for this query -> EXPECTED_REJECTION, undeclared -> WORKER_ERROR, never MATCH.
  const rejected = summarize([ok({ status: 'error', error: { code: 'OUTPUT_LIMIT', message: 'too large' } })])
  assert.equal(compare(rejected, rejected).state, 'WORKER_ERROR')
  assert.equal(compare(rejected, rejected, null, 'OUTPUT_LIMIT').state, 'EXPECTED_REJECTION')
  assert.equal(compare(rejected, rejected, null, 'OUTPUT_LIMIT').speedup, null)
  assert.equal(compare(rejected, rejected, null, 'ENOENT').state, 'WORKER_ERROR')
  assert.deepEqual(ACCEPTED_STATES, ['MATCH', 'EXPECTED_DIFFERENCE', 'EXPECTED_REJECTION'])
  // A duration difference of five orders of magnitude changes nothing about the verdict.
  const verdict = compare(summarize([ok(completed(), 1)]), summarize([ok(completed(), 100000)]))
  assert.equal(verdict.state, 'MATCH')
  assert.ok(verdict.speedup < 0.001)
})

await test('medians exclude timeout and error samples; rejection times stay separate', () => {
  const mixed = summarize([ok(completed(), 10), ok(completed(), 20), { state: 'TIMEOUT', ms: 9999 }, { state: 'ERROR', ms: 9999, error: 'boom' }])
  assert.deepEqual(mixed.runsMs, [10, 20])
  assert.equal(mixed.medianMs, 15)
  assert.equal(mixed.timeouts, 1)
  assert.equal(mixed.errors, 1)
  assert.equal(mixed.eligible, false)
  assert.equal(mixed.unstable, false)
  assert.equal(mixed.failures.length, 2)
  const rejection = summarize([ok(completed(), 30), ok({ status: 'error', error: { code: 'OUTPUT_LIMIT', message: 'too large' } }, 7)])
  assert.equal(rejection.medianMs, 30)
  assert.deepEqual(rejection.rejectedRunsMs, [7])
  assert.equal(rejection.rejectionMedianMs, 7)
  assert.equal(rejection.nativeErrors[0].code, 'OUTPUT_LIMIT')
  assert.equal(rejection.resultHash, null, 'one success and one rejection is not one stable output')
  assert.equal(rejection.unstable, true)
})

await test('the watchdog classifies failures and reaps only the direct child it owns', async () => {
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  try {
    const success = await runWorker(process.execPath, {}, { args: ['-e', 'process.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({status:"completed"})))'], timeoutMs: 5000 })
    assert.equal(success.state, 'OK')
    assert.equal(success.value.status, 'completed')
    const timeout = await runWorker(process.execPath, {}, { args: ['-e', 'setTimeout(()=>{},60000)'], timeoutMs: 100 })
    assert.equal(timeout.state, 'TIMEOUT')
    assert.throws(() => process.kill(timeout.pid, 0), 'the killed direct child must be reaped before the next run')
    assert.doesNotThrow(() => process.kill(sentinel.pid, 0), 'an unrelated process must survive the watchdog')
    const invalid = await runWorker(process.execPath, {}, { args: ['-e', 'console.log("incomplete{")'], timeoutMs: 5000 })
    assert.equal(invalid.state, 'ERROR')
    const overflow = await runWorker(process.execPath, {}, { args: ['-e', 'process.stdout.write("x".repeat(4096))'], maxOutputBytes: 1024, timeoutMs: 5000 })
    assert.equal(overflow.state, 'OUTPUT_LIMIT')
    assert.equal((await runWorker(path.join(os.tmpdir(), 'missing-dsh-ops-bench-worker.exe'), {}, { timeoutMs: 5000 })).state, 'ERROR')
  } finally {
    sentinel.kill('SIGKILL')
  }
})

// ---------------------------------------------------------------- fixtures

await test('the tool corpus keeps every boundary, scales counts only and refuses foreign data', async () => {
  await withTempDir('bench-tools-fixtures-', dir => {
    const first = createToolFixtures({ parent: dir, scale: 0.001 })
    const second = createToolFixtures({ parent: dir, scale: 0.001 })
    try {
      assert.equal(SEED, 870016)
      assert.deepEqual([...new Set(first.cases.map(entry => entry.fixture))], ['small-files', 'deep-tree', 'big-file', 'dense-hits', 'edge-text'])
      assert.equal(fs.statSync(path.join(first.root, 'big-file', 'large.txt')).size, 33 * 1024 * 1024)
      assert.equal(fs.statSync(path.join(first.root, 'big-file', 'window.txt')).size, 8 * 1024 * 1024)
      assert.equal(fs.statSync(path.join(first.root, 'edge-text', 'long.txt')).size, 1024 * 1024 + 1)
      const relative = 'small-files/d000/f00000.txt'
      assert.equal(fs.statSync(path.join(first.root, relative)).size, 4096)
      assert.deepEqual(fs.readFileSync(path.join(first.root, relative)), fs.readFileSync(path.join(second.root, relative)), 'the seed must reproduce the same bytes')
      for (const query of first.cases.filter(entry => entry.tool !== 'inspect_local_file')) assert.ok(query.args.outputMode, `${query.fixture}/${query.id} must declare outputMode`)
      assert.equal(first.cases.find(entry => entry.id === 'inspect-oversize').expectedError, 'OUTPUT_LIMIT')
      const foreign = path.join(first.root, 'user-data.txt')
      fs.writeFileSync(foreign, 'keep')
      assert.throws(() => cleanupOwned(first), /Unexpected file/i)
      assert.equal(fs.readFileSync(foreign, 'utf8'), 'keep')
      fs.unlinkSync(foreign)
    } finally {
      cleanupOwned(first)
      cleanupOwned(second)
      assert.deepEqual(fs.readdirSync(dir), [], 'cleanup must remove exactly what it created')
    }
  })
})

await test('the report is created exclusively: an existing path fails instead of overwriting', async () => {
  await withTempDir('bench-tools-wx-', dir => {
    const output = path.join(dir, 'report.json')
    writeReportExclusive(output, { version: 1 })
    const before = fs.readFileSync(output)
    assert.throws(() => writeReportExclusive(output, { version: 2 }), /EEXIST/)
    assert.deepEqual(fs.readFileSync(output), before)
  })
})

// ------------------------------------------------------------------- runs

await test('runTools matches identical output, prints the table and accepts EXPECTED_* states', async () => {
  await withTempDir('bench-tools-run-', async dir => {
    const corpus = syntheticCorpus(dir, [{ id: 'ok', marker: 'OK' }, { id: 'reject', marker: 'REJECT', expectedError: 'OUTPUT_LIMIT' }])
    const output = path.join(dir, 'report.json')
    const options = { baseline: process.execPath, candidate: process.execPath, out: output, tempDir: dir, corpus,
      args: engineArgs(standin(), standin({ delayMs: 120 })), io: capture().io }
    const run = capture()
    const result = await runTools({ ...options, io: run.io })
    assert.equal(result.exitCode, 0, 'MATCH and EXPECTED_REJECTION are intended outcomes')
    assert.equal(result.output, output)
    assert.equal(result.report.version, 1)
    assert.equal(result.report.seed, SEED)
    assert.equal(result.report.rounds, 5)
    assert.equal(result.report.warmups, 1)
    assert.equal(result.report.rows.length, 4)
    assert.deepEqual(Object.fromEntries(result.report.comparisons.map(entry => [entry.id, entry.state])),
      { 'synthetic/ok': 'MATCH', 'synthetic/reject': 'EXPECTED_REJECTION' })
    for (const row of result.report.rows) {
      assert.equal(row.warmupState, 'OK')
      // Five timed rounds per engine; a declared rejection has no successful median.
      if (row.query.id === 'ok') assert.equal(row.runsMs.length, 5)
      else { assert.deepEqual(row.runsMs, []); assert.equal(row.rejectedRunsMs.length, 5) }
    }
    const medianOf = engine => result.report.rows.find(row => row.query.id === 'ok' && row.engine === engine).medianMs
    assert.ok(medianOf('candidate') > medianOf('baseline'), `the slowed candidate must really be slower (${medianOf('baseline')} -> ${medianOf('candidate')} ms)`)
    assert.equal(result.report.comparisons[0].speedup > 0, true, 'the slowdown is reported as a ratio, never as a verdict')
    assert.equal(result.report.comparisons[0].state, 'MATCH', 'a slower but identical candidate still matches: no time threshold exists')
    assert.equal(run.tables.length, 1)
    assert.deepEqual(run.tables[0].map(row => [row.query, row.state]), [['synthetic/ok', 'MATCH'], ['synthetic/reject', 'EXPECTED_REJECTION']])
    assert.ok(run.tables[0].every(row => 'baselineMs' in row && 'candidateMs' in row && 'speedup' in row))
    assert.ok(run.lines.some(line => line.includes('no timing gate')))
    assert.ok(run.lines.some(line => line.includes(`Report: ${output}`)))
    // No verdict field is a duration: the comparison is exactly state + evidence.
    assert.deepEqual(Object.keys(result.report.comparisons[0]).sort(), ['difference', 'expectedDifference', 'id', 'sameAsBaseline', 'speedup', 'state'])
    const keys = keysOf(result.report)
    assert.deepEqual([...keys].filter(key => /^(passed|pass|ok|failed|fail|withinBudget|maxMs|budgetMs|timeGate|threshold|verdict)$/i.test(key)), [])
    for (const key of keys) {
      if (/ms$|time|elapsed|duration|latency|budget|speedup/i.test(key)) assert.ok(!/^(pass|passed|fail|failed|within|exceeded)$/i.test(key), `${key} looks like a duration-derived verdict`)
    }
    // Rerunning at the same path must refuse, not replace the evidence.
    const before = fs.readFileSync(output)
    await assert.rejects(runTools({ ...options, io: capture().io }), /Refusing to overwrite report/)
    assert.deepEqual(fs.readFileSync(output), before)
  })
})

await test('a stable output difference is a MISMATCH and exits 1 with the first difference', async () => {
  await withTempDir('bench-tools-mismatch-', async dir => {
    const run = capture()
    const result = await runTools({ baseline: process.execPath, candidate: process.execPath, out: path.join(dir, 'report.json'), tempDir: dir,
      corpus: syntheticCorpus(dir, [{ id: 'ok', marker: 'OK' }]),
      args: engineArgs(standin({ items: ['baseline'] }), standin({ items: ['candidate'] })), io: run.io })
    assert.equal(result.report.comparisons[0].state, 'MISMATCH')
    assert.equal(result.report.comparisons[0].speedup, null)
    assert.match(result.report.comparisons[0].difference, /^\$\.items\.0: "baseline" -> "candidate"$/)
    assert.equal(result.exitCode, 1)
    assert.ok(run.errors.some(line => line.includes('synthetic/ok: MISMATCH')))
  })
})

await test('an engine that cannot repeat itself is UNSTABLE, on one side or both', async () => {
  await withTempDir('bench-tools-unstable-', async dir => {
    const result = await runTools({ baseline: process.execPath, candidate: process.execPath, out: path.join(dir, 'report.json'), tempDir: dir,
      corpus: syntheticCorpus(dir, [{ id: 'wobble', marker: 'UNSTABLE' }]),
      args: engineArgs(standin(), standin()), io: capture().io })
    assert.equal(result.report.comparisons[0].state, 'UNSTABLE')
    assert.equal(result.report.comparisons[0].sameAsBaseline, false)
    assert.equal(result.report.comparisons[0].speedup, null)
    assert.ok(result.report.rows.every(row => row.unstable && row.resultHash === null))
    assert.equal(result.exitCode, 1)
  })
})

await test('a corpus passed in is the caller\'s to keep; only the default one is removed', async () => {
  await withTempDir('bench-tools-ownership-', async dir => {
    const root = path.join(dir, 'corpus')
    fs.mkdirSync(root)
    const result = await runTools({ baseline: process.execPath, candidate: process.execPath, out: path.join(dir, 'report.json'), tempDir: dir,
      corpus: syntheticCorpus(root, [{ id: 'ok', marker: 'OK' }]), args: engineArgs(standin(), standin()), io: capture().io })
    assert.equal(result.exitCode, 0)
    assert.ok(fs.statSync(root).isDirectory(), 'an injected corpus must survive the run')
    assert.deepEqual(fs.readdirSync(root), [], 'runTools writes nothing into a corpus it did not create')
  })
})

await test('the default corpus is removed even when the run fails before spawning', async () => {
  await withTempDir('bench-tools-default-', async dir => {
    const output = path.join(dir, 'report.json')
    fs.writeFileSync(output, '{}')
    await assert.rejects(runTools({ baseline: process.execPath, candidate: process.execPath, out: output, tempDir: dir, scale: 0.001,
      args: engineArgs(standin(), standin()), io: capture().io }), /Refusing to overwrite report/)
    assert.deepEqual(fs.readdirSync(dir), ['report.json'], 'the default corpus must be cleaned up however the run ends')
  })
})

await test('compareFiles refuses to run without a corpus rather than guessing one', async () => {
  await withTempDir('bench-tools-guard-', async dir => {
    await assert.rejects(compareFiles({ baseline: process.execPath, candidate: process.execPath, out: path.join(dir, 'r.json'), tempDir: dir }),
      /corpus with a cases array/)
  })
})

report(LABEL)
