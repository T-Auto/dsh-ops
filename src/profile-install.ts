/** Profile operations delegate to the official CLI instead of reimplementing its locks and rollback. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { PACKAGE_ROOT, dshHome } from './paths.js'
import { PLATFORMS } from './ptc/runtime.js'

/**
 * Architectures this fork will run its profile commands on.
 *
 * Upstream refused anything but `win32-x64`. The commands below only drive the
 * official DSH CLI and a package manager, both of which are platform neutral;
 * the native payloads are a separate question with their own gate in
 * `lib/ptc/runtime.js`.
 */
const SUPPORTED_TARGETS: Readonly<Partial<Record<NodeJS.Platform, readonly string[]>>> = Object.freeze({ win32: ['x64'], linux: ['x64'], darwin: ['arm64', 'x64'] })

/**
 * Where each platform's desktop application keeps its own CLI.
 *
 * The desktop profile is Electron-owned: an ordinary `dsh` refuses to manage it,
 * so the carrier's bundled launcher is the only supported entry point.
 */
function desktopCliCandidates(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? path.join(home, 'AppData/Local')
    return [path.join(local, 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd')]
  }
  if (platform === 'darwin') {
    return [
      '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
      path.join(home, 'Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'),
    ]
  }
  return []
}

export type ProfileOperation = 'install' | 'uninstall' | 'status'
export interface ProfileCommandOptions { profile?: string; dshCli?: string; dryRun?: boolean }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function readManifest(file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!record(value)) throw new Error(`Invalid package manifest: ${file}`)
  return value
}

/** Static checks only: probing a candidate by running it would make dry-run execute user code. */
function cliFileAvailable(file: string, script = false): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false
    fs.accessSync(file, script ? fs.constants.R_OK : process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK)
    return true
  } catch { return false }
}

function preflightCli(command: string, entry?: string): string {
  const windows = process.platform === 'win32'
  const explicitPath = windows ? /[\\/]|^[a-z]:/i.test(command) : command.includes('/')
  const extensions = windows && !path.extname(command)
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : ['']
  const searchPath = (process.env.PATH ?? (windows ? '' : '/usr/bin:/bin')).split(path.delimiter)
    .filter(directory => !windows || directory !== '')
  // cmd searches the current directory unless the operator disabled that lookup.
  if (windows && process.env.NoDefaultCurrentDirectoryInExePath === undefined) searchPath.unshift(process.cwd())
  const candidates = explicitPath
    ? [...extensions.filter(Boolean).map(extension => path.resolve(command + extension)), path.resolve(command)]
    : searchPath.flatMap(directory => {
      // Quoted PATH entries are a Windows convention; quotes are literal POSIX filename bytes.
      const base = windows ? directory.replace(/^"(.*)"$/, '$1') : directory
      return extensions.map(extension => path.resolve(base, command + extension))
    })
  const resolved = candidates.find(file => cliFileAvailable(file))
  if (!resolved) throw new Error(`Official CLI not found or not executable: ${command}. Pass --dsh-cli <path> to an available DSH CLI.`)
  if (windows && /\.(cmd|bat)$/i.test(resolved) && /["\r\n&|<>^%!]/.test(resolved)) {
    throw new Error('Unsafe CLI path; use a path without cmd metacharacters.')
  }
  // A CLI found through @deepseek-ai/dsh runs under Node, so its bin needs read access, not +x.
  if (entry !== undefined && !cliFileAvailable(entry, true)) throw new Error(`Official CLI entry point is missing or unreadable: ${entry}. Repair the DSH installation or pass --dsh-cli <path>.`)
  return resolved
}

export function profileCommand(operation: ProfileOperation, { profile, dshCli, dryRun = false }: ProfileCommandOptions): number {
  if (!(SUPPORTED_TARGETS[process.platform] ?? []).includes(process.arch)) throw new Error(`Supported targets: ${PLATFORMS.join(', ')}; unsupported host ${process.platform}-${process.arch}.`)
  const aliases = { desktop: 'desktop', web: 'web', tui: 'dsh-tui', 'dsh-tui': 'dsh-tui' }
  if (profile !== 'desktop' && profile !== 'web' && profile !== 'tui' && profile !== 'dsh-tui') throw new Error('Explicit --profile desktop|web|tui is required (tui maps to dsh-tui).')
  const target = aliases[profile]
  const directory = path.join(dshHome(), 'profiles', target)
  if (!fs.existsSync(path.join(directory, 'package.json'))) throw new Error(`Initialize the target DSH application/profile first: ${directory}`)
  const version = readManifest(path.join(PACKAGE_ROOT, 'package.json')).version
  if (operation === 'status') {
    const manifest = readManifest(path.join(directory, 'package.json'))
    const dependencies = record(manifest.dependencies) ? manifest.dependencies : undefined
    const dsh = record(manifest.dsh) ? manifest.dsh : undefined
    const profileManifest = record(dsh?.profile) ? dsh.profile : undefined
    const bundles = profileManifest?.bundles ?? []
    if (!Array.isArray(bundles) && typeof bundles !== 'string') throw new Error('Invalid profile bundles: expected an array.')
    console.log(JSON.stringify({ profile: target, directory, dependency: dependencies?.['dsh-ops'] ?? null, enabled: bundles.includes('dsh-ops') }, null, 2))
    return 0
  }
  const args = ['plugin', '--profile', target, operation === 'install' ? 'add' : 'remove',
    operation === 'install' ? (process.env.DSH_OPS_INSTALL_SPEC ?? `dsh-ops@${version}`) : 'dsh-ops']
  let command = dshCli ?? process.env.DSH_OPS_DSH_CLI
  let prefix: string[] = []
  if (!command && target === 'desktop') {
    command = desktopCliCandidates().find(file => fs.existsSync(file))
    if (!command) throw new Error('Desktop requires its own CLI. Pass --dsh-cli <installation>/resources/runtime/cli/bin/dsh; ordinary dsh cannot manage desktop.')
  }
  if (!command) {
    const globalNpm = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm/node_modules/_anchor.json') : undefined
    for (const anchor of [path.join(directory, 'package.json'), path.join(dshHome(), 'package.json'), globalNpm].filter((anchor): anchor is string => typeof anchor === 'string')) {
      try {
        const require = createRequire(anchor)
        const file = require.resolve('@deepseek-ai/dsh/package.json')
        const manifest = readManifest(file)
        const bin = typeof manifest.bin === 'string' ? manifest.bin : record(manifest.bin) ? manifest.bin.dsh : undefined
        if (typeof bin === 'string' && bin) { command = process.execPath; prefix = [path.resolve(path.dirname(file), bin)]; break }
      } catch {}
    }
    if (!command) {
      if (process.platform === 'win32') {
        const desktopCli = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData/Local'), 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd')
        command = fs.existsSync(desktopCli) ? desktopCli : 'dsh.cmd'
      } else {
        // POSIX has no `dsh.cmd` and no `cmd.exe` to launch it with: selecting the Windows wrapper
        // made the fallback fail as `spawnSync cmd.exe ENOENT` even with an executable `dsh` on PATH.
        // The official CLI there is the `dsh` entry point itself. Reported by @Haoming9527 in review
        // of #81.
        command = 'dsh'
      }
    }
  }
  command = preflightCli(command, prefix[0])
  console.log(`Target: ${target} (${directory})`)
  console.log(`Official CLI: ${command}; ${[...prefix, ...args].join(' ')}`)
  if (dryRun) return 0
  let result
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${command}" ${args.join(' ')}"`], { stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: true })
  } else result = spawnSync(command, [...prefix, ...args], { stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) return result.status ?? 1
  console.log(operation === 'install'
    ? 'Installed through the official profile manager. Reload/restart the target application if needed. On Windows the pinned Bash payload ships as an optional dependency; run dsh-ops bash-runtime install to repair a missing payload. No postinstall downloads.'
    : 'Removed through the official profile manager, including its runtime dependency references. Package-manager shared caches are not deleted.')
  return 0
}
