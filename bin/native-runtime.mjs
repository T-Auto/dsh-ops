#!/usr/bin/env node
/** Build distribution stages, never download on installation or execute foreign binaries.
 * Release input layout: <input>/<platform>-<arch>/dsh-ops-worker[.exe].
 * One npm package carries all supported workers; native target selection happens locally.
 *
 * `check` answers two different questions, so it takes two different scopes:
 *
 * - `check` (no scope flag) demands every declared platform. A release package
 *   must carry all of them, and `scripts/build-platform-packages.mjs` relies on
 *   this to refuse an incomplete publish directory.
 * - `check --staged` validates the targets actually present under `runtime/`.
 *   That is the honest question for a one-host source build, where only the
 *   host target can be produced.
 *
 * `--platform <target>` narrows either command to exactly one target and wins
 * over `--staged`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { PLATFORMS, PACKAGE_ROOT, workerName } from '../lib/ptc/runtime.js'
const { values, positionals } = parseArgs({ options: { input: {type:'string'}, root: {type:'string'}, platform: {type:'string'}, staged: {type:'boolean'} }, allowPositionals:true })
const command = positionals[0] ?? 'check'
if (command !== 'stage' && command !== 'check') throw Error('Expected stage or check')
if (values.staged && command !== 'check') throw Error('--staged only applies to check; stage always names its targets')
const root = path.resolve(values.root ?? PACKAGE_ROOT)
/** Read a JSON file, or name it: a raw ENOENT names a path but not the mistake. */
const readJson = (file, what) => {
  let text
  try { text = fs.readFileSync(file,'utf8') } catch (error) { throw Error(`${what} at ${file} could not be read: ${error.message}`) }
  try { return JSON.parse(text) } catch (error) { throw Error(`${what} at ${file} is not valid JSON: ${error.message}`) }
}
const version = readJson(path.join(root,'package.json'),'package manifest').version
/** The targets physically present in this package, declared order first. */
const stagedTargets = () => {
  const directory = path.join(root,'runtime')
  if (!fs.existsSync(directory)) return []
  const present = []
  for (const entry of fs.readdirSync(directory,{withFileTypes:true})) {
    if (!entry.isDirectory()) continue
    const receipt = path.join(directory,entry.name,'provenance.json')
    const worker = path.join(directory,entry.name,workerName(entry.name.split('-')[0]))
    // A directory holding a worker but no receipt is a half-finished stage, not an
    // absent target. Skipping it silently would let `--staged` pass on a package
    // whose runtime cannot resolve.
    if (fs.existsSync(worker) && !fs.existsSync(receipt)) throw Error(`Half-staged runtime: ${worker} exists but ${receipt} is missing. Re-run npm run build:ptc -- stage for ${entry.name}, or remove the directory.`)
    if (fs.existsSync(receipt)) present.push(entry.name)
  }
  return [...PLATFORMS.filter(target => present.includes(target)), ...present.filter(target => !PLATFORMS.includes(target))]
}
const targets = values.platform
  ? [values.platform]
  : values.staged ? stagedTargets() : [...PLATFORMS]
if (values.staged && targets.length === 0) throw Error('No staged native runtime under runtime/; run npm run build:ptc on the target platform first')
if (targets.some(t=>!PLATFORMS.includes(t))) throw Error('Unsupported target')
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
for (const target of targets) {
  const name = workerName(target.split('-')[0])
  const directory = path.join(root,'runtime',target), destination = path.join(directory,name)
  if (command === 'stage') {
    const input = path.resolve(values.input ?? path.join(PACKAGE_ROOT,'native','target','release'))
    const source = values.platform ? path.join(input,name) : path.join(input,target,name)
    if (!fs.existsSync(source)) throw Error(`Missing target build: ${source}. Build it on that target with npm run build:ptc, or pass --input <dir> laid out as <input>/<platform>-<arch>/${name}.`)
    if (!fs.statSync(source).isFile()) throw Error(`Target build is not a regular file: ${source}`)
    fs.mkdirSync(directory,{recursive:true})
    fs.copyFileSync(source,destination)
    if (!target.startsWith('win32-')) fs.chmodSync(destination,0o755)
    fs.writeFileSync(path.join(directory,'provenance.json'),JSON.stringify({version,target,executable:name,sha256:hash(destination),source:'native/Cargo.lock + native/src; original MIT Rust core'},null,2)+'\n')
  } else if (command !== 'check') throw Error('Expected stage or check')
  const receiptPath = path.join(directory,'provenance.json')
  // `check` without a scope demands every declared target, so on a one-host source
  // build it reaches targets that were never staged. Naming the missing receipt and
  // both ways forward beats a raw ENOENT from inside readFileSync.
  if (!fs.existsSync(receiptPath)) throw Error(`Runtime for ${target} is not staged: ${receiptPath} is missing. Run npm run build:ptc -- stage on ${target}, or use check --staged to validate only the targets this package carries.`)
  const receipt = readJson(receiptPath,`runtime provenance for ${target}`)
  if (!fs.existsSync(destination)) throw Error(`Runtime for ${target} is incomplete: ${receiptPath} exists but ${destination} is missing.`)
  // A mismatch is a verdict, not a stack trace: name the target, the digest the receipt
  // promises and the digest actually on disk, then exit 1.
  if (receipt.version !== version || receipt.target !== target || receipt.executable !== name || receipt.sha256 !== hash(destination)) {
    console.error(`Runtime provenance mismatch: ${target} (receipt sha256 ${receipt.sha256}, actual ${hash(destination)})`)
    process.exit(1)
  }
  const bytes = fs.readFileSync(destination)
  // Reject accidental copies of a host binary labeled as a foreign target.
  if (target.startsWith('win32-')) {
    if (bytes.toString('ascii',0,2) !== 'MZ') throw Error(`Not a PE binary: ${target}`)
    const pe = bytes.readUInt32LE(0x3c)
    if (bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe+4) !== (target.endsWith('x64') ? 0x8664 : 0xaa64)) throw Error(`Wrong PE architecture: ${target}`)
  }
  if (target.startsWith('linux-')) {
    if (!bytes.subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46])) || bytes[4] !== 2 || bytes[5] !== 1
      || bytes.readUInt16LE(18) !== (target.endsWith('x64') ? 62 : 183)) throw Error(`Wrong ELF architecture: ${target}`)
  }
  if (target.startsWith('darwin-')) {
    if (bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== (target.endsWith('x64') ? 0x1000007 : 0x100000c)) throw Error(`Wrong Mach-O architecture: ${target}`)
  }
  if (process.platform !== 'win32' && !target.startsWith('win32-')) fs.chmodSync(destination,0o755)
  console.log(`${target}: ${bytes.length} bytes, sha256 ${receipt.sha256}`)
}
console.log(`Validated ${targets.length} native runtime(s); no install-time scripts or permission changes.`)
