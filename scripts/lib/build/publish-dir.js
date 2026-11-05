/**
 * Step: publish directory (the manifest that is actually published).
 *
 * The main package's exact published content plus the injected platform
 * dependencies, packed as the artifact a release uploads.
 *
 * @module dsh-ops/build/lib/publish-dir
 */

import { NIUBASH_PACKAGE_PATH, verifyNiubashTree } from '../../../lib/cli/niubash-payload.js'
import { checkNiubash } from './niubash.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { packDirectory, writeReleaseRecords } from './pack.js'
import { REPO_ROOT, copyEntry, log, mainManifest, npm, parseNpmPackReport, run, size, writeJson } from './util.js'

/**
 * The `optionalDependencies` a publish would inject.
 *
 * Exact Windows runtime optionalDependencies, injected only in the publish
 * artifact so an unpublished version does not break contributor installs.
 *
 * @param {object} context - the run context.
 * @returns {Record<string, string>} the map.
 */
export function injectedOptionalDependencies(context) {
  const declared = mainManifest().optionalDependencies ?? {}
  const injected = { ...declared }
  for (const pkg of context.packages) {
    injected[pkg.name] = pkg.version
  }
  return injected
}

/**
 * Print the injected map, so a human can check it before anything is published.
 * @param {object} context - the run context.
 * @returns {void}
 */
export function printInjection(context) {
  const manifest = mainManifest()
  const injected = injectedOptionalDependencies(context)
  console.log(`\ninjected optionalDependencies for ${manifest.name}@${manifest.version}:`)
  for (const [name, range] of Object.entries(injected)) {
    const own = context.packages.some((pkg) => pkg.name === name)
    console.log(`  ${own ? '+' : ' '} ${name}: ${range}`)
  }
  console.log('  (+ marks a platform package this release injects; the rest came from the committed manifest)')
  console.log('  (+ is the Windows bash payload; the main package declares the same pin)\n')
}

/**
 * Build the publish directory: the main package's exact published content plus
 * the injected platform dependencies, then pack it.
 * @param {object} context - the run context.
 * @param {object[]} assembled - the assembled packages.
 * @returns {Promise<object>} the publish directory facts.
 */
export async function stepPublishDir(context, assembled) {
  // Release packages must contain every advertised native target. A one-host
  // source build is sufficient for local use, never for a cross-platform release.
  run(process.execPath, [path.join(REPO_ROOT, 'bin/native-runtime.mjs'), 'check'])
  const manifest = mainManifest()
  const directory = path.join(context.dist, 'publish', `${manifest.name}-${manifest.version}`)
  if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true })
  fs.mkdirSync(directory, { recursive: true })

  // npm's own answer to "what would this package publish" is the copy list: the
  // whitelist in `files` is then checked against it instead of being
  // re-implemented here (globs, always-included files, and ignore rules all
  // come from npm alone).
  run(process.execPath, [path.join(REPO_ROOT, 'scripts/build.mjs')])
  const dryRun = npm(['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: REPO_ROOT })
  const report = parseNpmPackReport(dryRun.stdout, 'npm pack --dry-run', manifest)
  const listed = report.files.map((entry) => entry.path).sort()
  for (const entry of listed) copyEntry(path.join(REPO_ROOT, entry), path.join(directory, entry))

  const whitelist = manifest.files ?? []
  const uncovered = whitelist.filter((entry) => !listed.some((file) => file === entry || file.startsWith(`${entry}/`)))
  if (uncovered.length > 0) {
    throw new Error(`the files whitelist names ${uncovered.join(', ')}, which npm would not publish`)
  }

  if (context.backend !== 'git-bash') {
    const target = path.join(directory, NIUBASH_PACKAGE_PATH)
    fs.rmSync(target, { recursive: true, force: true })
    fs.cpSync(checkNiubash(context), target, { recursive: true, dereference: false })
    verifyNiubashTree(target)
  }

  const publishable = { ...manifest, optionalDependencies: injectedOptionalDependencies(context) }
  // `private: true` guards the checkout against an accidental publish; this
  // directory is the artifact that is meant to be published, so the flag does
  // not travel with it (npm refuses a tarball whose manifest is private).
  delete publishable.private
  writeJson(path.join(directory, 'package.json'), publishable)
  const packed = await packDirectory(directory, context.dist)
  log('publish-dir', `${path.relative(REPO_ROOT, directory)}: ${listed.length} files copied, tarball ${packed.tarball} `
    + `(${size(packed.bytes)} packed, ${size(packed.unpackedBytes)} unpacked, sha256 ${packed.sha256})`)
  context.plan = {
    mainName: manifest.name,
    mainVersion: manifest.version,
    mainPublishDir: directory,
    mainTarball: packed.path,
    mainTarballBytes: packed.bytes,
    mainTarballSha256: packed.sha256,
    mainUnpackedBytes: packed.unpackedBytes,
    mainFiles: packed.files,
  }
  await writeReleaseRecords(context, assembled)
  return context.plan
}
