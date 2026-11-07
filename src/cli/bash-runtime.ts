/** Optional Bash acquisition and lifecycle CLI; never edits a profile or ambient PATH. */
import { commandProvisionShells } from './provision-shells.js'
import { readRowConfig } from './report.js'
import { resolveConfig } from '../config.js'
import { resolveShells } from '../shells.js'
import { bashEngine, gitBashCandidates, managedBashInventory, removeManagedBash, selectBashRuntime } from '../shells/manager.js'
import { bashIpcReport, reclaimBashGenerations, recoverBashLifecycleLock } from '../bash-ipc.js'
import { getSpillLedger } from '../shells/spill-ledger.js'
import { inspectSpills, spillRetentionConfig, sweepSpills, type SpillReport } from '../shells/spill-retention.js'

interface BashRuntimeCommandOptions {
  force?: boolean
  dryRun?: boolean
  yes?: boolean
  json?: boolean
  sweep?: boolean
  configFile?: string
  allHostsStopped?: boolean
  /** Explicit Git Bash/MSYS executable for `git`; scanning is used when omitted. */
  path?: string
}

/** One-decimal MiB, for reports a human reads. */
function mib(bytes: number): string {
  return (bytes / 1048576).toFixed(2)
}

/**
 * Print one spill report for a human.
 * @param report - the pass result.
 * @param applied - whether the pass was allowed to delete files.
 * @returns nothing.
 */
function printSpillReport(report: SpillReport, applied: boolean): void {
  console.log('Host subprocess spill ledger')
  console.log('  ledger:       ' + report.ledger.file + ' (' + String(report.ledger.entries) + ' entries)')
  if (report.ledger.degraded !== null) console.log('  degraded:     ' + report.ledger.degraded + ' (memory only)')
  console.log('  retention:    ' + (report.retention.retentionDays === 0 ? 'report only' : String(report.retention.retentionDays) + ' days')
    + ', ' + (report.retention.totalBudgetMiB === 0 ? 'no byte budget' : String(report.retention.totalBudgetMiB) + ' MiB budget')
    + ', automatic sweep ' + (report.retention.sweepEnabled ? 'on' : 'off'))
  if (report.fatal !== undefined) {
    console.log('  cannot sweep: ' + report.fatal)
    return
  }
  console.log('  existing:     ' + String(report.existingFiles) + ' file(s), ' + mib(report.existingBytes) + ' MiB')
  console.log('  expired:      ' + String(report.expiredFiles) + ' file(s), ' + mib(report.expiredBytes) + ' MiB')
  if (report.missing > 0) console.log('  missing:      ' + String(report.missing) + ' entry(ies) whose file is already gone')
  if (report.unknown.length > 0) {
    console.log('  skipped:      ' + String(report.unknown.length) + ' ledger entry(ies) outside the host spill shape (other providers are report-only)')
    for (const skip of report.unknown.slice(0, 10)) console.log('    ' + skip.reason + ': ' + skip.path)
  }
  for (const failure of report.failures.slice(0, 10)) console.log('  last failure: ' + failure.path + ': ' + failure.error)
  if (report.failures.length > 10) console.log('  ... ' + String(report.failures.length - 10) + ' more retained failure(s); the next pass retries them')
  if (!applied) {
    console.log(report.planned > 0
      ? '  plan:         ' + String(report.planned) + ' file(s), ' + mib(report.plannedBytes) + ' MiB would be deleted'
      : '  plan:         nothing to delete')
    return
  }
  console.log('  deleted:      ' + String(report.deleted.length) + ' file(s), ' + mib(report.deletedBytes) + ' MiB')
  for (const file of report.deleted.slice(0, 20)) console.log('    ' + file)
  console.log('  remaining:    ' + String(report.remainingFiles) + ' file(s), ' + mib(report.remainingBytes) + ' MiB')
}

/**
 * Report (and optionally sweep) the host subprocess spill files this plugin
 * recorded at settlement. Only ledger entries are candidates; nothing is found
 * by scanning a directory.
 * @param options - CLI options.
 * @returns the process exit code.
 */
function commandSpillReport(options: BashRuntimeCommandOptions): number {
  const config = spillRetentionConfig(resolveConfig(readRowConfig(options.configFile)))
  const ledger = getSpillLedger()
  const sweepRequested = options.sweep === true
  const apply = sweepRequested && options.yes === true && options.dryRun !== true
  const report = apply ? sweepSpills({ config, ledger }) : inspectSpills({ config, ledger })
  if (options.json === true) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    printSpillReport(report, apply)
  }
  if (sweepRequested && !apply && options.json !== true) {
    console.log('Preview only: pass --sweep --yes to delete these files. No file was changed.')
  }
  return 0
}

export function commandBashRuntime(action = 'status', options: BashRuntimeCommandOptions = {}): number {
  let result
  if (action === 'install') return commandProvisionShells({ kinds: ['bash'], force: options.force ?? false, dryRun: options.dryRun ?? false, pinFile: undefined })
  if (action === 'remove') result = removeManagedBash(options)
  // `managed` is the pre-Niubash spelling: the default rung is the packaged payload now.
  else if (action === 'niubash' || action === 'managed') result = selectBashRuntime('niubash')
  else if (action === 'git') result = selectBashRuntime('git', options.path === undefined ? {} : { path: options.path })
  else if (action === 'spill-report') return commandSpillReport(options)
  else if (action === 'clean-cache') {
    const shells = resolveShells(resolveConfig(readRowConfig(options.configFile)))
    // Offline cleanup is the only place quarantined copies are reclaimable, so the preview
    // reports them with the same assertion the apply path requires.
    const inventory = bashIpcReport(shells.bash.available ? shells.bash.file : undefined, { confirmedStopped: true })
    const apply = options.yes === true && options.dryRun !== true
    if (apply && options.allHostsStopped !== true) throw new Error('Stop every OPS host and Bash job, then confirm with --yes --all-hosts-stopped. No cache was changed.')
    if (apply) recoverBashLifecycleLock(inventory.root, { confirmedStopped: true })
    result = { action: apply ? 'removed' : 'preview', root: inventory.root, current: inventory.current,
      // A confirmed stop covers every host and confined shell, so interrupted `stage-*` trees are
      // not merely aged out here — they are removed (stagingTtlMs: 0) along with old generations (#512).
      ...reclaimBashGenerations(inventory.root, inventory.current ?? '', { confirmedStopped: true, dryRun: !apply, stagingTtlMs: 0 }) }
  }
  else if (action === 'status') {
    const config = resolveConfig(readRowConfig(options.configFile))
    const shells = resolveShells(config)
    // One line of spill retention facts beside the shell that produces the files,
    // so growth is visible without reading the full ledger report (#720).
    const spill = inspectSpills({ config: spillRetentionConfig(config) })
    result = { selected: shells.bash, engine: bashEngine(shells.bash.file),
      managed: managedBashInventory(), git: gitBashCandidates(),
      // The private Windows runtime is the one piece of state that used to grow silently on every
      // upgrade; report it beside the shell it belongs to (#466).
      bashIpc: bashIpcReport(shells.bash.available ? shells.bash.file : undefined),
      spill: { ledgerEntries: spill.ledger.entries, existingBytes: spill.existingBytes, expiredBytes: spill.expiredBytes,
        skipped: spill.unknown.length, lastError: spill.failures[0]?.error ?? null } }
  }
  else throw new Error('Expected bash-runtime status, install, remove, niubash, git, clean-cache or spill-report.')
  console.log(JSON.stringify(result, null, 2))
  if (action === 'niubash' || action === 'managed') console.log('Remove bashPath from every preset section of the single dsh-ops row (and any custom preset options) that should use the default Niubash payload. No profile was changed.')
  if (action === 'git') console.log('Set bashPath to the reported absolute executable on the preset section(s) that should use it. No profile was changed.')
  if (action === 'remove' && 'action' in result && result.action === 'preview') console.log('Pass --yes to remove only these managed Bash versions. Stop running Bash jobs before removal.')
  return 0
}
