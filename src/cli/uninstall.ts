/**
 * `dsh-ops uninstall`: report and remove what this plugin (and older versions
 * of it) installed outside the profile, without touching the profile install
 * itself.
 *
 * Split out of `bin/dsh-ops.mjs`; the command's argv surface, output and exit
 * codes are unchanged.
 *
 * @module dsh-ops/cli/uninstall
 */

import fs from 'node:fs'
import { errorMessage } from '../shells/types.js'
import path from 'node:path'
import { fastctxDataDir, managedDir } from './report.js'
import { unsealDirectorySync } from '../niubash/seal.js'

/**
 * Render a byte count for a human report.
 * @param {number} bytes - the size.
 * @returns {string} the size in the largest unit that keeps it readable.
 */
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['kB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/**
 * Measure a file or directory without following symbolic links out of the tree:
 * an unreadable entry reports zero rather than failing the report.
 * @param {string} entry - the path to measure.
 * @returns {number} the byte count.
 */
export function measure(entry: string): number {
  let stat
  try {
    stat = fs.lstatSync(entry)
  } catch {
    return 0
  }
  if (!stat.isDirectory()) return stat.size
  let total = 0
  for (const child of fs.readdirSync(entry, { withFileTypes: true })) {
    total += measure(path.join(entry, child.name))
  }
  return total
}

/**
 * Describe the top-level entries of a directory, for reporting what a removal
 * would take with it.
 * @param {string} dir - the directory.
 * @returns {{name: string, bytes: number}[]} one row per entry, directories first.
 */
export function contentsOf(dir: string) {
  const rows = fs.readdirSync(dir, { withFileTypes: true }).map((entry) => ({
    name: entry.isDirectory() ? `${entry.name}${path.sep}` : entry.name,
    bytes: measure(path.join(dir, entry.name)),
  }))
  return rows.sort((left, right) => {
    const leftDir = left.name.endsWith(path.sep)
    const rightDir = right.name.endsWith(path.sep)
    return leftDir === rightDir ? left.name.localeCompare(right.name) : leftDir ? -1 : 1
  })
}

/**
 * Report one directory and its contents under a section heading.
 * @param {string} label - the section heading.
 * @param {string} dir - the directory to describe.
 * @returns {{missing: boolean, rows: {name: string, bytes: number}[], bytes: number}} the report.
 */
export function reportDirectory(label: string, dir: string) {
  console.log(`\n${label}`)
  console.log(`  directory: ${dir}`)
  if (!fs.existsSync(dir)) {
    console.log('  contents:  (does not exist)')
    return { missing: true, rows: [], bytes: 0 }
  }
  const rows = contentsOf(dir)
  const bytes = rows.reduce((total, row) => total + row.bytes, 0)
  console.log(rows.length === 0
    ? '  contents:  (empty)'
    : `  contents:  ${rows.map((row) => `${row.name} (${formatBytes(row.bytes)})`).join(', ')}`)
  console.log(`  total:     ${formatBytes(bytes)}`)
  return { missing: false, rows, bytes }
}

/**
 * `uninstall`: remove what this plugin (and older versions of it) installed
 * outside the profile, and report the state it does not own.
 *
 * Removing the plugin itself is a profile operation — `dsh plugin --profile
 * <profile> remove dsh-ops`, or the `plugin_manager` `remove_bundle` tool — and
 * stays outside this command. What is inside: `<DSH_HOME>/dsh-ops` (provisioned
 * shells, and the FastCtx runtime older versions provisioned), and, only on
 * request, the leftover `~/.fastctx` state of the removed background component.
 *
 * Nothing is deleted without `--yes`, so a bare invocation is the report.
 *
 * @param {object} options - uninstall inputs.
 * @param {boolean} options.yes - perform the removals instead of reporting them.
 * @param {boolean} options.purgeFastctx - also remove FastCtx's own state directory.
 * @param {boolean} options.dryRun - report only, whatever `yes` says.
 * @returns {number} the exit code: 0 when the requested state is gone or absent, 1 when a removal failed.
 */
export function commandUninstall({ yes, purgeFastctx, dryRun }: { yes: boolean; purgeFastctx: boolean; dryRun: boolean }) {
  const removing = yes && !dryRun
  console.log(`dsh-ops uninstall — ${removing ? 'removing' : 'report only (dry run; pass --yes to delete)'}`)

  const managed = managedDir()
  const managedReport = reportDirectory(`managed files (<DSH_HOME>/dsh-ops)`, managed)
  if (managedReport.missing) {
    console.log('  action:    nothing to remove')
  } else if (!removing) {
    console.log(`  action:    would remove this directory and its ${formatBytes(managedReport.bytes)}`)
  } else {
    try {
      unsealDirectorySync(managed)
      fs.rmSync(managed, { recursive: true, force: true })
      console.log('  action:    removed')
    } catch (error) {
      console.error(`  action:    FAILED to remove ${managed}: ${errorMessage(error)}`)
      return 1
    }
  }

  const fastctx = fastctxDataDir()
  const fastctxReport = reportDirectory("FastCtx user data (not owned by this plugin; left over from the removed background component)", fastctx)
  if (fastctxReport.missing) {
    console.log('  action:    nothing to remove')
  } else if (!purgeFastctx) {
    console.log('  action:    kept (pass --yes --purge-fastctx to remove it as well)')
  } else if (!removing) {
    console.log(`  action:    would remove this directory and its ${formatBytes(fastctxReport.bytes)}`)
  } else {
    try {
      fs.rmSync(fastctx, { recursive: true, force: true })
      console.log('  action:    removed')
    } catch (error) {
      console.error(`  action:    FAILED to remove ${fastctx}: ${errorMessage(error)}`)
      return 1
    }
  }

  console.log('\nplugin installation (not handled by this command)')
  console.log('  action:    remove the plugin itself with `dsh plugin --profile <profile> remove dsh-ops`,')
  console.log('             or the plugin_manager `remove_bundle` tool; this command only removes the')
  console.log('             runtime and state the plugin wrote outside the profile.')

  return 0
}
