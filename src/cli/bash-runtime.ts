/** Optional Bash acquisition and lifecycle CLI; never edits a profile or ambient PATH. */
import { commandProvisionShells } from './provision-shells.js'
import { readRowConfig } from './report.js'
import { resolveConfig } from '../config.js'
import { resolveShells } from '../shells.js'
import { gitBashCandidates, managedBashInventory, removeManagedBash, selectBashRuntime } from '../shells/manager.js'
import { bashIpcReport, reclaimBashGenerations, recoverBashLifecycleLock } from '../bash-ipc.js'

interface BashRuntimeCommandOptions { force?: boolean; dryRun?: boolean; yes?: boolean; configFile?: string; allHostsStopped?: boolean }

export function commandBashRuntime(action = 'status', options: BashRuntimeCommandOptions = {}): number {
  let result
  if (action === 'install') return commandProvisionShells({ kinds: ['bash'], force: options.force ?? false, dryRun: options.dryRun ?? false, pinFile: undefined })
  if (action === 'remove') result = removeManagedBash(options)
  else if (action === 'git' || action === 'managed') result = selectBashRuntime(action)
  else if (action === 'clean-cache') {
    const shells = resolveShells(resolveConfig(readRowConfig(options.configFile)))
    const inventory = bashIpcReport(shells.bash.available ? shells.bash.file : undefined)
    const apply = options.yes === true && options.dryRun !== true
    if (apply && options.allHostsStopped !== true) throw new Error('Stop every OPS host and Bash job, then confirm with --yes --all-hosts-stopped. No cache was changed.')
    if (apply) recoverBashLifecycleLock(inventory.root, { confirmedStopped: true })
    result = { action: apply ? 'removed' : 'preview', root: inventory.root, current: inventory.current,
      ...reclaimBashGenerations(inventory.root, inventory.current ?? '', { confirmedStopped: true, dryRun: !apply }) }
  }
  else if (action === 'status') {
    const shells = resolveShells(resolveConfig(readRowConfig(options.configFile)))
    result = { selected: shells.bash, managed: managedBashInventory(), git: gitBashCandidates(),
      // The private Windows runtime is the one piece of state that used to grow silently on every
      // upgrade; report it beside the shell it belongs to (#466).
      bashIpc: bashIpcReport(shells.bash.available ? shells.bash.file : undefined) }
  }
  else throw new Error('Expected bash-runtime status, install, remove, git, managed or clean-cache.')
  console.log(JSON.stringify(result, null, 2))
  if (action === 'git' || action === 'managed') console.log('Apply the config object to the matching preset section of the single dsh-ops row with the host config editor, then reload the component. No profile was changed.')
  if (action === 'remove' && 'action' in result && result.action === 'preview') console.log('Pass --yes to remove only these managed Bash versions. Stop running Bash jobs before removal.')
  return 0
}
