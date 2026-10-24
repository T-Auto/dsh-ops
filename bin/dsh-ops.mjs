#!/usr/bin/env node
/**
 * `dsh-ops` — operator commands for the dsh-ops plugin.
 *
 * The plugin resolves its native worker and shells automatically, so these
 * commands are not required for a normal install. They exist for what automatic
 * resolution cannot do: install into a DSH profile, build the native worker from
 * source, turn the pinned upstream shell releases into local copies, clean up
 * files older versions left outside the profile, report what this deployment
 * resolves and which rungs the prompt ladder renders, and serve captured panel
 * reports to a browser over loopback.
 *
 * @module dsh-ops/cli
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { PACKAGE_ROOT } from '../lib/paths.js'
import { profileCommand } from '../lib/profile-install.js'
import { cargoBuild, findCargo } from '../lib/rust.js'
import { commandLadder } from '../lib/cli/report.js'
import { commandProvisionShells } from '../lib/cli/provision-shells.js'
import { commandUpgradeHostPwsh } from '../lib/cli/pwsh-upgrade.js'
import { commandBashRuntime } from '../lib/cli/bash-runtime.js'
import { commandUninstall } from '../lib/cli/uninstall.js'
import { commandSettingsProfile } from '../lib/cli/settings-profile.js'
import { commandPanel } from '../lib/cli/panel.js'

/**
 * Print one usage block.
 * @returns {void}
 */
function usage() {
  console.log(`dsh-ops — operator commands for the dsh-ops plugin

Usage:
  dsh-ops install --profile <desktop|web|tui> [--dsh-cli <path>]
                                  Install this version using the official target-profile manager
  dsh-ops uninstall --profile <desktop|web|tui> [--dsh-cli <path>]
                                  Remove the profile plugin and its binary dependency references
  dsh-ops status --profile <desktop|web|tui>
                                  Report target-profile installation (tui maps to dsh-tui)
  dsh-ops settings-profile --profile-dir <dir> --host-anchor <host package.json> [--dsh-home <dir>] [--offline --yes]
                                  Preview or explicitly enable the optional browser settings carrier
  dsh-ops build-ptc              Build the independent native Rust worker (all platforms)
  dsh-ops review snapshot --repo <owner/name> --prs <1,2> [--base main] [--checkout <path>]
                                  Collect bounded PR/CI evidence; optionally probe local commit objects
  dsh-ops uninstall [--yes] [--purge-fastctx]
                                  Report files older versions left under <DSH_HOME>/dsh-ops and,
                                  with --yes, remove them; --purge-fastctx also removes leftover
                                  ~/.fastctx state from the removed background component
  dsh-ops ladder [--json] [--config <file>]
                                  Report the native worker, both shells, and the rungs the
                                  prompt ladder actually renders; nothing is spawned
  dsh-ops panel [--serve] [dir] [--port <n>]
                                  Serve the panel viewer and capture reports over loopback
                                  (default: ./.dsh-ops/panel, latest session preselected)
  dsh-ops provision-shells [--bash] [--pwsh] [--force] [--dry-run] [--pin <file>]
                                  Download the pinned upstream bash and/or PowerShell 7, verify
                                  their digests, and install them under <DSH_HOME>/dsh-ops/shells
  dsh-ops bash-runtime [status|install|remove|git|managed] [--yes] [--dry-run]
                                  Manage optional Bash; git/managed prints a bashPath selection
                                  for the host config editor. remove previews unless --yes.
  dsh-ops upgrade-host-pwsh [--yes] [--dry-run]
                                  Preview/run standard Windows PowerShell 7 installation through
                                  WinGet. Restart DSH; custom host pwshPath remains authoritative.
  dsh-ops help                    This text

Environment:
  DSH_OPS_WORKER_BIN   Explicit native worker executable
  DSH_OPS_CARGO        Explicit cargo executable
  CARGO_HOME           Rust toolchain home (.cargo)
  DSH_OPS_RUST_HOME    Directory containing a relocated .cargo toolchain
  DSH_HOME             DSH home; the provisioned shells live in <DSH_HOME>/dsh-ops/shells
  HTTPS_PROXY          Proxy handed to curl explicitly by provision-shells

With --profile, install/uninstall delegate to the official DSH profile manager.
Without --profile, uninstall only cleans legacy provisioned runtime/shell files;
use --yes to confirm that separate cleanup. No system shell or shared npm cache is removed.
`)
}

/**
 * Commands removed together with the FastCtx background backend, and what replaces each.
 * They fail with that answer instead of the generic unknown-command text, so an old script
 * or habit gets told where to go.
 */
const REMOVED_COMMANDS = Object.freeze({
  resolve: 'use `dsh-ops ladder` to see what this deployment resolves',
  status: 'use `dsh-ops ladder` for this deployment, or `dsh-ops status --profile <desktop|web|tui>` for a profile install',
  build: 'use `dsh-ops build-ptc` to build the native worker',
  provision: 'the native worker ships in the package (or `dsh-ops build-ptc` from a checkout); use `dsh-ops provision-shells` for the shells',
})

/**
 * Parse arguments and run one command.
 * @returns {Promise<number>} the exit code.
 */
async function main() {
  if (process.argv[2] === 'review') return (await import('../lib/review/cli.js')).commandReview(process.argv.slice(3))
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      profile: { type: 'string' },
      'profile-dir': { type: 'string' },
      'host-anchor': { type: 'string' },
      'dsh-home': { type: 'string' },
      offline: { type: 'boolean', default: false },
      'dsh-cli': { type: 'string' },
      force: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      'purge-fastctx': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      config: { type: 'string' },
      bash: { type: 'boolean', default: false },
      pwsh: { type: 'boolean', default: false },
      pin: { type: 'string' },
      serve: { type: 'boolean', default: false },
      port: { type: 'string' },
    },
  })
  const command = positionals[0] ?? 'help'
  if (positionals.length > (command === 'bash-runtime' || command === 'panel' ? 2 : 1)) throw new Error('Unexpected positional arguments.')
  // Declared globally so `panel --serve` parses, but it is meaningful for that command only.
  if (values.serve === true && command !== 'panel') throw new Error('--serve only applies to the panel command.')
  if (command === 'install' || (['uninstall', 'status'].includes(command) && values.profile !== undefined)) {
    return profileCommand(command, { profile: values.profile, dshCli: values['dsh-cli'], dryRun: values['dry-run'] === true })
  }
  if (Object.hasOwn(REMOVED_COMMANDS, command)) {
    console.error(`dsh-ops: \`${command}\` was removed together with the FastCtx background component; ${REMOVED_COMMANDS[command]}.`)
    return 2
  }
  switch (command) {
    case 'settings-profile':
      return commandSettingsProfile({ profileDir: values['profile-dir'], hostAnchor: values['host-anchor'], home: values['dsh-home'], yes: values.yes, offline: values.offline, dryRun: values['dry-run'] })
    case 'upgrade-host-pwsh':
      return commandUpgradeHostPwsh({ yes: values.yes, dryRun: values['dry-run'] })
    case 'bash-runtime':
      return commandBashRuntime(positionals[1], { yes: values.yes, dryRun: values['dry-run'], force: values.force, configFile: values.config })
    case 'ladder':
      return commandLadder({ json: values.json === true, configFile: values.config })
    case 'panel': {
      const port = values.port === undefined ? 0 : Number(values.port)
      if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be an integer from 0 to 65535, got ${JSON.stringify(values.port)}`)
      return commandPanel({ dir: positionals[1], port })
    }
    case 'build-ptc': {
      const cargo = findCargo()
      console.log(`toolchain: ${cargo.version}`)
      const result = await cargoBuild({ cargo, sourceDir: path.join(PACKAGE_ROOT, 'native'), onLine: line => console.log(line) })
      if (result.code !== 0) return result.code
      const staged = spawnSync(process.execPath, [path.join(PACKAGE_ROOT, 'bin/native-runtime.mjs'), 'stage', '--platform', `${process.platform}-${process.arch}`], { stdio: 'inherit', windowsHide: true })
      if (staged.error) throw staged.error
      return staged.status ?? 1
    }
    case 'provision-shells': {
      /** No shell flag means both, so a bare invocation is "make this deployment whole". */
      const kinds = []
      if (values.bash === true || values.pwsh === true) {
        if (values.bash === true) kinds.push('bash')
        if (values.pwsh === true) kinds.push('pwsh')
      } else {
        kinds.push('bash', 'pwsh')
      }
      return commandProvisionShells({
        kinds,
        force: values.force === true,
        dryRun: values['dry-run'] === true,
        pinFile: values.pin,
      })
    }
    case 'uninstall':
      return commandUninstall({
        yes: values.yes === true,
        purgeFastctx: values['purge-fastctx'] === true,
        dryRun: values['dry-run'] === true,
      })
    case 'help':
      usage()
      return 0
    default:
      console.error(`dsh-ops: unknown command ${JSON.stringify(command)}\n`)
      usage()
      return 2
  }
}

try { process.exitCode = await main() }
catch (error) { console.error(`dsh-ops: ${error.message}`); process.exitCode = 1 }
