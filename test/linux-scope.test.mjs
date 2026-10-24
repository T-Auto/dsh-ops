/**
 * Platform scope and runtime integrity of the native worker, ported from the
 * corrected ad-hoc `D-platform` / `D2-platform` probes in
 * `dsh-ops-boundary-report.md`.
 *
 * The suite drives this checkout's own resolver (`lib/ptc/runtime.js`) and the
 * declarations beside it, not an installed copy, so it describes the tree that
 * is about to be published rather than whatever happens to be installed on the
 * machine running the gate.
 *
 * What this suite locks in:
 *
 * - The platform gate refuses a foreign target by name and names the supported
 *   set; it is not a truthiness check on `process.platform`.
 * - A runtime directory is trusted only when `provenance.json` matches the
 *   worker byte-for-byte: a tampered worker, a forged receipt and a missing
 *   receipt are all refused, and a foreign-only `runtime/` is never a
 *   cross-platform substitute.
 * - The three declaration layers agree: `package.json` `os`, the resolver's
 *   `PLATFORMS`, and `dsh-plugin.json`'s `contributes['x-components']` row for
 *   the PTC component. This is the corrected form of probe D11, which searched
 *   the manifest for the literal string `linux-x64` and so always failed.
 * - The staged worker for this host hashes to exactly the digest in its receipt.
 *
 * Platform. All of it runs on win32 as well: the resolver is plain JavaScript,
 * and the fixtures use Node paths and a synthetic worker rather than the real
 * 3.6 MiB binary, so nothing here needs a POSIX feature. The one host-dependent
 * case (the real staged worker) derives its target from `process` and skips
 * itself where `runtime/` carries only the other platform.
 *
 * Scope note: the release-closure gates (`bin/check-release.mjs`,
 * `bin/native-runtime.mjs`, `npm run check:ptc-runtime`) are covered by
 * `test/release-scope.test.mjs`, which was added for that purpose, so this suite
 * deliberately does not duplicate them.
 *
 * @module dsh-ops/test/linux-scope
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { PLATFORMS, resolveWorker, workerName } from '../lib/ptc/runtime.js'
import { PACKAGE_ROOT, assert, report, test, withTempDir } from './lib/harness.mjs'
import { requireWorker } from './lib/boundary.mjs'

requireWorker('linux-scope')

const VERSION = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version
const PLUGIN = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'dsh-plugin.json'), 'utf8'))
const HOST_TARGET = `${process.platform}-${process.arch}`

/** A package tree with just enough of a manifest for the resolver's version check. */
function stagePackage(root) {
  fs.mkdirSync(root, { recursive: true })
  fs.copyFileSync(path.join(PACKAGE_ROOT, 'package.json'), path.join(root, 'package.json'))
  return root
}

/**
 * Write a synthetic worker plus a receipt for it.
 * @param {string} root - the package tree to write into.
 * @param {object} options - fixture inputs.
 * @param {string} options.target - the runtime directory name.
 * @param {Buffer} [options.bytes] - the worker bytes.
 * @param {string} [options.overwrite] - override the receipt digest.
 * @param {string} [options.executable] - override the receipt's executable name.
 * @param {boolean} [options.receipt] - write a receipt at all.
 * @returns {{worker: string, receipt: string|null}} the fixture paths.
 */
function stageRuntime(root, { target, bytes = Buffer.from('synthetic worker bytes'), overwrite, executable, receipt = true }) {
  const directory = path.join(root, 'runtime', target)
  fs.mkdirSync(directory, { recursive: true })
  const name = workerName(target.split('-')[0])
  const worker = path.join(directory, name)
  fs.writeFileSync(worker, bytes)
  if (process.platform !== 'win32') fs.chmodSync(worker, 0o755)
  if (!receipt) return { worker, receipt: null }
  const receiptPath = path.join(directory, 'provenance.json')
  fs.writeFileSync(receiptPath, `${JSON.stringify({
    version: VERSION,
    target,
    executable: executable ?? name,
    sha256: overwrite ?? createHash('sha256').update(fs.readFileSync(worker)).digest('hex'),
    source: 'synthetic fixture',
  }, null, 2)}\n`)
  return { worker, receipt: receiptPath }
}

await test('every foreign target is refused by name, naming the supported set', async () => {
  for (const target of ['linux-arm64', 'win32-arm64', 'linux-riscv64', 'openharmony-arm64', 'darwin-riscv64']) {
    const [platform, arch] = target.split('-')
    await withTempDir(`linux-scope-${target}`, async root => {
      let error = null
      let resolved = null
      try { resolved = resolveWorker({}, { packageRoot: stagePackage(root), platform, arch, env: {} }) } catch (caught) { error = caught }
      assert.equal(resolved, null, `${target} resolved to ${resolved}`)
      assert.ok(error, `${target} was allowed`)
      assert.match(error.message, /Windows x64, Linux x64 and macOS/)
      assert.ok(error.message.includes(target), `the message must name ${target}: ${error.message}`)
    })
  }
  assert.deepEqual([...PLATFORMS], ['win32-x64', 'linux-x64', 'darwin-arm64', 'darwin-x64'])
  assert.equal(workerName('win32'), 'dsh-ops-worker.exe')
  assert.equal(workerName('linux'), 'dsh-ops-worker')
})

await test('a tampered worker, a forged receipt and a missing receipt are all refused', async () => {
  await withTempDir('linux-scope-tamper', async root => {
    const packageRoot = stagePackage(path.join(root, 'tampered'))
    const tampered = stageRuntime(packageRoot, { target: HOST_TARGET, bytes: Buffer.from('worker bytes before tampering') })
    const bytes = fs.readFileSync(tampered.worker)
    bytes[Math.floor(bytes.length / 2)] ^= 0xff
    fs.writeFileSync(tampered.worker, bytes)
    assert.throws(() => resolveWorker({}, { packageRoot, env: {} }), /provenance mismatch/)

    const forgedRoot = stagePackage(path.join(root, 'forged'))
    stageRuntime(forgedRoot, { target: HOST_TARGET, overwrite: 'f'.repeat(64) })
    assert.throws(() => resolveWorker({}, { packageRoot: forgedRoot, env: {} }), /provenance mismatch/)

    const noReceiptRoot = stagePackage(path.join(root, 'no-receipt'))
    stageRuntime(noReceiptRoot, { target: HOST_TARGET, receipt: false })
    let missing = null
    try { resolveWorker({}, { packageRoot: noReceiptRoot, env: {} }) } catch (caught) { missing = caught }
    assert.ok(missing, 'a runtime directory without a receipt must not resolve')
    // The failure is not the resolver's friendly "unavailable" message: it reads
    // the receipt unconditionally and lets ENOENT escape. Fail-closed is the
    // property that matters here; the diagnostic shape is not asserted so that
    // improving it will not turn this suite red.
    assert.match(missing.message, /unavailable|ENOENT/)
  })
})

await test('a foreign-only runtime directory is not a cross-platform substitute', async () => {
  const foreignTarget = HOST_TARGET === 'linux-x64' ? 'win32-x64' : 'linux-x64'
  await withTempDir('linux-scope-substitute', async root => {
    const packageRoot = stagePackage(path.join(root, 'package'))
    stageRuntime(packageRoot, { target: foreignTarget })
    let error = null
    let resolved = null
    try { resolved = resolveWorker({}, { packageRoot, env: {} }) } catch (caught) { error = caught }
    assert.equal(resolved, null, `resolved a ${foreignTarget} payload for ${HOST_TARGET}`)
    assert.ok(error)
    assert.match(error.message, /unavailable/)
  })
})

await test('package.json, the resolver and the plugin manifest declare the same scope', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  const components = PLUGIN.contributes?.['x-components'] ?? []
  const ptc = components.find(component => component.id === 'dsh-ops-ptc')
  assert.ok(ptc, 'the PTC component row is missing from contributes.x-components')
  assert.deepEqual([...PLATFORMS], ['win32-x64', 'linux-x64', 'darwin-arm64', 'darwin-x64'], 'only the approved target pairs are supported')
  assert.deepEqual(manifest.os, ['win32', 'linux', 'darwin'])
  assert.deepEqual(ptc.platforms, ['win32', 'linux', 'darwin'])
  assert.deepEqual(ptc.architectures, ['x64', 'arm64'])
  assert.deepEqual(ptc.targets, [...PLATFORMS], 'exact targets, not the os/cpu Cartesian product, define support')
})

await test('the staged worker for this host hashes to exactly its provenance digest', async () => {
  const runtime = path.join(PACKAGE_ROOT, 'runtime', HOST_TARGET)
  if (!fs.existsSync(path.join(runtime, 'provenance.json'))) return
  const receipt = JSON.parse(fs.readFileSync(path.join(runtime, 'provenance.json'), 'utf8'))
  const resolved = resolveWorker({}, { packageRoot: PACKAGE_ROOT, env: {} })
  const actual = createHash('sha256').update(fs.readFileSync(resolved)).digest('hex')
  assert.equal(receipt.target, HOST_TARGET)
  assert.equal(receipt.version, VERSION)
  assert.equal(receipt.executable, workerName(process.platform))
  assert.equal(actual, receipt.sha256, 'the published digest must match the published worker')
})

report('linux-scope')
