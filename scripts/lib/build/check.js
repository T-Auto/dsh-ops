/**
 * Step: check — verify every artifact without downloading or building.
 *
 * The gate `--check` and the post-build step of `all` both run: it reads the
 * artifacts on disk and compares them with the pins, the record, and
 * `SHA256SUMS`.
 *
 * @module dsh-ops/build/lib/check
 */

import fs from 'node:fs'
import { checkUnixWorkerModes } from './tar-modes.js'
import path from 'node:path'
import { stageDir } from './assemble.js'
import { injectedOptionalDependencies, printInjection } from './publish-dir.js'
import { mainManifest, readJsonIfExists, sha256File, size, treeFiles } from './util.js'

/**
 * Verify every artifact this release would publish, without producing any.
 * @param {object} context - the run context.
 * @returns {Promise<number>} the number of problems found.
 */
export async function stepCheck(context) {
  const { dist } = context
  const problems = []
  const ok = (scope, message) => console.log(`  ok      ${scope.padEnd(11)} ${message}`)
  /**
   * Record one failure.
   * @param {string} scope - the area.
   * @param {string} message - what is missing or wrong.
   * @returns {void}
   */
  const missing = (scope, message) => {
    problems.push(`${scope}: ${message}`)
    console.log(`  MISSING ${scope.padEnd(11)} ${message}`)
  }
  console.log(`\ncheck: ${dist}`)

  // 1. The pins, printed in full: this is the list a human reconciles against
  //    the upstream release pages, and the only place a fallback pin shows up.
  console.log('  pins this release publishes:')
  for (const pkg of context.packages) {
    if (pkg.payload.type !== 'archive') continue
    const pin = pkg.payload.pin
    console.log(`    ${pkg.name} -> ${pin.upstream} ${pin.releaseTag}`)
    console.log(`      asset   ${pin.assetName} ${pin.assetBytes} bytes`)
    console.log(`      url     ${pin.assetUrl}`)
    console.log(`      sha256  ${pin.assetSha256}`)
    console.log(`      entry   ${pin.entryPoint} sha256 ${pin.entrySha256} (${pin.entryBytes} bytes)`)
    console.log(`      unpacked ${pin.unpackedFiles} files, ${pin.unpackedBytes} bytes (${size(pin.unpackedBytes)})`
      + (pin.unpackedBytesSumOfFileSizes === pin.unpackedBytes
        ? ''
        : `; sum of file sizes ${pin.unpackedBytesSumOfFileSizes}`))
    console.log(`      licence ${pin.license} - ${pin.copyright}`)
    console.log(`      source  ${pin.pinSource}`)
  }

  const recorded = readJsonIfExists(path.join(dist, 'downloads', 'sources.json'))
  if (recorded !== undefined) {
    ok('download', `downloads/sources.json records ${(recorded.assets ?? []).length} verified asset(s)`)
  }

  // 2. Every stage: the executable's digest, and the upstream archive against its pin.
  const assembled = []
  for (const pkg of context.packages) {
    const stage = stageDir(pkg)
    const provenance = readJsonIfExists(path.join(stage, 'provenance.json'))
    if (provenance === undefined) {
      missing('stage', `${pkg.name} is not assembled (${path.relative(dist, stage)}/provenance.json)`)
      continue
    }
    const files = treeFiles(stage)
    if (pkg.payload.type === 'archive' && provenance.upstream?.asset?.sha256 !== pkg.payload.pin.assetSha256) {
      missing('stage', `${pkg.name} upstream archive digest differs from its pin`)
    }
    {
      const entry = path.join(stage, pkg.executable)
      if (!fs.existsSync(entry)) {
        missing('stage', `${pkg.name} has no ${pkg.executable}`)
      } else {
        const sha256 = await sha256File(entry)
        if (sha256 !== provenance.payloadSha256) {
          missing('stage', `${pkg.name} ${pkg.executable} hashes to ${sha256}, provenance says ${provenance.payloadSha256}`)
        } else {
          ok('stage', `${pkg.name}@${provenance.version} ${pkg.executable} (${size(fs.statSync(entry).size)}, sha256 ${sha256})`)
        }
      }
    }
    if (provenance.version !== pkg.version) {
      missing('stage', `${pkg.name} records version ${provenance.version}, its declared pin is ${pkg.version}`)
    }
    assembled.push({ pkg, stage, provenance })
  }

  // 3. The tarballs, against the checksum manifest.
  const sumsFile = path.join(dist, 'SHA256SUMS')
  const sums = new Map()
  if (!fs.existsSync(sumsFile)) {
    missing('tarball', 'SHA256SUMS is not written')
  } else {
    for (const line of fs.readFileSync(sumsFile, 'utf8').split('\n')) {
      const match = /^([0-9a-f]{64}) {2}(.+)$/u.exec(line.trim())
      if (match !== null) sums.set(match[2], match[1])
    }
  }
  context.tarballs = context.tarballs ?? {}
  const expectedTarballs = []
  for (const { pkg } of assembled) {
    // npm names a tarball after the package name with the scope marker removed
    // and the separator replaced (`@scope/name` -> `scope-name-<version>.tgz`),
    // so the expected file is derived, not searched for.
    const tarball = `${pkg.name.replace(/^@/u, '').replace(/\//gu, '-')}-${pkg.version}.tgz`
    expectedTarballs.push(tarball)
    if (!fs.existsSync(path.join(dist, tarball))) {
      missing('tarball', `${pkg.name} is not packed (expected ${tarball})`)
      continue
    }
    const sha256 = await sha256File(path.join(dist, tarball))
    const bytes = fs.statSync(path.join(dist, tarball)).size
    if (sums.size > 0 && sums.get(tarball) !== sha256) {
      missing('tarball', `${tarball} hashes to ${sha256}, SHA256SUMS says ${String(sums.get(tarball))}`)
    } else {
      ok('tarball', `${tarball} (${size(bytes)}, sha256 ${sha256})`)
    }
    context.tarballs[pkg.kind] = { tarball, path: path.join(dist, tarball), bytes, sha256 }
  }

  // The manifest has to describe exactly this release's artifacts and nothing
  // else: an entry left over from an earlier build is a digest waiting to be
  // trusted about bytes that are no longer there, and an artifact missing from
  // it cannot be verified offline at all.
  const mainTarballName = `${mainManifest().name}-${mainManifest().version}.tgz`
  if (fs.existsSync(path.join(dist, mainTarballName))) expectedTarballs.push(mainTarballName)
  if (sums.size > 0) {
    const extra = [...sums.keys()].filter((name) => !expectedTarballs.includes(name))
    const unlisted = expectedTarballs.filter((name) => fs.existsSync(path.join(dist, name)) && !sums.has(name))
    if (extra.length > 0) {
      missing('checksums', `SHA256SUMS lists ${extra.join(', ')}, which this release does not produce`)
    }
    if (unlisted.length > 0) missing('checksums', `SHA256SUMS omits ${unlisted.join(', ')}`)
    if (extra.length === 0 && unlisted.length === 0) {
      ok('checksums', `SHA256SUMS lists exactly the ${sums.size} artifact(s) this release produces`)
    }
  }

  // 4. The publish directory and the main tarball.
  const manifest = mainManifest()
  // Each platform package is compared with its own declared pin, not with the main package
  // version: the restored Windows Bash payload stays at 0.2.1 while the plugin is at 0.4.0.
  const declaredVersions = new Map(context.packages.map((pkg) => [pkg.name, pkg.version]))
  const publishDir = path.join(dist, 'publish', `${manifest.name}-${manifest.version}`)
  const publishManifest = readJsonIfExists(path.join(publishDir, 'package.json'))
  const mainTarball = path.join(dist, `${manifest.name}-${manifest.version}.tgz`)
  if (publishManifest === undefined) {
    missing('publish', `${path.relative(dist, publishDir)}/package.json does not exist`)
  } else {
    const expected = injectedOptionalDependencies(context)
    const injected = publishManifest.optionalDependencies ?? {}
    const wrong = Object.entries(expected).filter(([name, range]) => injected[name] !== range)
    const unexpected = Object.keys(injected).filter((name) => expected[name] === undefined)
    if (wrong.length > 0 || unexpected.length > 0) {
      missing('publish', 'injected optionalDependencies differ: '
        + `${wrong.map(([name, range]) => `${name} should be ${range}, is ${String(injected[name])}`).join('; ')}`
        + (unexpected.length === 0 ? '' : `; unexpected ${unexpected.join(', ')}`))
    } else {
      ok('publish', `${path.relative(dist, publishDir)} injects ${Object.keys(expected).length} optionalDependencies`)
    }
    if (publishManifest.private === true) {
      missing('publish', `${path.relative(dist, publishDir)}/package.json is still private, so npm would refuse it`)
    } else {
      ok('publish', `${path.relative(dist, publishDir)} carries no private flag`)
    }
  }
  if (!fs.existsSync(mainTarball)) missing('publish', `${path.basename(mainTarball)} is not packed`)
  else if (sums.size > 0 && sums.get(path.basename(mainTarball)) !== await sha256File(mainTarball)) {
    missing('publish', `${path.basename(mainTarball)} is not the digest SHA256SUMS records`)
  } else {
    ok('publish', `${path.basename(mainTarball)} (${size(fs.statSync(mainTarball).size)})`)
  }

  if (fs.existsSync(mainTarball)) {
    try {
      await checkUnixWorkerModes(mainTarball)
      ok('modes', 'all three Unix workers have TAR mode 0755')
    } catch (error) {
      missing('modes', error.message)
    }
  }

  // 5. The release-wide record.
  const releaseProvenance = readJsonIfExists(path.join(dist, 'provenance.json'))
  if (releaseProvenance === undefined) missing('provenance', 'provenance.json is not written')
  else if ((releaseProvenance.packages ?? []).length !== context.packages.length) {
    missing('provenance', `provenance.json lists ${String((releaseProvenance.packages ?? []).length)} packages, expected ${context.packages.length}`)
  } else if ((releaseProvenance.packages ?? []).some((entry) => declaredVersions.get(entry.name) !== entry.version)) {
    missing('provenance', 'provenance.json carries a package whose version is not its declared pin')
  } else {
    ok('provenance', `provenance.json lists ${releaseProvenance.packages.length} packages at their declared pins`)
  }

  printInjection(context)
  if (problems.length > 0) {
    console.log(`check: ${problems.length} problem(s); nothing was downloaded or built`)
    for (const problem of problems) console.log(`  - ${problem}`)
    return problems.length
  }
  console.log('check: every artifact the release publishes is present and matches its recorded digest')
  return 0
}
