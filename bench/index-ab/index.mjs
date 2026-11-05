/**
 * G4 (#614): index-versus-walk A/B on one corpus with the same worker binary.
 *
 * Both arms send the same envelope and differ only in the trusted cache_dir field, so
 * the measured difference is the host's opt-in index gate, not a different tool. The
 * command never selects a default: it records evidence, and byte identity between the
 * arms and successful, complete measured results are the pass/fail gates.
 *
 * @module dsh-ops/bench/index-ab
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { REPO_ROOT } from '../lib/env.mjs'
import { INDEX_AB_FORMAT, QUERIES, RECIPE, corpusHash, describeCorpus, median, percentile95, prepareCorpus, round } from './plan.mjs'
import { parseResult, runWorker, workerRequest, workerSha256 } from './measure.mjs'
import { budgetFor, compareCase, renderMarkdown } from './report.mjs'

/** Default rounds per query and arm; bounded because this is evidence, not load testing. */
export const DEFAULT_REPEAT = 5
/** Default discarded warm-up rounds; one already pays the first-touch page-cache cost. */
export const DEFAULT_WARMUP = 1
/** Upper bounds keep a typo from turning the command into a load generator. */
export const MAX_REPEAT = 10
export const MAX_WARMUP = 5

const WORKER_NAME = process.platform === 'win32' ? 'dsh-ops-worker.exe' : 'dsh-ops-worker'

/** The help text. */
export function usage() {
  return [
    'usage: node bench/cli.mjs index-ab [options]',
    '',
    'Same corpus, same worker binary: glob with no cache_dir (walk) versus with it (index gate).',
    '',
    '  --root <dir>       measure an existing corpus instead of generating the recipe',
    '  --fresh            rebuild the generated corpus (refused for --root)',
    '  --repeat <n>       measured rounds per query and arm, 1..' + MAX_REPEAT + ' (default ' + DEFAULT_REPEAT + ')',
    '  --warmup <n>       discarded rounds before measurement, 0..' + MAX_WARMUP + ' (default ' + DEFAULT_WARMUP + ')',
    '  --worker <path>    worker binary (default: native/target/release/' + WORKER_NAME + ')',
    '  --out <file>       JSON evidence path; must not exist',
    '  --markdown <file>  optional Markdown table path; must not exist',
    '  --dry-run          print the plan; create nothing',
    '  --self-test        run the dependency-free checks and exit',
  ].join('\n')
}

/**
 * Parse the command line. Values are validated here so a malformed run cannot
 * silently measure a different workload.
 * @param {string[]} argv - arguments after the subcommand.
 * @returns {object} the options.
 */
export function parseArgs(argv) {
  const options = { root: null, fresh: false, repeat: DEFAULT_REPEAT, warmup: DEFAULT_WARMUP, worker: null, out: null, markdown: null, dryRun: false, selfTest: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '-h' || flag === '--help') { options.help = true; continue }
    if (flag === '--dry-run') { options.dryRun = true; continue }
    if (flag === '--self-test') { options.selfTest = true; continue }
    if (flag === '--fresh') { options.fresh = true; continue }
    const value = argv[index + 1]
    if (value === undefined || value === '' || value.startsWith('--')) throw new Error('this flag needs a value: ' + flag)
    if (flag === '--root') options.root = path.resolve(value)
    else if (flag === '--worker') options.worker = path.resolve(value)
    else if (flag === '--out') options.out = path.resolve(value)
    else if (flag === '--markdown') options.markdown = path.resolve(value)
    else if (flag === '--repeat') {
      const repeat = Number(value)
      if (!Number.isInteger(repeat) || repeat < 1 || repeat > MAX_REPEAT) throw new Error('--repeat must be an integer in 1..' + MAX_REPEAT)
      options.repeat = repeat
    } else if (flag === '--warmup') {
      const warmup = Number(value)
      if (!Number.isInteger(warmup) || warmup < 0 || warmup > MAX_WARMUP) throw new Error('--warmup must be an integer in 0..' + MAX_WARMUP)
      options.warmup = warmup
    } else throw new Error('unknown flag "' + flag + '"')
    index += 1
  }
  if (options.help) return options
  if (options.root !== null && options.fresh) throw new Error('--fresh only applies to the generated corpus')
  if (!options.dryRun && !options.selfTest && options.out === null) throw new Error('--out is required (evidence is never overwritten)')
  return options
}
/** Facts about the machine and the measured build, for the report header. */
export function environment(worker) {
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true })
  return {
    platformTag: process.platform + '-' + process.arch,
    node: process.version,
    kernel: os.release(),
    cpus: os.cpus().length,
    totalMemMiB: round(os.totalmem() / (1024 * 1024), 0),
    revision: git.status === 0 ? String(git.stdout).trim() : 'unknown (not a git checkout)',
    worker: path.relative(REPO_ROOT, worker).split(path.sep).join('/'),
    workerSha256: workerSha256(worker),
  }
}

/** One measured call: spawn, time, hash the exact stdout bytes. */
async function runCall(worker, query, cacheDir, timeoutMs) {
  const envelope = workerRequest({ root: runCall.root, patterns: query.patterns, cacheDir, timeoutMs })
  const measured = await runWorker({ worker, envelope, timeoutMs })
  const result = parseResult(measured.stdout)
  return {
    wallMs: measured.wallMs,
    rssKb: measured.rssKb,
    status: measured.status,
    timedOut: measured.timedOut,
    stdout: measured.stdout,
    stdoutHash: createHash('sha256').update(measured.stdout).digest('hex'),
    failed: result === null || result.status !== 'completed' || result.complete !== true || result.truncated === true,
  }
}
runCall.root = null

/** Create a private cache directory mirroring the host's 0700 index-cache preparation. */
function prepareCacheDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(dir, 0o700) } catch {}
  return dir
}

/** Runs one phase over every query and arm; the arm order alternates to cancel drift. */
async function phase(worker, corpusRoot, cacheDir, rounds, timeoutMs) {
  const observed = { walk: {}, index: {} }
  for (let round = 0; round < rounds; round += 1) {
    for (let queryIndex = 0; queryIndex < QUERIES.length; queryIndex += 1) {
      const query = QUERIES[queryIndex]
      const order = (round + queryIndex) % 2 === 0 ? ['walk', 'index'] : ['index', 'walk']
      for (const arm of order) {
        const measured = await runCall(worker, query, arm === 'index' ? cacheDir : null, timeoutMs)
        ;(observed[arm][query.id] ??= []).push(measured)
      }
    }
  }
  return observed
}

/** Dependency-free checks: the recipe is deterministic and the report arithmetic is honest. */
export async function selfTest(io) {
  const out = io?.out ?? ((line) => console.log(line))
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ops-index-ab-self-'))
  try {
    const first = path.join(temp, 'first')
    const second = path.join(temp, 'second')
    prepareCorpus(first, { fresh: true })
    prepareCorpus(second, { fresh: true })
    const shape = describeCorpus(first)
    if (corpusHash(first) !== corpusHash(second)) throw new Error('recipe must generate identical trees')
    if (shape.files !== describeCorpus(second).files) throw new Error('recipe file counts diverged')
    if (shape.files < 100 || shape.dirs < 20) throw new Error('recipe produced a corpus too small to measure')
    if (fs.existsSync(path.join(first, 'node_modules')) === false) throw new Error('excluded dependency tree missing from the fixture')
    if (median([1, 2, 3, 4]) !== 2.5) throw new Error('median is wrong')
    if (percentile95([1, 2, 3]) !== 3) throw new Error('p95 is wrong')
    if (round(1.234, 1) !== 1.2) throw new Error('round is wrong')
    const fakeRuns = (hash) => [{ wallMs: 1, rssKb: 100, stdout: hash, stdoutHash: hash, status: 0, timedOut: false, failed: false }]
    if (compareCase({ id: 'q', patterns: ['*'] }, fakeRuns('a'), fakeRuns('a')).identical !== true) throw new Error('identity compare missed equality')
    if (compareCase({ id: 'q', patterns: ['*'] }, fakeRuns('a'), fakeRuns('b')).identical !== false) throw new Error('identity compare missed a mismatch')
    const budget = budgetFor({ root: first, files: shape.files })
    if (!(budget.estimatedMiB > 0) || budget.snapshotCapMiB !== 256) throw new Error('budget arithmetic is wrong')
    const report = {
      format: INDEX_AB_FORMAT,
      environment: { platformTag: 'self-test', node: process.version, kernel: 'self-test', cpus: 1, totalMemMiB: 1, revision: 'self-test', workerSha256: 'self-test' },
      corpus: { hash: corpusHash(first), files: shape.files, dirs: shape.dirs, bytes: shape.bytes, maxDepth: shape.maxDepth },
      options: { repeat: 1, warmup: 0 },
      budget,
      cold: [],
      cases: [{ id: 'q', patterns: ['*'], walk: { medianMs: 1, p95Ms: 1, medianRssKb: 1 }, index: { medianMs: 1, p95Ms: 1, medianRssKb: 1 }, deltaMs: 0, pairedDeltaMs: 0, deltaPct: 0, rssDeltaKb: 0, identical: true }],
      verdict: { outputsIdentical: true, failures: [] },
    }
    const markdown = renderMarkdown(report)
    if (!markdown.includes('corpus sha256') || !markdown.includes('snapshot cap')) throw new Error('markdown omits required evidence')
    out('index-ab self-test: ok')
    return 0
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

/** The command entry point. */
export async function main(argv, io = {}) {
  const out = io.out ?? ((line) => console.log(line))
  const err = io.err ?? ((line) => console.error(line))
  let options
  try { options = parseArgs(argv) } catch (error) { err('bench index-ab: ' + String(error?.message ?? error)); err('run "node bench/cli.mjs index-ab --help" for usage'); return 2 }
  if (options.help) { out(usage()); return 0 }
  if (options.selfTest) { try { return await selfTest(io) } catch (error) { err('bench index-ab self-test: ' + String(error?.message ?? error)); return 1 } }
  const worker = options.worker ?? path.join(REPO_ROOT, 'native', 'target', 'release', WORKER_NAME)
  if (!fs.existsSync(worker) || !fs.statSync(worker).isFile()) { err('bench index-ab: worker binary not found: ' + worker); return 2 }
  const corpusRoot = options.root ?? path.join(REPO_ROOT, 'bench', 'runs', 'index-ab', RECIPE.id + '-' + RECIPE.seed.toString(16), 'corpus')
  const cacheDir = path.join(path.dirname(corpusRoot), 'cache')
  if (options.out !== null && fs.existsSync(options.out)) { err('bench index-ab: refusing to overwrite evidence: ' + options.out); return 2 }
  if (options.markdown !== null && fs.existsSync(options.markdown)) { err('bench index-ab: refusing to overwrite evidence: ' + options.markdown); return 2 }
  const plan = { corpusRoot, cacheDir, worker, repeat: options.repeat, warmup: options.warmup, queries: QUERIES.map((query) => ({ id: query.id, patterns: query.patterns })) }
  if (options.dryRun) { out(JSON.stringify(plan, null, 2)); return 0 }
  if (options.root === null) {
    try {
      if (options.fresh || !fs.existsSync(corpusRoot)) prepareCorpus(corpusRoot, { fresh: options.fresh })
      else if (!fs.statSync(corpusRoot).isDirectory()) throw new Error('generated corpus path is not a directory: ' + corpusRoot)
    } catch (error) { err('bench index-ab: ' + String(error?.message ?? error)); return 2 }
  }
  else if (!fs.existsSync(corpusRoot) || !fs.statSync(corpusRoot).isDirectory()) { err('bench index-ab: --root is not a directory: ' + corpusRoot); return 2 }
  prepareCacheDir(cacheDir)
  const shape = describeCorpus(corpusRoot)
  const corpus = { root: corpusRoot, hash: corpusHash(corpusRoot), files: shape.files, dirs: shape.dirs, symlinks: shape.symlinks, bytes: shape.bytes, maxDepth: shape.maxDepth, recipe: options.root === null ? RECIPE : null }
  runCall.root = corpusRoot
  const timeoutMs = 120_000
  out('[index-ab] corpus ' + corpus.files + ' files / ' + corpus.dirs + ' dirs / ' + corpus.bytes + ' bytes; sha256 ' + corpus.hash.slice(0, 16))
  try {
    // Cold: the first touch per arm; page cache is NOT dropped (no root), which the docs state.
    const coldWalk = await phase(worker, corpusRoot, cacheDir, 1, timeoutMs)
    const cold = QUERIES.map((query) => {
      const walkRun = coldWalk.walk[query.id][0]
      const indexRun = coldWalk.index[query.id][0]
      return {
        id: query.id, patterns: query.patterns,
        walk: round(walkRun.wallMs, 2), index: round(indexRun.wallMs, 2),
        delta: round(indexRun.wallMs - walkRun.wallMs, 2), identical: walkRun.stdoutHash === indexRun.stdoutHash,
        runs: {
          walk: { status: walkRun.status, timedOut: walkRun.timedOut, failed: walkRun.failed },
          index: { status: indexRun.status, timedOut: indexRun.timedOut, failed: indexRun.failed },
        },
      }
    })
    if (options.warmup > 0) { await phase(worker, corpusRoot, cacheDir, options.warmup, timeoutMs); out('[index-ab] discarded ' + options.warmup + ' warm-up round(s)') }
    const measured = await phase(worker, corpusRoot, cacheDir, options.repeat, timeoutMs)
    const cases = QUERIES.map((query) => compareCase(query, measured.walk[query.id], measured.index[query.id]))
    const failures = []
    for (const item of cold) {
      if (!item.identical) failures.push('cold ' + item.id + ' output differs')
      for (const [arm, run] of Object.entries(item.runs)) {
        const label = 'cold ' + item.id + ' ' + arm
        if (run.status !== 0) failures.push(label + ' exit ' + run.status)
        if (run.timedOut) failures.push(label + ' timed out')
        if (run.failed) failures.push(label + ' returned a failed/incomplete result')
      }
    }
    for (const item of cases) {
      if (!item.identical) failures.push('warm ' + item.id + ' output differs')
      const runs = measured.walk[item.id].concat(measured.index[item.id])
      for (const run of runs) { if (run.status !== 0) failures.push(item.id + ' exit ' + run.status); if (run.timedOut) failures.push(item.id + ' timed out'); if (run.failed) failures.push(item.id + ' returned a failed/incomplete result') }
    }
    const census = new Set(cases.map((item) => item.walk.statuses.concat(item.index.statuses).join(',')))
    const budget = budgetFor(corpus)
    const report = {
      format: INDEX_AB_FORMAT,
      generatedAt: new Date().toISOString(),
      environment: environment(worker),
      corpus,
      options: { repeat: options.repeat, warmup: options.warmup, timeoutMs, queries: QUERIES.map((query) => ({ id: query.id, patterns: query.patterns })) },
      budget,
      cold,
      cases,
      verdict: { outputsIdentical: cold.every((item) => item.identical) && cases.every((item) => item.identical), failures },
    }
    if (options.out !== null) fs.writeFileSync(options.out, JSON.stringify(report, null, 2) + '\n')
    const markdown = renderMarkdown(report)
    if (options.markdown !== null) fs.writeFileSync(options.markdown, markdown + '\n')
    out(markdown)
    out('')
    if (failures.length > 0) { for (const failure of failures) err('bench index-ab: FAIL ' + failure); return 1 }
    out('[index-ab] unique exit status sets: ' + [...census].join(' | '))
    return 0
  } catch (error) { err('bench index-ab: ' + String(error?.stack ?? error)); return 1 }
}
