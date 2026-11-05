#!/usr/bin/env node
/**
 * Assemble the main release artifact and verify its provenance and checksum manifest.
 * The main package declares the Windows bash payload as an exact optionalDependency;
 * this pipeline materializes that pinned package next to the plugin.
 *
 * Usage:
 *   node scripts/build-platform-packages.mjs [all|publish-dir|check] [--dist <directory>]
 *
 * @module dsh-ops/build/platform-packages
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assembleNiubash } from './lib/build/niubash.mjs'
import { describePackages, stepAssemble } from './lib/build/assemble.js'
import { stepCheck } from './lib/build/check.js'
import { downloadPins, resolveProxy } from './lib/build/download.js'
import { printArtifactTable, stepPack } from './lib/build/pack.js'
import { stepPublishDir } from './lib/build/publish-dir.js'
import { REPO_ROOT, log } from './lib/build/util.js'


// ---------------------------------------------------------------------------
// Step: fetch and verify-upstream
// ---------------------------------------------------------------------------

/**
 * Prove every pin still matches the upstream release it names.
 * @param {object} context - the run context.
 * @returns {Promise<void>} nothing.
 */
async function stepVerifyUpstream(context) {
  log('verify-upstream', 'downloading every pinned asset, verifying its digest, and deleting it again')
  const verdicts = await downloadPins(context, { keep: false })
  console.log(`\nupstream pins verified (${verdicts.length}):`)
  for (const verdict of verdicts) {
    console.log(`  ${verdict.package.padEnd(30)} ${verdict.pin.releaseTag.padEnd(18)} ${verdict.pin.assetName}`)
    console.log(`  ${''.padEnd(30)} sha256 ${verdict.pin.assetSha256}  ${verdict.pin.assetBytes} bytes  OK`)
  }
  console.log()
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

/**
 * Parse the command line.
 * @param {string[]} argv - `process.argv.slice(2)`.
 * @returns {object} the parsed options.
 */
function parseArgs(argv) {
  const commands = new Set(['all', 'assemble', 'pack', 'publish-dir', 'check', 'fetch', 'verify-upstream'])
  const options = {
    command: 'all',
    platform: 'win32',
    arch: 'x64',
    dist: path.resolve(REPO_ROOT, '..', 'dist'),
    proxy: undefined,
    noProxy: false,
    force: false,
    backend: 'niubash',
    offline: false,
    niubashArchive: undefined,
  }
  const flags = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) {
      if (commands.has(argument)) options.command = argument
      else throw new Error(`unknown command: ${argument}`)
      continue
    }
    const [name, inline] = argument.includes('=')
      ? [argument.slice(0, argument.indexOf('=')), argument.slice(argument.indexOf('=') + 1)]
      : [argument, undefined]
    /**
     * The value of a flag that needs one.
     * @returns {string} the value.
     */
    const value = () => {
      if (inline !== undefined) return inline
      index += 1
      if (index >= argv.length) throw new Error(`${name} needs a value`)
      return argv[index]
    }
    switch (name) {
      case '--backend': options.backend = value(); break
      case '--niubash-archive': options.niubashArchive = path.resolve(value()); break
      case '--offline': options.offline = true; break
      case '--platform': options.platform = value(); break
      case '--arch': options.arch = value(); break
      case '--dist': options.dist = path.resolve(value()); break
      case '--proxy': options.proxy = value(); break
      case '--no-proxy': options.noProxy = true; break
      case '--force': options.force = true; break
      case '--check': options.command = 'check'; break
      case '--verify-upstream': options.command = 'verify-upstream'; break
      case '--help': flags.add('help'); break
      default: throw new Error(`unknown flag: ${name}`)
    }
  }
  return { ...options, help: flags.has('help') }
}

/** Print the usage block, taken from this file's own header. */
function printUsage() {
  const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const start = source.indexOf(' * Usage:')
  const end = source.indexOf(' * @module')
  console.log(source.slice(start + 3, end).replace(/^ \* ?/gmu, '').trimEnd())
}

/**
 * Run the requested command.
 * @returns {Promise<void>} nothing.
 */
async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    printUsage()
    return
  }
  const proxy = resolveProxy(options.proxy, options.noProxy)
  const context = {
    ...options,
    proxy,
    packages: describePackages(options.platform, options.arch, options.dist, options.backend),
  }
  console.log(`dsh-ops platform packages: ${options.command} -> ${options.dist}`)
  console.log(`target ${options.platform}-${options.arch}`
    + (proxy === undefined ? ' (no proxy)' : ` (proxy http://${proxy.host}:${proxy.port})`))
  console.log(`platform packages: ${context.packages.map((pkg) => `${pkg.name}@${pkg.version}`).join(', ')}`)

  const runStep = async (name, body) => {
    log(name, 'start')
    return body()
  }

  if (options.command === 'check') {
    const problems = await stepCheck(context)
    printArtifactTable(options.dist)
    process.exitCode = problems === 0 ? 0 : 1
    return
  }
  if (options.backend === 'niubash') {
    await assembleNiubash(context)
    if (['fetch', 'verify-upstream', 'assemble'].includes(options.command)) return
  }
  if (options.command === 'verify-upstream') {
    await runStep('verify-upstream', () => stepVerifyUpstream(context))
    return
  }
  if (options.command === 'fetch') {
    await runStep('fetch', () => downloadPins(context, { keep: true }))
    log('fetch', 'pinned assets are in place; `check` and `assemble` need none of them')
    return
  }

  let assembled = []
  if (['all', 'assemble', 'pack', 'publish-dir'].includes(options.command)) {
    await runStep('fetch', () => downloadPins(context, { keep: true }))
    assembled = await runStep('assemble', () => stepAssemble(context))
  }
  if (['all', 'pack', 'publish-dir'].includes(options.command)) {
    await runStep('pack', () => stepPack(context, assembled))
  }
  if (['all', 'publish-dir'].includes(options.command)) {
    await runStep('publish-dir', () => stepPublishDir(context, assembled))
  }
  if (options.command === 'all') {
    const problems = await stepCheck(context)
    if (problems > 0) throw new Error(`${problems} artifact(s) failed the post-build check`)
  }
  printArtifactTable(options.dist)
  log('done', `artifacts in ${options.dist}`)
}

await main().catch((error) => {
  console.error(`\nbuild-platform-packages: ${String(error?.message ?? error)}`)
  process.exitCode = 1
})
