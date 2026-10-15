#!/usr/bin/env node
/**
 * Install the Windows shell payloads this profile does not already have.
 *
 * `@dsh-ops/bash-win32-x64` and `@dsh-ops/pwsh-win32-x64` are no longer
 * `optionalDependencies` of the published package: a package manager resolves
 * those before any of this plugin's code runs, so one that skips a platform
 * package does it in silence — the install ends at exit code 0 and nothing is
 * printed about the missing shell. npm runs this script inside the installed
 * package instead, where the answer can be based on the machine: a shell that
 * already exists on it is used by the resolver and its payload is not
 * downloaded a second time.
 *
 * Nothing here is allowed to fail the consuming install. Every miss ends in a
 * printed line naming the command that repairs it, and exit code 0: a broken
 * shell payload may not make `npm install` or the host's own upgrade fail.
 *
 * The registry request is made from a scratch project beside this package
 * (`SCRATCH_DIR`) and the result moved into `node_modules/@dsh-ops/`, because
 * npm resolves the whole project it is invoked in and this package's manifest
 * describes a development tree, not a payload set.
 *
 * Set `DSH_OPS_INSTALL_PAYLOADS=1` to install both payloads whatever this
 * machine already has — the pinned copies are what the confined executor runs,
 * so a deployment that runs read-only or workspace-write sessions needs them
 * even when a system Git for Windows is present.
 *
 * @module dsh-ops/postinstall
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PLATFORM_PACKAGES, platformPackageName } from './lib/shells.js'

/** The package directory this script ships in, and the one it installs into. */
const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url))

/**
 * Where npm runs: an empty project beside the package, not the package.
 *
 * npm resolves the *project* it is invoked in, and this package's published
 * manifest still carries `devDependencies` (eleven of them) beside its peer
 * contract, so running npm in `PACKAGE_ROOT` would build that tree inside the
 * installed plugin — and rewrite the `node_modules` the host put there. A
 * scratch project with one dependency has nothing else to resolve, and the
 * result is moved into place afterwards.
 * @type {string}
 */
const SCRATCH_DIR = path.join(PACKAGE_ROOT, '.payload-install')

/**
 * The well-known install locations of one system shell, in probe order.
 *
 * A deliberate copy of `lib/shells.js`'s `wellKnownCandidates`: this script runs
 * during an install, and the one thing it must not do is load the plugin's
 * dependency graph before the package manager has finished writing it. The two
 * lists answer the same question — "is a system shell already here?" — so a
 * candidate added there belongs here too.
 * @param {'bash'|'pwsh'} kind - which shell.
 * @param {NodeJS.ProcessEnv} env - the environment to read.
 * @returns {string[]} the candidate paths.
 */
function systemShellCandidates(kind, env) {
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES ?? 'C:\\Program Files'
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = env.LOCALAPPDATA ?? env.LocalAppData ?? ''
  const userProfile = env.USERPROFILE ?? ''
  return (kind === 'bash'
    ? [
      path.join(programFiles, 'Git', 'bin', 'bash.exe'),
      path.join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'),
      path.join(programFilesX86, 'Git', 'bin', 'bash.exe'),
      localAppData === '' ? '' : path.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'),
      userProfile === '' ? '' : path.join(userProfile, 'scoop', 'shims', 'bash.exe'),
      'C:\\tools\\msys64\\usr\\bin\\bash.exe',
      'C:\\msys64\\usr\\bin\\bash.exe',
    ]
    : [
      path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
      path.join(programFiles, 'PowerShell', '7-preview', 'pwsh.exe'),
      localAppData === '' ? '' : path.join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe'),
      userProfile === '' ? '' : path.join(userProfile, 'scoop', 'shims', 'pwsh.exe'),
    ]).filter((file) => file !== '')
}

/**
 * Whether one path is a file.
 * @param {string|undefined} file - the candidate path.
 * @returns {boolean} true when it is a file.
 */
function isFile(file) {
  if (file === undefined || file === '') return false
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * Whether the payload of one shell is installed under this package.
 * @param {'bash'|'pwsh'} kind - which shell.
 * @returns {boolean} true when the platform package's executable is there.
 */
function payloadInstalled(kind) {
  return isFile(path.join(
    PACKAGE_ROOT, 'node_modules', ...platformPackageName(kind).split('/'),
    'bin', PLATFORM_PACKAGES[kind].executable,
  ))
}

/**
 * The version a payload is requested at, when the manifest names one.
 *
 * The published manifest does not declare the two shell packages — that is the
 * point of this script — so an ordinary install asks for the package by name
 * alone. A manifest that does declare them (a checkout, or a release that has
 * not published yet) decides the version here. ponytail: an unpinned install
 * follows the registry's latest payload; the confined executor still judges the
 * payload it finds against its own receipt, so a version that does not belong to
 * this plugin's pin table is refused with a remedy rather than used.
 * @returns {Record<string, string>} package name to version range.
 */
function declaredVersions() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    return { ...manifest.optionalDependencies, ...manifest.dependencies }
  } catch {
    return {}
  }
}

/**
 * One npm invocation in the scratch project.
 *
 * `shell` is on for Windows only because Node refuses to spawn a `.cmd` without
 * it: `npm` is a batch shim there, and the alternative — locating npm's own
 * JavaScript entry point — is a second way to spell a command the machine
 * already has. `--ignore-scripts` is belt and braces: a payload package has no
 * install script, and this script's own install must not run a third party's.
 * @param {string[]} args - the npm arguments.
 * @returns {{ok: boolean, detail: string}} the verdict.
 */
function npm(args) {
  const windows = process.platform === 'win32'
  const result = spawnSync(windows ? 'npm.cmd' : 'npm', args, {
    cwd: SCRATCH_DIR,
    stdio: 'inherit',
    windowsHide: true,
    shell: windows,
  })
  if (result.error !== undefined) return { ok: false, detail: result.error.message }
  return result.status === 0
    ? { ok: true, detail: 'installed' }
    : { ok: false, detail: `npm exited with code ${String(result.status)}` }
}

/**
 * Move one freshly installed platform package under this package's own tree.
 *
 * `node_modules/@dsh-ops/<payload>` is the layout `lib/shells.js` probes, and it
 * is what `remove` needs: a rename inside one volume, with a copy only when the
 * host put the scratch directory on another one. ponytail: a later profile-wide
 * install may prune a directory the host's package manager does not know about;
 * run `dsh-ops provision-shells` to restore a pinned copy, or point the resolver
 * at the managed store it writes.
 * @param {string} name - the scoped package name.
 * @returns {boolean} true when the payload is in place.
 */
function moveIntoPackage(name) {
  const relative = name.split('/')
  const from = path.join(SCRATCH_DIR, 'node_modules', ...relative)
  const to = path.join(PACKAGE_ROOT, 'node_modules', ...relative)
  if (!fs.existsSync(from)) return false
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.rmSync(to, { recursive: true, force: true })
  try {
    fs.renameSync(from, to)
  } catch {
    fs.cpSync(from, to, { recursive: true })
    fs.rmSync(from, { recursive: true, force: true })
  }
  return true
}

const force = process.env.DSH_OPS_INSTALL_PAYLOADS === '1'
const versions = declaredVersions()
const missing = []
for (const kind of ['bash', 'pwsh']) {
  if (!force && (payloadInstalled(kind) || systemShellCandidates(kind, process.env).some(isFile))) continue
  missing.push(kind)
}

if (missing.length === 0) {
  console.log('dsh-ops: the shells this machine already provides are used; no payload downloaded')
} else {
  const names = missing.map((kind) => platformPackageName(kind))
  console.log(`dsh-ops: installing the pinned Windows shell payload(s) ${names.join(', ')}`)
  const ranges = names.map((name) => `${name}@${versions[name] ?? 'latest'}`)
  try {
    fs.mkdirSync(SCRATCH_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(SCRATCH_DIR, 'package.json'),
      `${JSON.stringify({ name: 'dsh-ops-payload-install', version: '0.0.0', private: true }, null, 2)}\n`,
    )
    const { ok, detail } = npm([
      'install', '--no-save', '--no-package-lock', '--ignore-scripts',
      '--no-audit', '--no-fund', '--loglevel=error', ...ranges,
    ])
    const landed = ok ? names.filter((name) => moveIntoPackage(name)) : []
    if (landed.length !== names.length) {
      const why = ok ? 'npm placed the payload outside this package' : detail
      console.log(`dsh-ops: the payload install did not complete (${why}); the plugin still works with the shells `
        + 'already on this machine, and the pinned copies can be fetched without a registry by running '
        + '`npx --yes dsh-ops@latest provision-shells --bash --pwsh`')
    }
  } catch (error) {
    console.log(`dsh-ops: the payload install did not complete (${error.message}); the plugin still works with the `
      + 'shells already on this machine, and the pinned copies can be fetched without a registry by running '
      + '`npx --yes dsh-ops@latest provision-shells --bash --pwsh`')
  } finally {
    fs.rmSync(SCRATCH_DIR, { recursive: true, force: true })
  }
}
