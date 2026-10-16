#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { createFixtures, cleanupOwned, SEED } from './fixtures.mjs'
import { sha256, runWorker, summarize, compare, firstDifference, EXPECTED_DIFFERENCES } from './measure.mjs'

const HELP = `Manual file benchmark (release vs release, warm filesystem, direct worker).
node bench/files.mjs --baseline <worker> --candidate <worker> --out <new.json>
  --temp-dir <existing directory>  fixture parent (default: OS temp)
  --scale <number>                file count multiplier, >0..10 (default: 1)
  --timeout-ms <integer>          per-process watchdog (default: 60000)
Always one warmup per engine followed by five alternating paired rounds.
The report is created exclusively; existing files are never overwritten.
inspect has no outputMode parameter; grep/glob always declare it.`

async function main() {
  const { values } = parseArgs({ options: {
    baseline: { type: 'string' }, candidate: { type: 'string' }, out: { type: 'string' },
    'temp-dir': { type: 'string' }, scale: { type: 'string', default: '1' },
    'timeout-ms': { type: 'string', default: '60000' }, help: { type: 'boolean' },
  } })
  if (values.help) { console.log(HELP); return }
  if (!values.baseline || !values.candidate || !values.out) throw new Error(`--baseline, --candidate and --out are required\n${HELP}`)
  const scale = Number(values.scale), timeoutMs = Number(values['timeout-ms'])
  if (!Number.isFinite(scale) || scale <= 0 || scale > 10) throw new Error('scale must be > 0 and <= 10')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error('timeout-ms must be an integer in 1..2147483647')
  const output = path.resolve(values.out), parent = path.resolve(values['temp-dir'] ?? os.tmpdir())
  if (fs.existsSync(output)) throw new Error(`Refusing to overwrite report: ${output}`)
  if (!fs.statSync(path.dirname(output)).isDirectory() || !fs.statSync(parent).isDirectory()) throw new Error('Output and temporary parent directories must exist')
  const engines = Object.fromEntries(['baseline', 'candidate'].map(engine => {
    const binary = fs.realpathSync(path.resolve(values[engine]))
    if (!fs.statSync(binary).isFile()) throw new Error(`Not a worker file: ${binary}`)
    const binarySha256 = sha256(fs.readFileSync(binary))
    console.log(`${engine}: ${binary}\n  SHA-256 ${binarySha256}`)
    return [engine, { binary, binarySha256 }]
  }))
  console.log(`seed=${SEED}, scale=${scale}, watchdog=${timeoutMs}ms; warm runs, spawn-to-close; no timing gate`)
  console.log('Release provenance is caller-supplied; binary hashes identify files, not build profiles or source commits.')
  const fixtures = createFixtures({ parent, scale })
  const rows = [], comparisons = []
  try {
    for (const query of fixtures.cases) {
      const id = `${query.fixture}/${query.id}`
      console.log(`Running ${id}`)
      const request = { root: fixtures.root, scope: 'file-benchmark-87', read_only: true, tool: query.tool, args: query.args }
      const runs = { baseline: [], candidate: [] }, warmup = {}
      for (const engine of ['baseline', 'candidate']) warmup[engine] = await runWorker(engines[engine].binary, request, { timeoutMs })
      for (let round = 0; round < 5; round++) {
        for (const engine of round % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
          runs[engine].push(await runWorker(engines[engine].binary, request, { timeoutMs }))
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
      if (!comparison.sameAsBaseline) console.error(`${id}: ${comparison.state}: ${comparisons.at(-1).difference ?? 'no comparable complete JSON'}`)
      if (comparison.state === 'WORKER_ERROR') console.error(`${id}: WORKER_ERROR: ${JSON.stringify({ baseline: summaries.baseline.nativeErrors, candidate: summaries.candidate.nativeErrors })}`)
    }
    const report = { version: 1, createdAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, node: process.version,
      seed: SEED, scale, timeoutMs, warmups: 1, rounds: 5, cache: 'warm', measurement: 'direct spawn-to-close', engines, rows, comparisons }
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
    console.table(comparisons.map(({ id, state, speedup }) => ({ query: id, state,
      baselineMs: rows.find(row => `${row.fixture}/${row.query.id}` === id && row.engine === 'baseline').medianMs?.toFixed(2) ?? '-',
      candidateMs: rows.find(row => `${row.fixture}/${row.query.id}` === id && row.engine === 'candidate').medianMs?.toFixed(2) ?? '-',
      baselineTimeouts: rows.find(row => `${row.fixture}/${row.query.id}` === id && row.engine === 'baseline').timeouts,
      candidateTimeouts: rows.find(row => `${row.fixture}/${row.query.id}` === id && row.engine === 'candidate').timeouts,
      speedup: speedup === null ? '-' : `${speedup.toFixed(2)}x` })))
    console.log(`Report: ${output}`)
    if (comparisons.some(({ state }) => !['MATCH', 'EXPECTED_DIFFERENCE', 'EXPECTED_REJECTION'].includes(state))) process.exitCode = 1
  } finally { cleanupOwned(fixtures) }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
