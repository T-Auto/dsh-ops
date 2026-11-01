#!/usr/bin/env node
/**
 * `bench calls`: host-dispatched tool-call latency over a **real** corpus, measured on
 * official `glob`/`grep` versus `ops_*`, or two OPS builds in one process, with
 * the shape and hash of the input recorded around the run.
 *
 * This is deliberately a different measurement from `bench tools`: that one compares two
 * worker binaries on a synthetic size-boundary corpus, this one compares two *tool
 * surfaces* the model actually sees, over a tree that exists on this machine. Both refuse
 * to judge a duration; the report is evidence, and exit 1 means "the run is not usable"
 * (a tool error, a mutated input, or a corpus outside its declared shape), never "slower".
 *
 * @module dsh-ops/bench/calls
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { REPO_ROOT } from '../lib/env.mjs'
import { loadManifests, resolveRoot, adaptCase, identityOf, compareIdentities } from './corpora.mjs'
import { describe as describeTree, treeHash, checkShape } from './shape.mjs'
import { resolveArms, loadArms } from './arms.mjs'
export { defaultWorker } from './arms.mjs'

/** The report's format tag; a reader that does not know it must refuse, not guess. */
export const CALLS_FORMAT = 'dsh-ops-calls-v1'
/** Projections this command can drive, in report order. */
export const PROJECTIONS = ['official', 'baseline', 'candidate']
/** Default paired rounds per case. */
export const DEFAULT_REPEAT = 3
/** Upper bound on rounds: this is a human-evidence tool, not a load generator. */
export const MAX_REPEAT = 10
/**
 * Warm-up passes discarded before the measured rounds. One is the default because the first
 * touch of a real tree pays page-cache and Defender cost that has nothing to do with the tool:
 * the rust toolchain's first scan took 30 s cold and 1.1 s warm on the same worker.
 */
export const DEFAULT_WARMUP = 1
/** Upper bound on warm-up passes. */
export const MAX_WARMUP = 5

const WORKER_NAME = process.platform === 'win32' ? 'dsh-ops-worker.exe' : 'dsh-ops-worker'

/**
 * The `calls` help text.
 * @returns {string} the usage block.
 */
export function usage() {
  return [
    'usage: node bench/cli.mjs calls --corpus <id> [--corpus <id>]... [options]',
    '',
    'Model-free tool-call timing: official tools versus ops_*, or two OPS builds in one process.',
    'The report records the corpus shape and hash before and after the run; a duration is',
    'never a verdict (exit 1 means the run is unusable, not that one side is slower).',
    '',
    '  --corpus <id>        a manifest in bench/corpora (repeatable; default: all that resolve)',
    '  --root <path>        override the corpus root (only with one --corpus)',
    '  --projection <list>  official,baseline,candidate; default official,candidate, or',
    '                       baseline,candidate when --baseline-plugin-root is supplied',
    '  --repeat <n>         measured paired rounds per case, 1..' + MAX_REPEAT + ' (default ' + DEFAULT_REPEAT + ')',
    '  --warmup <n>         discarded passes first, 0..' + MAX_WARMUP + ' (default ' + DEFAULT_WARMUP + ')',
    '  --baseline <file>    refuse a corpus whose identity differs from this earlier report',
    '  --out <file>         report path; must not exist (required unless --dry-run)',
    '  --dry-run            resolve corpora and print the plan; boots no host, writes nothing',
    '  --worker <path>      the ops worker binary (default: native/target/release/' + WORKER_NAME + ')',
    '  --plugin-root <dir>  the checkout whose lib/ is measured (default: this checkout)',
    '  --baseline-plugin-root <dir>  compare this OPS build with --plugin-root in the same run',
    '  --baseline-worker <path>     override the worker inside --baseline-plugin-root',
  ].join('\n')
}

/**
 * Parse `calls` argv. Every value is validated here so a malformed run cannot reach a
 * host that would silently measure something else.
 *
 * @param {string[]} argv - arguments after the subcommand name.
 * @returns {{help: boolean, dryRun: boolean, corpora: string[], root: string|null, projections: string[], repeat: number, out: string|null, worker: string}} the options.
 */
export function parseArgs(argv) {
  const options = { help: false, dryRun: false, corpora: [], root: null, projections: ['official', 'candidate'], repeat: DEFAULT_REPEAT, warmup: DEFAULT_WARMUP, out: null, baseline: null, worker: null, pluginRoot: null, baselinePluginRoot: null, baselineWorker: null }
  let explicitProjections = false
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '-h' || flag === '--help') { options.help = true; continue }
    if (flag === '--dry-run') { options.dryRun = true; continue }
    const value = argv[index + 1]
    if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`this flag needs a value: ${flag}`)
    if (flag === '--corpus') options.corpora.push(value)
    else if (flag === '--root') options.root = value
    else if (flag === '--out') options.out = value
    else if (flag === '--worker') options.worker = value
    else if (flag === '--plugin-root') options.pluginRoot = value
    else if (flag === '--baseline-plugin-root') options.baselinePluginRoot = value
    else if (flag === '--baseline-worker') options.baselineWorker = value
    else if (flag === '--baseline') options.baseline = value
    else if (flag === '--warmup') {
      const warmup = Number(value)
      if (!Number.isInteger(warmup) || warmup < 0 || warmup > MAX_WARMUP) throw new Error(`--warmup must be an integer in 0..${MAX_WARMUP}`)
      options.warmup = warmup
    } else if (flag === '--repeat') {
      const repeat = Number(value)
      if (!Number.isInteger(repeat) || repeat < 1 || repeat > MAX_REPEAT) throw new Error(`--repeat must be an integer in 1..${MAX_REPEAT}`)
      options.repeat = repeat
    } else if (flag === '--projection') {
      explicitProjections = true
      const requested = value.split(',').map(item => item.trim()).filter(Boolean)
      if (requested.length === 0) throw new Error('--projection needs at least one projection')
      for (const item of requested) if (!PROJECTIONS.includes(item)) throw new Error(`unknown projection "${item}" (known: ${PROJECTIONS.join(', ')})`)
      options.projections = [...new Set(requested)]
    } else throw new Error(`unknown flag "${flag}"`)
    index += 1
  }
  if (options.help) return options
  if (options.baselinePluginRoot !== null && !explicitProjections) options.projections = ['baseline', 'candidate']
  if ((options.projections.includes('baseline') || options.baselineWorker !== null) && options.baselinePluginRoot === null) throw new Error('--baseline-plugin-root is required for a baseline arm or worker')
  if (options.baselinePluginRoot !== null && !options.projections.includes('baseline')) throw new Error('--baseline-plugin-root requires the baseline projection')
  if (options.root !== null && options.corpora.length !== 1) throw new Error('--root is only meaningful with exactly one --corpus')
  if (!options.dryRun && options.out === null) throw new Error('--out is required (evidence is never overwritten)')
  return options
}

/**
 * The median of the given numbers, or `null` when there is none. Even counts average the
 * two middle values, matching `bench/tools`.
 * @param {number[]} values - durations in milliseconds.
 * @returns {number|null} the median.
 */
export function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  if (sorted.length === 0) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

/**
 * Run the comparison.
 * @param {string[]} argv - arguments after `calls`.
 * @param {{out?: Function, err?: Function}} [io] - output sinks.
 * @returns {Promise<number>} 0 ok, 1 unusable run, 2 usage/preflight.
 */
export async function main(argv, io = {}) {
  const out = io.out ?? (line => console.log(line))
  const err = io.err ?? (line => console.error(line))
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    err(`bench calls: ${String(error?.message ?? error)}`)
    err('run "node bench/cli.mjs calls --help" for usage')
    return 2
  }
  if (options.help) { out(usage()); return 0 }
  if (!options.dryRun && fs.existsSync(path.resolve(options.out))) {
    err(`bench calls: refusing to overwrite evidence: ${path.resolve(options.out)}`)
    return 2
  }

  // `io.manifests` is the suite's seam: a dry run over a throwaway corpus must never
  // depend on what happens to exist under bench/corpora on this machine.
  let manifests = io.manifests
  if (!Array.isArray(manifests)) {
    try {
      manifests = loadManifests()
    } catch (error) {
      err(`bench calls: ${String(error?.message ?? error)}`)
      return 2
    }
  }
  const unknown = options.corpora.filter(id => !manifests.some(manifest => manifest.id === id))
  if (unknown.length > 0) {
    err(`bench calls: unknown corpus: ${unknown.join(', ')} (known: ${manifests.map(manifest => manifest.id).join(', ')})`)
    return 2
  }
  const selected = options.corpora.length === 0 ? manifests : manifests.filter(manifest => options.corpora.includes(manifest.id))
  if (selected.length === 0) {
    err(`bench calls: no corpus matched ${JSON.stringify(options.corpora)} (known: ${manifests.map(manifest => manifest.id).join(', ')})`)
    return 2
  }

  const plan = []
  for (const manifest of selected) {
    let root, pin = null
    try {
      // A corpus is a directory the operator prepared by the recipe in the docs; the identity
      // check, not a directory name, is what proves which version was measured.
      root = resolveRoot(manifest, { repoRoot: REPO_ROOT, override: options.root ?? undefined })
    } catch (error) {
      // An explicit --corpus is a promise that this corpus must run; the default "all" set
      // may legitimately lack a tree on this machine, but the skip is named, never silent.
      if (options.corpora.length === 0) {
        out(`[calls] skip ${manifest.id}: ${String(error?.message ?? error).split('\n')[0]}`)
        continue
      }
      err(`bench calls: ${String(error?.message ?? error)}`)
      return 2
    }
    const shape = describeTree(root)
    const verdict = checkShape(shape, manifest.shape)
    if (!verdict.ok) {
      err(`bench calls: ${manifest.id} is outside its declared shape: ${verdict.problems.join('; ')}`)
      err('Refusing to file a number under a workload nobody measured. Delete the tree and rebuild it, or fix the manifest.')
      return 1
    }
    // Liveness (the mtime tree hash) answers "did it move during this run"; identity answers
    // "is it the same software version as the run I am comparing against". They are different
    // questions, and only the second one may be carried across runs.
    let identity
    try {
      identity = identityOf(manifest, root, { repoRoot: REPO_ROOT })
    } catch (error) {
      err(`bench calls: ${String(error?.message ?? error)}`)
      return 2
    }
    plan.push({ manifest, root, shape, identity, pin })
  }

  if (plan.length === 0) {
    err('bench calls: no corpus could be resolved on this machine; name one with --corpus or build its tree')
    return 2
  }
  // A baseline report is a *version* claim, not a speed claim: the same corpus bytes must have
  // produced the earlier numbers, otherwise the pair measures two different programs.
  if (options.baseline !== null) {
    let baseline
    try {
      baseline = JSON.parse(fs.readFileSync(path.resolve(options.baseline), 'utf8'))
    } catch (error) {
      err(`bench calls: cannot read --baseline: ${String(error?.message ?? error)}`)
      return 2
    }
    if (baseline.format !== CALLS_FORMAT) {
      err(`bench calls: --baseline is not a ${CALLS_FORMAT} report: ${path.resolve(options.baseline)}`)
      return 2
    }
    const known = new Map((baseline.corpora ?? []).filter(corpus => corpus.identity).map(corpus => [corpus.id, corpus.identity]))
    const drift = []
    for (const item of plan) {
      const before = known.get(item.manifest.id)
      if (!before) { drift.push(`${item.manifest.id}: the baseline has no identity for it`); continue }
      const differences = compareIdentities(item.identity, before)
      if (differences.length > 0) drift.push(`${item.manifest.id}: ${differences.join('; ')}`)
    }
    if (drift.length > 0) {
      err('bench calls: the corpus is not the same software version as the baseline; that pair would measure two different programs:')
      for (const line of drift) err(`  ${line}`)
      err('Rebuild the corpus at the baseline version, or start a new baseline report.')
      return 1
    }
  }

  const armPlan = resolveArms(options)
  if (options.dryRun) {
    for (const item of plan) {
      out(`[calls] ${item.manifest.id} (${item.manifest.class ?? 'real'}) -> ${item.root}`)
      out(`        files=${item.shape.files} MiB=${item.shape.mebibytes} depth=${item.shape.maxDepth} binary=${(item.shape.binaryBytesRatio * 100).toFixed(1)}%`)
      out(`        identity=${item.identity.combined.slice(0, 12)} sample=${item.identity.sample.files} file(s)${options.baseline === null ? '' : ' (matches baseline)'}`)
      for (const testCase of item.manifest.cases) out(`        case ${testCase.id}: ${testCase.tool} ${JSON.stringify(testCase.args)}`)
    }
    for (const arm of armPlan) out(`[calls] ${arm.id}: ${arm.pluginRoot ?? 'official tools from the runner checkout'}${arm.worker ? ` · worker: ${arm.worker}` : ''}`)
    out(`[calls] projections: ${options.projections.join(', ')} · repeat: ${options.repeat} · dry run, no host booted`)
    return 0
  }

  let arms
  try {
    arms = await loadArms(armPlan)
  } catch (error) {
    err(`bench calls: ${String(error?.message ?? error)}`)
    return 2
  }
  const { boot } = await import('../gates/host.mjs')
  const byId = new Map(arms.map(arm => [arm.id, arm]))
  const report = {
    format: CALLS_FORMAT, version: 1, createdAt: new Date().toISOString(),
    machine: { platform: process.platform, arch: process.arch, node: process.version, cpus: os.cpus().length, memGiB: Math.round(os.totalmem() / 1073741824) },
    pluginRoot: byId.get('candidate')?.pluginRoot ?? null,
    worker: byId.get('candidate')?.evidence.worker ?? null,
    arms: Object.fromEntries(arms.map(arm => [arm.id, arm.evidence])),
    timeoutPolicy: true, projections: options.projections, repeat: options.repeat, warmup: options.warmup,
    baseline: options.baseline === null ? null : { path: path.resolve(options.baseline) }, corpora: [],
  }

  for (const item of plan) {
    out(`\n[calls] ${item.manifest.id}: ${item.root}`)
    const hashBefore = treeHash(item.root)
    const hosts = {}
    try {
      for (const arm of arms) {
        const projection = arm.id
        try {
          hosts[projection] = await boot({
            root: item.root, worker: arm.worker, projection: arm.projection, officialSearch: true,
            alwaysLoaded: arm.projection === 'candidate' ? ['grep', 'glob'] : [],
            toolTimeout: true, pluginRoot: arm.pluginRoot,
          })
        } catch (error) {
          // Confined DSH modes forbid pipe-based child spawn, and both projections need one.
          // That is the sandbox boundary, not a measurements bug: name the fix, do not retry.
          if (/EPERM/i.test(String(error?.message ?? error))) {
            err('bench calls: the host cannot spawn a child process here (EPERM). Both projections do their work in a child, so run bench calls outside the confined sandbox mode.')
            return 2
          }
          throw error
        }
        hosts[projection].owner = await hosts[projection].agent()
      }
      const rows = []
      // Negative rounds are the discarded warm-up: the first touch of a real tree pays page-cache
      // and scanner cost that belongs to the machine, not to the tool.
      for (let round = -options.warmup; round < options.repeat; round += 1) {
        const warm = round < 0
        const order = Math.abs(round) % 2 === 0 ? options.projections : [...options.projections].reverse()
        for (const testCase of item.manifest.cases) {
          for (const projection of order) {
            const arm = byId.get(projection)
            const call = adaptCase(testCase, arm.projection, arm.publicToolName)
            const started = process.hrtime.bigint()
            let durationMs, spawnMs = null, children = [], isError, detail, textBytes = null, coverage = null
            try {
              const run = await hosts[projection].run(hosts[projection].owner, [[call], []])
              const result = run.results[0]
              if (run.results.length !== 1 || result?.name !== call.name || !result.result) throw new Error(`expected one result for ${call.name}`)
              durationMs = result?.durationMs ?? Number(process.hrtime.bigint() - started) / 1e6
              spawnMs = result?.spawnMs ?? null
              children = result?.children ?? []
              // OPS failures are canonical values; host transport may still say isError=false.
              isError = result.result.isError === true || [result.result.meta?.opsOutcome?.status, result.result.value?.status]
                .some(status => ['error', 'rejected', 'conflict', 'unknown'].includes(status))
              const text = textOf(result?.result)
              textBytes = Buffer.byteLength(text)
              coverage = coverageOf(text)
              if (isError) detail = text.slice(0, 200)
            } catch (error) {
              durationMs = Number(process.hrtime.bigint() - started) / 1e6
              isError = true
              detail = String(error?.message ?? error).slice(0, 200)
            }
            const overheadMs = spawnMs === null ? null : durationMs - spawnMs
            // "Incomplete" has two different causes and they must not read alike: a budget stop
            // (`truncatedBy`) means the tool did less work; content gaps mean it walked everything
            // and could not read some files.
            const scan = coverage === null
              ? ''
              : coverage.scanComplete === true
                ? `  scan=${coverage.scannedFiles} complete`
                : coverage.truncatedBy !== null && coverage.truncatedBy !== 'none'
                  ? `  scan=${coverage.scannedFiles} stopped=${coverage.truncatedBy}`
                  : `  scan=${coverage.scannedFiles} gaps=${coverage.skippedFiles}`
            if (!warm) rows.push({ round, case: testCase.id, projection, durationMs, spawnMs, overheadMs, children, textBytes, coverage, isError, detail })
            out(`  ${warm ? '[warmup] ' : ''}${testCase.id.padEnd(18)} ${projection.padEnd(10)} ${durationMs.toFixed(1).padStart(9)} ms  (child ${spawnMs === null ? '-' : spawnMs.toFixed(1).padStart(8)} ms)${scan}${isError ? '  ERROR' : ''}`)
          }
        }
      }
      // A cold tree can keep getting faster for several passes (page cache, scanner cache).
      // Say so instead of filing the median of a still-falling series as steady state.
      for (const testCase of item.manifest.cases) {
        for (const projection of options.projections) {
          const runs = rows.filter(row => row.case === testCase.id && row.projection === projection && !row.isError).map(row => row.durationMs)
          if (runs.length >= 2 && runs.at(-1) < runs[0] * 0.7) {
            err(`bench calls: ${testCase.id}/${projection} is still falling (${runs[0].toFixed(0)} ms → ${runs.at(-1).toFixed(0)} ms); steady state not reached, raise --warmup`)
          }
        }
      }
      const cases = item.manifest.cases.map(testCase => {
        const summary = { id: testCase.id, tool: testCase.tool, args: testCase.args }
        for (const projection of options.projections) {
          const entries = rows.filter(row => row.case === testCase.id && row.projection === projection)
          const ok = entries.filter(row => !row.isError)
          summary[projection] = {
            // Archive the dispatched arguments: bounded and exact queries are different work.
            arguments: adaptCase(testCase, byId.get(projection).projection, byId.get(projection).publicToolName).args,
            // dispatch-to-result includes the child; childMs is the child alone; overheadMs is
            // everything else (queueing, JSON, rendering) and is what a spawn-free tool would pay.
            medianMs: median(ok.map(row => row.durationMs)),
            childMs: median(ok.filter(row => row.spawnMs !== null).map(row => row.spawnMs)),
            overheadMs: median(ok.filter(row => row.overheadMs !== null).map(row => row.overheadMs)),
            commands: [...new Set(ok.flatMap(row => row.children.map(child => child.command)))],
            bytesMedian: median(ok.map(row => row.textBytes)),
            // The last observed coverage wins; it is diagnostic, never a verdict.
            coverage: [...ok].reverse().find(row => row.coverage !== null)?.coverage ?? null,
            // Three readings, because one number cannot answer two different questions:
            // `firstMs` is the first measured call AFTER discarded warmups; `steadyMs` is the
            // stable tail estimate, not proof of cold-cache or algorithmic performance.
            firstMs: ok.length === 0 ? null : round1(ok[0].durationMs),
            steadyMs: converge(ok.map(row => row.durationMs)).steadyMs,
            convergedAt: converge(ok.map(row => row.durationMs)).convergedAt,
            runs: entries.map(row => round1(row.durationMs)),
            errors: entries.filter(row => row.isError).length,
            detail: entries.find(row => row.detail)?.detail ?? null,
          }
        }
        return summary
      })
      const hashAfter = treeHash(item.root)
      report.corpora.push({
        id: item.manifest.id, class: item.manifest.class ?? null, root: item.root,
        manifest: item.manifest.file, manifestSha256: sha256File(item.manifest.file),
        identity: item.identity, pin: item.pin ?? { pinned: false },
        shape: describeTree(item.root), treeHashBefore: hashBefore, treeHashAfter: hashAfter,
        inputChanged: hashAfter !== hashBefore, cases, rows,
      })
      if (hashAfter !== hashBefore) err(`bench calls: ${item.manifest.id} changed during the run (tree hash differs); the row is unusable`)
    } finally {
      for (const projection of Object.keys(hosts)) await hosts[projection].close()
    }
  }

  const output = path.resolve(options.out)
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  out(`\n[calls] report: ${output}`)
  const broken = report.corpora.some(corpus => corpus.inputChanged || corpus.cases.some(testCase =>
    options.projections.some(projection => testCase[projection].errors > 0)))
  if (broken) err('[calls] at least one call failed or the input changed; this run is evidence of a defect, not of a speed')
  out('[calls] timings are evidence only; this command never judges a duration')
  return broken ? 1 : 0
}

/** The text blocks of one tool result, joined; used only for an error excerpt. */
function textOf(result) {
  return (result?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join(' ')
}

/**
 * The converged tail of one measured series. A run counts as steady when every later run is
 * within 10% of the last one; `convergedAt` is the 1-based index of the first such run.
 * @param {number[]} values - durations in measured order.
 * @returns {{steadyMs: number|null, convergedAt: number|null}} the tail.
 */
export function converge(values) {
  if (values.length === 0) return { steadyMs: null, convergedAt: null }
  const last = values.at(-1)
  let start = values.length - 1
  while (start > 0 && Math.abs(values[start - 1] - last) / last <= 0.1) start -= 1
  return { steadyMs: median(values.slice(start)), convergedAt: start + 1 }
}

/**
 * Read the coverage facts an OPS search reports about itself. Official tools return the matches
 * only, so they have no equivalent line; that asymmetry is itself part of the evidence.
 * @param {string} text - the tool result text.
 * @returns {object|null} Scan and result counts, or null when the text carries none.
 */
export function coverageOf(text) {
  const scanned = /scannedFiles=(\d+)/.exec(text)
  if (scanned === null) return null
  const complete = /scanComplete=(true|false)/.exec(text)
  const skipped = /skippedFiles=(\d+)/.exec(text)
  const truncated = /TruncatedBy:\s*([\w-]+)/i.exec(text)
  const observed = /matchedObserved=(\d+)/.exec(text)
  const total = /matchedTotal=(\d+)/.exec(text)
  const displayed = /(\d+) items? displayed/.exec(text)
  return {
    scannedFiles: Number(scanned[1]),
    scanComplete: complete === null ? null : complete[1] === 'true',
    skippedFiles: skipped === null ? null : Number(skipped[1]),
    truncatedBy: truncated === null ? null : truncated[1],
    matchedObserved: observed === null ? null : Number(observed[1]),
    matchedTotal: total === null ? null : Number(total[1]),
    displayedItems: displayed === null ? null : Number(displayed[1]),
  }
}

/** Round to one decimal; the report's precision for a duration. */
function round1(value) {
  return Math.round(value * 10) / 10
}

/** The sha256 of a file, or a named placeholder when it is unreadable. */
function sha256File(file) {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return 'unreadable'
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2))
}
