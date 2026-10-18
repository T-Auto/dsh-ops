#!/usr/bin/env node
/** Strict release closure. Local source builds use native-runtime check --staged instead. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { PLATFORMS, RELEASE_TARGETS } from '../lib/ptc/runtime.js'
const { values } = parseArgs({ options: { root: { type: 'string' } } })
const root = path.resolve(values.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dsh-plugin.json'), 'utf8'))
const components = manifest.contributes?.['x-components'] ?? []
const declared = components.find(component => component.id === 'dsh-ops-ptc')?.targets ?? []
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
if (!sameSet(declared, PLATFORMS)) throw Error(`Declared scope ${JSON.stringify(declared)} and resolver PLATFORMS ${JSON.stringify(PLATFORMS)} disagree`)
// npm os/cpu filters cannot express paired targets. The component's exact targets
// and runtime resolver are authoritative; Intel Mac, Windows arm64 and OpenHarmony
// stay rejected. Linux arm64 closes here only when its build is produced — CI runs
// `npm pack` on exactly the three release runners (win32-x64, linux-x64, darwin-arm64),
// so the arm64 package is published from an arm64 build rather than claimed.
if (!sameSet(pkg.os ?? [], PLATFORMS.map(target => target.split('-')[0]).filter((value, index, all) => all.indexOf(value) === index)) ||
    !sameSet(pkg.cpu ?? [], [...new Set(PLATFORMS.map(target => target.split('-')[1]))])) throw Error('Package os/cpu and exact target declarations disagree')
for (const id of ['dsh-ops-file', 'dsh-ops-shell']) {
  if (!sameSet(components.find(component => component.id === id)?.targets ?? [], PLATFORMS)) throw Error(`${id} target declarations disagree`)
}
for (const kind of ['bash', 'pwsh']) {
  const name = `@dsh-ops/${kind}-win32-x64`
  if (pkg.optionalDependencies?.[name] !== '0.2.1') throw Error(`${name} must remain the pinned Windows-only optional dependency`)
}
if (pkg.scripts?.postinstall) throw Error('Release must not download shell payloads from postinstall')
const runtimeDir = path.join(root, 'runtime')
const staged = fs.existsSync(runtimeDir) ? fs.readdirSync(runtimeDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort() : []
const unexpected = staged.filter(target => !declared.includes(target))
if (unexpected.length) throw Error(`Unexpected runtime targets in release: ${unexpected.join(', ')}`)
// The closure is what CI ships, not the whole support matrix: a release is packed on
// its three runners, and a declared target with no runner would be a claim no CI job
// ever builds. `RELEASE_TARGETS` names the packed set, so adding a target to the
// support matrix cannot silently loosen the gate.
const missing = RELEASE_TARGETS.filter(target => !staged.includes(target))
if (missing.length) throw Error(`Release is missing ${missing.join(', ')}; every packed target is required`)
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
console.log(`Release closure OK: dsh-ops@${pkg.version}, ${declared.join(' + ')} + Bash IPC proxies and matching source.`)
