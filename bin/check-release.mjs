#!/usr/bin/env node
/** Strict release closure. Local source builds use native-runtime check --staged instead. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { PLATFORMS } from '../lib/execution/runtime.js'
const { values } = parseArgs({ options: { root: { type: 'string' } } })
const root = path.resolve(values.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dsh-plugin.json'), 'utf8'))
const components = manifest.contributes?.['x-components'] ?? []
if (components.length !== 1 || components[0].id !== 'dsh-ops') throw Error('Release must declare exactly the merged dsh-ops component')
const declared = components[0].targets ?? []
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
if (!sameSet(declared, PLATFORMS)) throw Error(`Declared scope ${JSON.stringify(declared)} and resolver PLATFORMS ${JSON.stringify(PLATFORMS)} disagree`)
// npm os/cpu filters cannot express paired targets. The component's exact targets
// and runtime resolver are authoritative; Windows/Linux arm64 stay rejected.
if (!sameSet(pkg.os ?? [], PLATFORMS.map(target => target.split('-')[0]).filter((value, index, all) => all.indexOf(value) === index)) ||
    !sameSet(pkg.cpu ?? [], [...new Set(PLATFORMS.map(target => target.split('-')[1]))])) throw Error('Package os/cpu and exact target declarations disagree')
// Shell payloads are carried in the main runtime tree; never fetch legacy Git Bash implicitly.
for (const name of ['@dsh-ops/bash-win32-x64', '@dsh-ops/pwsh-win32-x64']) {
  if (pkg.optionalDependencies?.[name] || pkg.dependencies?.[name]) throw Error(`${name} must not be a package dependency`)
}
if (pkg.scripts?.postinstall) throw Error('Release must not download shell payloads from postinstall')
const runtimeDir = path.join(root, 'runtime')
const staged = fs.existsSync(runtimeDir) ? fs.readdirSync(runtimeDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort() : []
const unexpected = staged.filter(target => !declared.includes(target))
if (unexpected.length) throw Error(`Unexpected runtime targets in release: ${unexpected.join(', ')}`)
const missing = declared.filter(target => !staged.includes(target))
if (missing.length) throw Error(`Release is missing ${missing.join(', ')}; every declared target is required`)
const check = spawnSync(process.execPath, [path.join(root, 'bin/native-runtime.mjs'), 'check', '--root', root], { stdio: 'inherit' })
if (check.status !== 0) throw Error('Native runtime gate failed')
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const ipc = path.join(runtimeDir, 'win32-x64/bash-ipc')
const receiptPath = path.join(ipc, 'provenance.json')
if (!fs.existsSync(receiptPath)) throw Error('Windows runtime requires its Bash IPC receipt and binaries')
const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
if (receipt.version !== 1 || receipt.platform !== 'win32-x64') throw Error('Invalid Bash IPC receipt')
for (const name of ['opsipc.dll', 'opsnt.dll']) if (hash(path.join(ipc, name)) !== receipt.files[name]) throw Error(`IPC hash mismatch ${name}`)
for (const name of ['security.h', 'opsipc.cpp', 'opsnt.cpp']) if (hash(path.join(root, 'native/bash-ipc', name)) !== receipt.sources[name]) throw Error(`IPC source mismatch ${name}; rebuild proxies`)
if (!sameSet(fs.readdirSync(ipc), ['opsipc.dll', 'opsnt.dll', 'provenance.json'])) throw Error('Unexpected Bash IPC output files')
const { verifyNiubashTree } = await import('../lib/cli/niubash-payload.js')
verifyNiubashTree(path.join(runtimeDir, 'win32-x64/niubash'))
console.log(`Release closure OK: dsh-ops@${pkg.version}, ${declared.join(' + ')} + complete Niubash v1.5.0, Bash IPC proxies and matching source.`)
