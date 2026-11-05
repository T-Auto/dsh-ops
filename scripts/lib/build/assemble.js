/**
 * Step: assemble — what one release builds and the packages it stages.
 *
 * The Windows bash package is assembled from the committed skeleton in
 * `packages/bash-win32-x64/` plus the verified upstream tree and a per-package
 * `provenance.json`. PowerShell stays with the host and is never packaged.
 *
 * @module dsh-ops/build/lib/assemble
 */

import fs from 'node:fs'
import path from 'node:path'
import * as shellsModule from '../../../lib/shells.js'
import { resolveShellPin } from './pins.js'
import {
  REPO_ROOT, SCRIPT_SHA256, copyEntry, gitRevision, log, mainManifest, readJsonIfExists, run,
  sha256File, skeletonDigest, treeFiles, writeJson,
} from './util.js'

/** The shell package prefixes, the only source of the release's names. */
export const PLATFORM_PACKAGES = shellsModule.PLATFORM_PACKAGES

/**
 * The published name of one shell package, from the module that owns the names.
 * @param {'bash'|'pwsh'} kind - which shell.
 * @param {string} platform - `process.platform`.
 * @param {string} arch - `process.arch`.
 * @returns {string} the package name.
 */
export function shellPackageName(kind, platform, arch) {
  return `${PLATFORM_PACKAGES[kind].prefix}${platform}-${arch}`
}

/**
 * Describe every package this run builds.
 * @param {string} platform - `process.platform`.
 * @param {string} arch - `process.arch`.
 * @param {string} dist - the artifact directory.
 * @returns {object[]} one description per package, in publish order.
 */
export function describePackages(platform, arch, dist, backend = 'niubash') {
  if (backend === 'niubash') return []
  if (backend !== 'git-bash') throw new Error(`Unknown distribution backend: ${backend}`)
  const name = shellPackageName('bash', platform, arch)
  // Explicit legacy build only; the default main package never depends on this artifact.
  const version = '0.2.1'
  return [
    {
      kind: 'bash',
      name,
      version,
      platform,
      arch,
      dist,
      executable: `bin/${PLATFORM_PACKAGES.bash.executable}`,
      payload: { type: 'archive', pin: resolveShellPin('bash', platform, arch) },
    },
  ]
}

/**
 * The committed skeleton directory of one package: the metadata and the
 * documents that belong in the package, kept in the repository rather than in
 * the build script. The directory is named `<kind>-<platform>-<arch>` and
 * carries no scope, so a re-scoped release renames nothing.
 * @param {object} pkg - the package description.
 * @returns {string} the absolute path.
 */
export function skeletonDir(pkg) {
  return path.join(REPO_ROOT, 'packages', `${pkg.kind}-${pkg.platform}-${pkg.arch}`)
}

/** Where one package is assembled before packing. */
export function stageDir(pkg) {
  return path.join(pkg.dist, 'stage', `${pkg.kind}-${pkg.platform}-${pkg.arch}`)
}

// ---------------------------------------------------------------------------
// Step: assemble
// ---------------------------------------------------------------------------

/**
 * The `provenance.json` one package carries: the pin itself — everything a
 * deployment needs to fetch, verify, and unpack the upstream asset.
 * @param {object} pkg - the package.
 * @param {string} license - the SPDX expression of what the package carries.
 * @param {string} skeletonSha256 - the digest of the skeleton it was built from.
 * @returns {object} the provenance record.
 */
export function provenanceFor(pkg, license, skeletonSha256) {
  const common = {
    package: pkg.name,
    version: pkg.version,
    kind: pkg.kind,
    platform: pkg.platform,
    arch: pkg.arch,
    builtBy: 'scripts/build-platform-packages.mjs',
    builtBySha256: SCRIPT_SHA256,
    builtFromCommit: gitRevision(),
    builtAt: new Date().toISOString(),
  }
  if (pkg.payload.type !== 'archive') throw new Error(`${pkg.name}: unsupported payload type ${pkg.payload.type}`)
  const pin = pkg.payload.pin
  return {
    ...common,
    license,
    redistributesUpstreamBytes: true,
    notice: 'Complete upstream Windows runtime, redistributed without changes. Included licenses apply to their respective components.',
    payloadSha256: pin.entrySha256,
    payloadBytes: pin.entryBytes,
    skeletonSha256,
    entryPoint: pkg.executable,
    entrySha256: pin.entrySha256,
    entryBytes: pin.entryBytes,
    entryNote: pin.entryNote,
    upstream: {
      repository: pin.upstream,
      version: pin.upstreamVersion,
      releaseTag: pin.releaseTag,
      asset: {
        name: pin.assetName,
        url: pin.assetUrl,
        sha256: pin.assetSha256,
        bytes: pin.assetBytes,
      },
      extractor: pin.extractor,
      unpacked: {
        files: pin.unpackedFiles,
        bytes: pin.unpackedBytes,
        bytesAsSumOfFileSizes: pin.unpackedBytesSumOfFileSizes,
        layout: pin.unpackedLayout,
        note: pin.unpackedNote,
      },
      license: pin.license,
      copyright: pin.copyright,
    },
    pinSource: pin.pinSource,
  }
}

/**
 * Assemble the two package directories: pinned upstream tree, skeleton, manifest, provenance.
 * @param {object} context - the run context.
 * @returns {Promise<object>} the assembled package facts.
 */
export async function stepAssemble(context) {
  const { force } = context
  const results = []
  for (const pkg of context.packages) {
    const stage = stageDir(pkg)
    const directory = skeletonDir(pkg)
    if (!fs.existsSync(directory)) throw new Error(`missing package skeleton: ${path.relative(REPO_ROOT, directory)}`)
    const fragment = readJsonIfExists(path.join(directory, 'package.json'))
    if (fragment === undefined) throw new Error(`${path.relative(REPO_ROOT, directory)}/package.json is missing or unreadable`)
    if (fragment.name !== undefined || fragment.version !== undefined) {
      throw new Error(`${path.relative(REPO_ROOT, directory)}/package.json must not carry name/version: this script injects them`)
    }
    for (const fieldName of ['description', 'license', 'os', 'cpu']) {
      if (fragment[fieldName] === undefined) throw new Error(`${pkg.name}: the skeleton manifest has no ${fieldName}`)
    }

    const digest = skeletonDigest(directory)
    const complete = readJsonIfExists(path.join(stage, 'provenance.json'))
    if (!force && complete !== undefined && complete.skeletonSha256 === digest
      && complete.builtBySha256 === SCRIPT_SHA256
      && complete.version === pkg.version
      && complete.payloadSha256 === pkg.payload.pin.entrySha256 && fs.existsSync(path.join(stage, pkg.executable))) {
      log('assemble', `reusing ${pkg.name} (${pkg.payload.type})`)
      results.push({ pkg, stage, provenance: complete })
      continue
    }

    log('assemble', `assembling ${pkg.name} (${pkg.payload.type})`)
    fs.rmSync(stage, { recursive: true, force: true })
    fs.mkdirSync(stage, { recursive: true })

    if (pkg.payload.type === 'archive') {
      const pin = pkg.payload.pin
      const archive = path.join(context.dist, 'downloads', pin.assetName)
      if (!fs.existsSync(archive) || await sha256File(archive) !== pin.assetSha256) {
        throw new Error(`Missing verified archive: ${archive}; run fetch first`)
      }
      if (pin.extractor === 'zip') {
        const into = path.join(stage, 'bin')
        fs.mkdirSync(into, { recursive: true })
        run(path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/tar.exe'), ['-xf', archive, '-C', into])
      } else if (pin.extractor === 'sfx-7z') {
        run(archive, [`-o${stage}`, '-y'])
      } else throw new Error(`Unsupported archive extractor: ${pin.extractor}`)
      if (await sha256File(path.join(stage, pkg.executable)) !== pin.entrySha256) throw new Error(`Executable digest mismatch: ${pkg.name}`)
      // npm registry rejects tar hardlinks. Materialize each linked path as a
      // regular independent file without changing its bytes or runtime layout.
      for (const relative of treeFiles(stage)) {
        const file = path.join(stage, relative)
        if (fs.statSync(file).nlink > 1) {
          const temporary = `${file}.dsh-ops-materialize`
          fs.copyFileSync(file, temporary)
          fs.unlinkSync(file)
          fs.renameSync(temporary, file)
        }
      }
    }

    const provenance = provenanceFor(pkg, fragment.license, digest)
    writeJson(path.join(stage, 'provenance.json'), provenance)

    // The skeleton's own files land last: the payload never overwrites a
    // committed licence or notice, and a collision is a stopped release rather
    // than a silently mixed package.
    for (const entry of fs.readdirSync(directory).sort()) {
      const from = path.join(directory, entry)
      const to = path.join(stage, entry)
      if (entry === 'package.json') continue
      if (fs.existsSync(to)) throw new Error(`${pkg.name}: skeleton file ${entry} collides with the extracted payload`)
      copyEntry(from, to)
    }
    writeJson(path.join(stage, 'package.json'), { name: pkg.name, version: pkg.version, ...fragment })

    log('assemble', `${pkg.name}@${pkg.version}: ${pkg.executable} sha256 ${provenance.payloadSha256}`)
    results.push({ pkg, stage, provenance: readJsonIfExists(path.join(stage, 'provenance.json')) ?? provenance })
  }
  return results
}
