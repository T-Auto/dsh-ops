/** Optional Bash acquisition and lifecycle CLI; never edits a profile or ambient PATH. */
import { commandProvisionShells } from './provision-shells.js'
import { readRowConfig } from './report.js'
import { resolveConfig } from '../config.js'
import { resolveShells } from '../shells.js'
import { bashEngine, gitBashCandidates, managedBashInventory, removeManagedBash, selectBashRuntime } from '../shells/manager.js'
import { bashIpcReport, reclaimBashGenerations, recoverBashLifecycleLock } from '../bash-ipc.js'

interface BashRuntimeCommandOptions {
  force?: boolean
  dryRun?: boolean
  yes?: boolean
  configFile?: string
  allHostsStopped?: boolean
  /** Explicit Git Bash/MSYS executable for `git`; scanning is used when omitted. */
  path?: string
}

export function commandBashRuntime(action = 'status', options: BashRuntimeCommandOptions = {}): number {
  let result
  if (action === 'install') return commandProvisionShells({ kinds: ['bash'], force: options.force ?? false, dryRun: options.dryRun ?? false, pinFile: undefined })
  if (action === 'remove') result = removeManagedBash(options)
  // `managed` is the pre-Niubash spelling: the default rung is the packaged payload now.
  else if (action === 'niubash' || action === 'managed') result = selectBashRuntime('niubash')
  else if (action === 'git') result = selectBashRuntime('git', options.path === undefined ? {} : { path: options.path })
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
    const shells = resolveShells(resolveConfig(readRowConfig(options.configFile)))
    result = { selected: shells.bash, engine: bashEngine(shells.bash.file),
      managed: managedBashInventory(), git: gitBashCandidates(),
      // The private Windows runtime is the one piece of state that used to grow silently on every
      // upgrade; report it beside the shell it belongs to (#466).
      bashIpc: bashIpcReport(shells.bash.available ? shells.bash.file : undefined) }
  }
  else throw new Error('Expected bash-runtime status, install, remove, niubash, git or clean-cache.')
  console.log(JSON.stringify(result, null, 2))
  if (action === 'niubash' || action === 'managed') console.log('Remove bashPath from every preset section of the single dsh-ops row (and any custom preset options) that should use the default Niubash payload. No profile was changed.')
  if (action === 'git') console.log('Set bashPath to the reported absolute executable on the preset section(s) that should use it. No profile was changed.')
  if (action === 'remove' && 'action' in result && result.action === 'preview') console.log('Pass --yes to remove only these managed Bash versions. Stop running Bash jobs before removal.')
  return 0
}
