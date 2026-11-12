/**
 * `dsh-ops disk status`: the read-only ownership and reclaim report.
 *
 * The command only reads. It is the operator's answer to "what did this plugin
 * leave on disk, who owns it, and what may be reclaimed with evidence" without
 * any prefix/mtime sweep: those are explicitly forbidden by issue #714.
 *
 * @module dsh-ops/cli/disk
 */
import { errorMessage } from '../shells/types.js'
import { resolveConfig } from '../config.js'
import { resolveShells } from '../shells.js'
import { diskStatus, renderDiskStatus } from '../disk/status.js'
import { readRowConfig } from './report.js'

/** Inputs of one `disk status` invocation. */
export interface DiskCommandOptions {
  action?: string
  json?: boolean
  configFile?: string
  workspace?: string
}

/**
 * Run `disk status`.
 * @param options - argv values.
 * @returns the exit code: 0 with a report, 2 for an unknown subcommand, 1 when the config or report failed.
 */
export function commandDisk(options: DiskCommandOptions = {}): number {
  const action = options.action ?? 'status'
  if (action !== 'status') {
    console.error('dsh-ops disk: expected the status subcommand; usage: dsh-ops disk status [--json] [--config <file>]')
    return 2
  }
  let config
  try {
    config = resolveConfig(readRowConfig(options.configFile))
  } catch (error) {
    console.error(errorMessage(error))
    return 1
  }
  try {
    const shells = resolveShells(config)
    const report = diskStatus({
      config: config.disk,
      ...(shells.bash.available ? { bashFile: shells.bash.file } : {}),
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    })
    if (options.json === true) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    else console.log(renderDiskStatus(report))
    return 0
  } catch (error) {
    console.error('dsh-ops disk: the status report could not be produced: ' + errorMessage(error))
    return 1
  }
}
