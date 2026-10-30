import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { tar, UNIX_WORKERS } from '../scripts/lib/build/tar-modes.js'
import { hostPwshUpgradePlan, upgradeHostPwsh, runUpgradeProcess } from '../lib/shells/pwsh-upgrade.js'
import { applyComponent } from '../lib/index.js'
import { resolveShells } from '../lib/shells.js'
import { describePackages } from '../scripts/lib/build/assemble.js'
import { writeReleaseRecords } from '../scripts/lib/build/pack.js'
import { stepCheck } from '../scripts/lib/build/check.js'
import { injectedOptionalDependencies } from '../scripts/lib/build/publish-dir.js'
import { assert, report, test, withTempDir, TEST_HOME, PACKAGE_ROOT } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'

const ARGS = ['install', '--id', 'Microsoft.PowerShell', '--exact', '--source', 'winget', '--installer-type', 'wix']
function fixture(root) {
  const file = path.join(root, 'Microsoft/WindowsApps/winget.exe')
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'never execute this fixture')
  return { file, platform: 'win32', env: { LOCALAPPDATA: root, PATH: '' } }
}
const success = { started: true, exitCode: 0, signal: null }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function mainArchive(file) {
  const blocks = []
  for (const name of [...UNIX_WORKERS, 'package/runtime/win32-x64/dsh-ops-worker.exe']) {
    const body = Buffer.from('fixture worker')
    const header = new tar.Header({ path: name, mode: 0o755, size: body.length, type: 'File' })
    header.encode()
    blocks.push(header.block, body, Buffer.alloc(512 - body.length))
  }
  fs.writeFileSync(file, gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])))
}

await test('the upgrade plan uses the standard exact stable package and an absolute WinGet path', async () => {
  await withTempDir('upgrade-plan', root => {
    const input = fixture(root), plan = hostPwshUpgradePlan(input)
    assert.equal(plan.supported, true); assert.equal(plan.file, input.file); assert.deepEqual(plan.args, ARGS)
    assert.match(plan.guidance, /Restart DSH/); assert.match(plan.guidance, /explicit host pwshPath is preserved/)
    assert.equal(hostPwshUpgradePlan({ platform: 'linux', env: input.env }).supported, false)
    assert.match(hostPwshUpgradePlan({ platform: 'win32', env: {} }).unavailable, /WinGet is unavailable/)
    assert.equal(hostPwshUpgradePlan({ platform: 'win32', env: { PATH: 'relative;.', LOCALAPPDATA: '.' } }).supported, false)
    assert.equal(hostPwshUpgradePlan({ platform: 'win32', env: { PATH: `"${path.dirname(input.file)}"` } }).file, input.file)
  })
})
await test('default preview, dry-run and unavailable plans never start an installer', async () => {
  await withTempDir('upgrade-preview', async root => {
    const input = fixture(root)
    const runner = () => { throw new Error('preview must not execute') }
    for (const options of [{}, { execute: true, dryRun: true }]) {
      const result = await upgradeHostPwsh({ ...input, ...options, runner })
      assert.equal(result.status, 'preview'); assert.equal(result.effectState, 'none')
    }
    const unavailable = await upgradeHostPwsh({ platform: 'win32', env: {}, execute: true, runner })
    assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.effectState, 'none')
  })
})
await test('explicit execution preserves exact argv and classifies every installer exit honestly', async () => {
  await withTempDir('upgrade-exit', async root => {
    const input = fixture(root)
    const outcomes = [
      [success, 'completed', 'applied'],
      [{ ...success, exitCode: 0x8a15002b }, 'no-update', 'none'],
      [{ ...success, exitCode: 0x8a15002b | 0 }, 'no-update', 'none'],
      [{ ...success, exitCode: 42 }, 'failed', 'unknown'],
      [{ ...success, exitCode: null }, 'failed', 'unknown'],
      [{ ...success, error: 'installer error' }, 'failed', 'unknown'],
      [{ started: false, exitCode: null, signal: null, error: 'missing executable' }, 'failed', 'none'],
      [{ ...success, signal: 'SIGTERM' }, 'cancelled', 'unknown'],
    ]
    for (const [outcome, status, effect] of outcomes) {
      const result = await upgradeHostPwsh({ ...input, execute: true, runner: async plan => {
        assert.equal(plan.file, input.file); assert.deepEqual(plan.args, ARGS); return outcome
      } })
      assert.equal(result.status, status); assert.equal(result.effectState, effect)
      assert.equal(result.exitCode, outcome.exitCode)
    }
    const thrown = await upgradeHostPwsh({ ...input, execute: true, runner: async () => { throw 'runner failed' } })
    assert.equal(thrown.status, 'failed'); assert.equal(thrown.effectState, 'unknown'); assert.equal(thrown.error, 'runner failed')
  })
})
await test('cancellation before launch has no effects while cancellation after launch stays unknown', async () => {
  await withTempDir('upgrade-cancel', async root => {
    const input = fixture(root), before = new AbortController(), during = new AbortController()
    before.abort()
    const cancelled = await upgradeHostPwsh({ ...input, execute: true, signal: before.signal,
      runner: () => { throw new Error('pre-cancelled work must not launch') } })
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.effectState, 'none')
    const active = await upgradeHostPwsh({ ...input, execute: true, signal: during.signal, runner: async (_plan, signal) => {
      assert.equal(signal, during.signal); during.abort(); return success
    } })
    assert.equal(active.status, 'cancelled'); assert.equal(active.effectState, 'unknown')
  })
})
await test('the CLI subprocess runner reports real nonzero exits and spawn failures without invoking a shell', async () => {
  const base = { supported: true, guidance: 'fixture' }
  const child = await runUpgradeProcess({ ...base, file: process.execPath, args: ['-e', 'process.exit(7)'] })
  assert.equal(child.started, true); assert.equal(child.exitCode, 7); assert.equal(child.signal, null)
  const missing = await runUpgradeProcess({ ...base, file: path.join(TEST_HOME, 'no-such-installer.exe'), args: [] })
  assert.equal(missing.started, false); assert.match(missing.error, /ENOENT/)
  const controller = new AbortController(); controller.abort()
  const aborted = await runUpgradeProcess({ ...base, file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }, controller.signal)
  assert.match(aborted.error, /abort/i)
})
await test('CLI preview and --yes --dry-run leave the fake installer untouched', async () => {
  await withTempDir('upgrade-cli', root => {
    const input = fixture(root)
    for (const args of [[], ['--yes', '--dry-run']]) {
      const child = spawnSync(process.execPath, [path.join(PACKAGE_ROOT, 'bin/dsh-ops.mjs'), 'upgrade-host-pwsh', ...args], {
        cwd: PACKAGE_ROOT, encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: root, PATH: '' },
      })
      assert.equal(child.status, process.platform === 'win32' ? 0 : 1, child.stderr)
      assert.match(child.stdout, process.platform === 'win32' ? /"status": "preview"/ : /"status": "unavailable"/)
      assert.equal(fs.readFileSync(input.file, 'utf8'), 'never execute this fixture')
    }
  })
})
await test('shell mount preserves live host configuration and legacy provisioned PowerShell files', async () => {
  const legacy = path.join(TEST_HOME, 'dsh-ops/shells/pwsh/99.0/bin/pwsh.exe')
  fs.mkdirSync(path.dirname(legacy), { recursive: true }); fs.writeFileSync(legacy, 'legacy unchanged')
  const declared = path.join(TEST_HOME, 'custom-host/pwsh.exe')
  let current = declared, writes = 0
  const entry = { options: { id: 'pwsh-sandbox', name: '@deepseek-ai/dsh-pwsh-sandbox', config: { pwshPath: declared } },
    fiber: { state: 2, config: { pwshPath: { get: () => current,
      [Symbol.for('cosmokit.volatile.write')](value) { writes++; current = value } } } } }
  const { ctx } = await bootHost()
  try {
    await ctx.plugin(inner => inner.provide('loader', { entries: () => [entry] }))
    const fiber = await ctx.plugin({ name: 'host-pwsh-preservation', apply(inner) {
      applyComponent(inner, { publishBashTool: false, configUpdateVersion: 2 }, 'shell')
    } })
    assert.equal(resolveShells({}).pwsh.available, false)
    assert.equal(current, declared); assert.equal(writes, 0)
    await fiber.dispose()
    assert.equal(current, declared); assert.equal(writes, 0)
    assert.equal(fs.readFileSync(legacy, 'utf8'), 'legacy unchanged')
  } finally { await shutdown(ctx) }
})
await test('release plans and the install lock carry the Windows Bash payload and never PowerShell', () => {
  const packages = describePackages('win32', 'x64', TEST_HOME)
  assert.deepEqual(packages.map(pkg => pkg.kind), ['bash'])
  assert.deepEqual(injectedOptionalDependencies({ packages }), { '@dsh-ops/bash-win32-x64': '0.2.1' })
  for (const name of ['package.json', 'package-lock.json']) {
    const contents = fs.readFileSync(path.join(PACKAGE_ROOT, name), 'utf8')
    assert.match(contents, /@dsh-ops\/bash-win32-x64/)
    assert.doesNotMatch(contents, /@dsh-ops\/pwsh-win32-x64/)
  }
})
await test('a payload release records the package at its declared pin, not the main version', async () => {
  await withTempDir('release-payload', async dist => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    const version = manifest.optionalDependencies['@dsh-ops/bash-win32-x64']
    assert.notEqual(version, manifest.version, 'the payload pin is intentionally independent of the main version')
    const bytes = Buffer.from('fixture bash entry bytes')
    const pin = { upstream: 'fixture', releaseTag: 'v1', assetName: 'fixture.7z', assetBytes: bytes.length,
      assetUrl: 'https://example.invalid/fixture.7z', assetSha256: 'a'.repeat(64),
      entryPoint: 'bin/bash.exe', entrySha256: hash(bytes), entryBytes: bytes.length,
      unpackedFiles: 1, unpackedBytes: bytes.length, unpackedBytesSumOfFileSizes: bytes.length,
      license: 'GPL-2.0-only', copyright: 'fixture', pinSource: 'fixture' }
    const pkg = { kind: 'bash', name: '@dsh-ops/bash-win32-x64', version, platform: 'win32', arch: 'x64',
      dist, executable: 'bin/bash.exe', payload: { type: 'archive', pin } }
    const stage = path.join(dist, 'stage', 'bash-win32-x64')
    fs.mkdirSync(path.join(stage, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(stage, 'bin', 'bash.exe'), bytes)
    const provenance = { version, upstream: { asset: { sha256: pin.assetSha256 } }, payloadSha256: hash(bytes), license: pin.license }
    fs.writeFileSync(path.join(stage, 'provenance.json'), JSON.stringify(provenance))
    const tarball = `dsh-ops-bash-win32-x64-${version}.tgz`, tarballBytes = Buffer.from('payload tarball fixture')
    fs.writeFileSync(path.join(dist, tarball), tarballBytes)
    const context = { dist, packages: [pkg], tarballs: { bash: { tarball, sha256: hash(tarballBytes), bytes: tarballBytes.length, files: 2, unpackedBytes: bytes.length } } }
    const publishDir = path.join(dist, 'publish', `${manifest.name}-${manifest.version}`)
    fs.mkdirSync(publishDir, { recursive: true })
    fs.writeFileSync(path.join(publishDir, 'package.json'), JSON.stringify({ ...manifest, optionalDependencies: injectedOptionalDependencies(context) }))
    mainArchive(path.join(dist, `${manifest.name}-${manifest.version}.tgz`))
    await writeReleaseRecords(context, [{ pkg, provenance }])
    assert.equal(await stepCheck(context), 0, 'a payload pinned at its own version must pass the release gate')
    fs.writeFileSync(path.join(stage, 'provenance.json'), JSON.stringify({ ...provenance, version: manifest.version }))
    assert.ok(await stepCheck(context) > 0, 'reporting the main version for the payload must fail')
  })
})
await test('main-only release records validate without shell payloads and reject stale shell archives', async () => {
  await withTempDir('release-main-only', async dist => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    const directory = path.join(dist, 'publish', manifest.name + '-' + manifest.version)
    fs.mkdirSync(directory, { recursive: true })
    delete manifest.private
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest))
    const tarball = manifest.name + '-' + manifest.version + '.tgz'
    mainArchive(path.join(dist, tarball))
    // A main-only record: the payload package itself is covered by the assemble/closure suites.
    const context = { dist, packages: [], tarballs: {} }
    await writeReleaseRecords(context, [])
    const record = JSON.parse(fs.readFileSync(path.join(dist, 'provenance.json'), 'utf8'))
    assert.deepEqual(record.packages, []); assert.deepEqual(record.tarballs, [tarball])
    assert.equal(await stepCheck(context), 0)
    fs.writeFileSync(path.join(dist, 'old-pwsh.tgz'), 'stale shell archive')
    await writeReleaseRecords(context, [])
    assert.ok(await stepCheck(context) > 0, 'obsolete shell artifacts must not pass a new release')
  })
})
report('pwsh-upgrade')
