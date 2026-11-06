/**
 * `dsh-ops result-cache`: report and reclaim result-cache roots under the temp directory.
 *
 * The collector is the same bounded sweep the plugin runs at start-up and shutdown, so the
 * command cannot disagree with the product about what is reclaimable. `status` never removes
 * anything; `reclaim` is a dry run until `--apply` is passed, mirroring `bash-runtime clean-cache`.
 *
 * @module dsh-ops/cli/result-cache
 */
import { DEFAULT_RESULT_CACHE, resolveConfig, type ResultCacheConfig } from '../config.js'
import { resolveMergedConfig } from '../settings/merged.js'
import { runResultCacheGc, type ResultCacheGcReport } from '../kernel/result-cache-gc.js'
import { listPendingCleanup } from '../kernel/result-cleanup-registry.js'
import { readRowConfig } from './report.js'

/** Options accepted by the result-cache command. */
export interface ResultCacheCommandOptions {
  /** Perform the planned removals; without it `reclaim` is a dry run. */
  apply?: boolean
  /** Print the machine-readable report instead of the human summary. */
  json?: boolean
  /** A JSON file holding the `dsh-ops` row config, as `dsh-ops ladder --config` accepts one. */
  configFile?: string
}

/** Read the retention budget the row would use; a missing config file means the shipped defaults. */
function readBudget(configFile: string | undefined): ResultCacheConfig {
  if (configFile === undefined) return resolveConfig({}).resultCache
  const raw = readRowConfig(configFile)
  // Saved profiles store the merged row shape; a flat row config is still accepted so an
  // operator does not have to rewrite a fixture just to preview the budget.
  try { return resolveMergedConfig(raw).resultCache.config } catch { return resolveConfig(raw).resultCache }
}

function megabytes(bytes: number): string {
  return `${(bytes / 1048576).toFixed(2)} MiB`
}

function age(ageMs: number): string {
  const hours = ageMs / 3_600_000
  return hours >= 24 ? `${(hours / 24).toFixed(1)} d` : hours >= 1 ? `${hours.toFixed(1)} h` : `${Math.round(ageMs / 60_000)} min`
}

function printReport(report: ResultCacheGcReport, action: string, applied: boolean): void {
  const states = report.states
  console.log(`Result cache: ${report.dir}`)
  console.log(`  roots:       ${report.roots} (${megabytes(report.totalBytes)})`)
  console.log(`  states:      empty ${states.empty}, lock-only ${states['lock-only']}, data ${states.data}, unknown ${states.unknown}, live ${states.live}`)
  console.log(`  pending:     ${report.pending} recorded by a previous failed cleanup`)
  console.log(`  reclaimable: ${report.reclaimable} (${megabytes(report.reclaimableBytes)})`)
  if (report.details.length > 0 && report.reclaimable > 0) {
    console.log('Reclaimable roots:')
    for (const entry of report.details.filter(item => item.reclaimable).slice(0, 50)) {
      console.log(`  ${entry.name}  ${entry.state}  ${megabytes(entry.bytes)}  age ${age(entry.ageMs)}${entry.pending ? '  pending' : ''}`)
    }
  }
  const skipped = report.details.filter(item => !item.reclaimable && item.reason !== undefined).slice(0, 10)
  if (skipped.length > 0) {
    console.log('Retained roots (first few):')
    for (const entry of skipped) console.log(`  ${entry.name}  ${entry.state}  ${megabytes(entry.bytes)}  ${entry.reason}`)
  }
  for (const error of report.errors) console.error(`dsh-ops: ${error}`)
  if (applied) {
    console.log(`removed: ${report.removed} (${megabytes(report.removedBytes)}), retained: ${report.retained}, took ${report.durationMs} ms`)
  } else if (action === 'reclaim') {
    console.log('Preview only: no root was removed. Stop every OPS host, then pass --apply to reclaim the listed roots.')
  } else {
    console.log('Status only: no root was removed. Use `dsh-ops result-cache reclaim --apply` to reclaim them.')
  }
}

/**
 * Run one result-cache command.
 * @param action - `status` or `reclaim`.
 * @param options - apply/json/config-file inputs.
 * @returns the process exit code.
 */
export function commandResultCache(action = 'status', options: ResultCacheCommandOptions = {}): number {
  if (action !== 'status' && action !== 'reclaim') throw new Error('Expected result-cache status or reclaim.')
  const budget = readBudget(options.configFile)
  const applied = action === 'reclaim' && options.apply === true
  const report = runResultCacheGc({ budget, apply: applied, scope: 'all' })
  const records = listPendingCleanup()
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify({ action, budget, ...report, pendingRecords: records.map(record => ({ root: record.root, attempts: record.attempts, lastReason: record.lastReason })) }, null, 2)}\n`)
    return 0
  }
  printReport(report, action, applied)
  if (budget.maxRoots === 0 && budget.maxTotalBytes === 0) {
    console.log('Aggregate budgets are 0 (report only): only roots whose cache data is already gone are reclaimed.')
  }
  if (budget.sweepEnabled !== true) console.log('resultCache.sweepEnabled is false: nothing can be removed until it is enabled.')
  return report.errors.length === 0 ? 0 : 1
}

export { DEFAULT_RESULT_CACHE }
