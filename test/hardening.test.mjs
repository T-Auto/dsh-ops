/**
 * Shutdown and provisioning paths that used to fail silently.
 *
 * Adapted from PR #30 (WTStarMark, "fix: 修复 Linux 上原生 worker 完全不可用,并补上四条关停路径").
 * Three of its cases are here (its FastCtx job-shutdown and FastCtx `provision` cases left with the
 * FastCtx runtime); the two that overlap this branch are not, because this branch already
 * reports them differently and its own suites cover the difference:
 *
 * - #30 treats a directory `fsync` that returns `EBADF` on Linux as "this handle cannot sync on this
 *   platform" and stops reporting it. This branch keeps the barrier: `crate::sync_directory` reopens
 *   the directory through `/proc/self/fd` and performs a real `fsync`, so nothing is given up and
 *   nothing is downgraded to a warning (`native/src/lib.rs`).
 * - #30's receipt cases assert that the message contains no machine path *by saying nothing about
 *   which artifact failed*. This branch names the artifact package-relatively
 *   (`runtime/<target>/provenance.json`) and reports the error code only — the assertions below pin
 *   that contract: actionable, and still free of the operator's install path.
 *
 * Everything else is #30's, kept as written.
 */
import fs from 'node:fs'
import path from 'node:path'
import { resolveWorker, workerName } from '../lib/ptc/runtime.js'
import { mountBundledPwsh } from '../lib/session-pwsh.js'
import { assert, report, test, withTempDir } from './lib/harness.mjs'

function stageWorker(root) {
  const target = `${process.platform}-${process.arch}`
  const runtimeDir = path.join(root, 'runtime', target)
  fs.mkdirSync(runtimeDir, { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '9.9.9' }))
  const worker = path.join(runtimeDir, workerName(process.platform))
  fs.writeFileSync(worker, 'worker-bytes')
  // POSIX: the resolver refuses a worker without an execute bit before it ever reads the receipt
  // (report L12), so the fixture has to be executable to reach the branch under test.
  if (process.platform !== 'win32') fs.chmodSync(worker, 0o755)
  return { target, runtimeDir, worker, receipt: path.join(runtimeDir, 'provenance.json') }
}

function captureWorker(root) {
  try { return { value: resolveWorker({}, { packageRoot: root }) } } catch (error) { return { error } }
}

await test('a missing provenance receipt names the artifact without naming the install path', async () => {
  await withTempDir('hardening-provenance-missing', (dir) => {
    const fixture = stageWorker(dir)
    const { error } = captureWorker(dir)
    assert.ok(error, 'a runtime without a receipt must not resolve')
    assert.match(error.message, /provenance receipt at runtime\/[^/]+\/provenance\.json could not be read \(ENOENT\)/)
    // The point of the contract: actionable (which artifact) and no absolute path, because a tool
    // error text can be echoed back to the model.
    assert.ok(!error.message.includes(dir), `the message leaked the install path: ${error.message}`)
    assert.ok(!error.message.includes(fixture.runtimeDir), 'the message must not name the runtime directory')
    assert.ok(!/no such file or directory/.test(error.message), 'the raw filesystem message must not be forwarded')
  })
})

await test('a malformed provenance receipt is a parse failure, not a leaked raw error', async () => {
  await withTempDir('hardening-provenance-malformed', (dir) => {
    const fixture = stageWorker(dir)
    fs.writeFileSync(fixture.receipt, '{ not json')
    const { error } = captureWorker(dir)
    assert.ok(error, 'a malformed receipt must not resolve')
    assert.match(error.message, /provenance receipt at runtime\/[^/]+\/provenance\.json is not valid JSON \(SyntaxError\)/)
    assert.ok(!error.message.includes(dir), `the message leaked the install path: ${error.message}`)
  })
})

await test('one pwsh row that refuses the overlay does not strand the rows behind it', () => {
  const warnings = []
  const refusingRef = { get: () => 'original', [Symbol.for('cosmokit.volatile.write')]() { throw new Error('row refuses') } }
  const following = { current: 'original' }
  const followingRef = { get: () => following.current, [Symbol.for('cosmokit.volatile.write')](next) { following.current = next } }
  const row = (ref) => ({ options: { id: 'pwsh-sandbox', name: '@deepseek-ai/dsh-pwsh-sandbox', config: { pwshPath: 'original', retained: true } },
    fiber: { state: 2, config: { pwshPath: ref } } })
  const fixture = { inject(_deps, body) { body({
    get: () => ({ entries: () => [row(refusingRef), row(followingRef)] }),
    on: () => () => {},
    effect: (callback) => { callback() },
    logger: { warn: (message) => warnings.push(message) },
  }) } }
  mountBundledPwsh(fixture, { pwsh: { available: true, file: 'C:/pwsh.exe' } })
  assert.equal(following.current, 'C:/pwsh.exe')
  assert.equal(warnings.length, 1, 'the refusal is reported once')
  assert.match(warnings[0], /rejected the overlay: row refuses/)
})

report('hardening')
