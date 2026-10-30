/**
 * Step: pack — tarballs and the release-wide records.
 *
 * `npm pack` each directory, then write `SHA256SUMS`, the release-wide
 * `provenance.json`, and the publish plan.
 *
 * @module dsh-ops/build/lib/pack
 */

import fs from 'node:fs'
import path from 'node:path'
import { fixUnixWorkerModes } from './tar-modes.js'
import {
  gitRevision, log, mainManifest, npm, parseNpmJson, readJsonIfExists, sha256File, size, writeJson,
} from './util.js'

/**
 * Pack one package directory and return what npm reported.
 * @param {string} directory - the package directory.
 * @param {string} dist - where the tarball lands.
 * @returns {Promise<object>} the tarball facts.
 */
export async function packDirectory(directory, dist) {
  const result = npm(['pack', '--ignore-scripts', '--pack-destination', dist, '--json'], { cwd: directory })
  const [reported] = parseNpmJson(result.stdout, `npm pack in ${directory}`)
  const tarball = path.join(dist, reported.filename)
  if (readJsonIfExists(path.join(directory, 'package.json'))?.name === 'dsh-ops') {
    await fixUnixWorkerModes(tarball)
  }
  return {
    tarball: reported.filename,
    path: tarball,
    bytes: fs.statSync(tarball).size,
    sha256: await sha256File(tarball),
    unpackedBytes: reported.unpackedSize,
    files: Array.isArray(reported.files) ? reported.files.length : undefined,
  }
}

/**
 * Pack every assembled package and rewrite the release records.
 * @param {object} context - the run context.
 * @param {object[]} assembled - the assembled packages.
 * @returns {Promise<object>} the tarball facts per package.
 */
export async function stepPack(context, assembled) {
  const tarballs = context.tarballs ?? {}
  for (const { pkg, stage } of assembled) {
    const packed = await packDirectory(stage, context.dist)
    tarballs[pkg.kind] = packed
    log('pack', `${packed.tarball}: ${size(packed.bytes)} packed, ${size(packed.unpackedBytes)} unpacked, `
      + `${String(packed.files)} files, sha256 ${packed.sha256}`)
  }
  context.tarballs = tarballs
  await writeReleaseRecords(context, assembled)
  return tarballs
}

/**
 * Write `SHA256SUMS`, the release-wide `provenance.json`, and the publish plan.
 *
 * `SHA256SUMS` is the `sha256sum -c` format on purpose: it is the file an
 * offline installer verifies the released assets against, and it is uploaded to
 * the release as an asset of its own.
 *
 * @param {object} context - the run context.
 * @param {object[]} assembled - the assembled packages.
 * @returns {Promise<void>} nothing.
 */
export async function writeReleaseRecords(context, assembled) {
  const { dist } = context
  const byKind = new Map(assembled.map((entry) => [entry.pkg.kind, entry]))
  const packages = []
  for (const pkg of context.packages) {
    const packed = context.tarballs?.[pkg.kind]
    const entry = byKind.get(pkg.kind)
    if (packed === undefined || entry === undefined) continue
    const provenance = entry.provenance ?? {}
    const upstream = provenance.upstream ?? {}
    const asset = upstream.asset ?? {}
    packages.push({
      name: pkg.name,
      kind: pkg.kind,
      version: pkg.version,
      // Where the bytes come from: the pinned upstream release asset.
      sourceUrl: asset.url,
      sourceSha256: asset.sha256,
      sourceBytes: asset.bytes,
      upstreamVersion: upstream.version,
      upstreamRelease: upstream.releaseTag,
      // What the pinned asset unpacks to, measured rather than estimated: this
      // is the footprint a deployment takes on when it resolves the shell.
      upstreamUnpackedFiles: upstream.unpacked?.files,
      upstreamUnpackedBytes: upstream.unpacked?.bytes,
      upstreamUnpackedBytesAsSumOfFileSizes: upstream.unpacked?.bytesAsSumOfFileSizes,
      license: provenance.license,
      redistributesUpstreamBytes: true,
      entryPoint: pkg.executable,
      payloadSha256: provenance.payloadSha256 ?? provenance.entrySha256,
      payloadBytes: provenance.payloadBytes ?? provenance.entryBytes,
      tarball: packed.tarball,
      tarballSha256: packed.sha256,
      bytes: packed.bytes,
      unpackedBytes: packed.unpackedBytes,
      files: packed.files,
    })
  }
  const files = fs.readdirSync(dist).filter((name) => name.endsWith('.tgz')).sort()
  const sums = []
  for (const name of files) sums.push(`${await sha256File(path.join(dist, name))}  ${name}`)
  fs.writeFileSync(path.join(dist, 'SHA256SUMS'), `${sums.join('\n')}${sums.length === 0 ? '' : '\n'}`)
  writeJson(path.join(dist, 'provenance.json'), {
    generatedBy: 'scripts/build-platform-packages.mjs',
    commit: gitRevision(),
    mainPackage: {
      name: mainManifest().name,
      version: mainManifest().version,
      ...context.plan === undefined
        ? {}
        : {
          tarball: path.basename(context.plan.mainTarball),
          tarballSha256: context.plan.mainTarballSha256,
          bytes: context.plan.mainTarballBytes,
          unpackedBytes: context.plan.mainUnpackedBytes,
          files: context.plan.mainFiles,
        },
    },
    packages,
    tarballs: files,
  })
  const plan = readJsonIfExists(path.join(dist, 'publish-plan.json')) ?? {}
  writeJson(path.join(dist, 'publish-plan.json'), {
    ...plan,
    version: mainManifest().version,
    sha256sums: 'SHA256SUMS',
    provenance: 'provenance.json',
    platformTarballs: context.packages
      .map((pkg) => context.tarballs?.[pkg.kind]?.path)
      .filter((value) => value !== undefined),
    // Name, version, and tarball together: a re-run of the release job can ask
    // the registry whether that exact version is already published and skip it,
    // instead of failing the whole release on a package that got through before
    // something later in the pipeline did not.
    platformPackages: packages.map((entry) => ({
      name: entry.name,
      version: entry.version,
      tarball: path.join(dist, entry.tarball),
      sha256: entry.tarballSha256,
      carriesPayload: entry.redistributesUpstreamBytes,
    })),
    ...context.plan ?? {},
  })
}

/**
 * Print the artifact table from the release-wide `provenance.json`.
 *
 * This is the table a release report is written from: what is published, how
 * large each tarball is packed and unpacked, how many files it carries, and the
 * digest of the exact bytes that would be uploaded.
 * @param {string} dist - the artifact directory.
 * @returns {void}
 */
export function printArtifactTable(dist) {
  const record = readJsonIfExists(path.join(dist, 'provenance.json'))
  if (record === undefined) return
  const rows = (record.packages ?? []).map((entry) => [
    entry.name, entry.version, entry.tarball, size(entry.bytes), size(entry.unpackedBytes),
    String(entry.files ?? '?'), entry.tarballSha256,
  ])
  const main = record.mainPackage ?? {}
  if (main.tarball !== undefined) {
    rows.push([
      main.name, main.version, main.tarball, size(main.bytes), size(main.unpackedBytes),
      String(main.files ?? '?'), main.tarballSha256,
    ])
  }
  console.log(`\nrelease artifacts (${path.join(dist, 'provenance.json')}):`)
  console.log(`  ${'package'.padEnd(30)} ${'version'.padEnd(7)} ${'tarball'.padEnd(42)} `
    + `${'packed'.padStart(9)} ${'unpacked'.padStart(10)} ${'files'.padStart(6)}  sha256`)
  for (const row of rows) {
    console.log(`  ${row[0].padEnd(30)} ${row[1].padEnd(7)} ${row[2].padEnd(42)} `
      + `${row[3].padStart(9)} ${row[4].padStart(10)} ${row[5].padStart(6)}  ${row[6]}`)
  }
  console.log()
}
