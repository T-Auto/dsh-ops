/**
 * The two shell rungs: resolution order, environment invariants, the published
 * `ops_bash` tool, and the L3 patch override in `cordis.patch.yml`.
 *
 * Everything here is a fake by construction — temp directories, a synthetic
 * PATH, a fake tool registry, and a fake subprocess service that records the
 * spec it was handed — because the point is the contract, not this machine's
 * shells: a suite that asserted "Git for Windows is installed here" would be
 * testing the developer's laptop. The one real parser involved is the bundle
 * patch itself, which no other suite reads through the plugin's own eyes.
 *
 * The environment invariants from PLAN §2.7 are asserted as behavior, not as
 * prose: `resolveShells` must never mutate `process.env`, must never change the
 * working directory, and must never throw — the plugin may lose a rung, but it
 * must never fail to activate because of one.
 */

import * as urlHelpers from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { mountBundledPwsh } from '../lib/session-pwsh.js'
import { sessionWorkdir } from '../lib/session-shells.js'
import { parseDocument } from 'yaml'
import { resolveConfig } from '../lib/config.js'
import {
  BASH_ARGUMENTS,
  BASH_TOOL_NAME,
  DEFAULT_BASH_TIMEOUT_MS,
  ENV_OVERRIDES,
  shellEnvOverrides,
  MAX_BASH_TIMEOUT_MS,
  PLATFORM_PACKAGES,
  PWSH_LAYOUT_ORDER,
  SHELL_UPSTREAM_PINS,
  bashToolDefinition,
  bashToolDescription,
  bundledShell,
  bundledShellPath,
  provisionedShell,
  provisionedShellVersionDir,
  publishShellTools,
  resolveShells,
  shellExecutable,
  shellUpstreamPin,
  withBashStatus,
} from '../lib/shells.js'
import { assert, PACKAGE_ROOT, TEST_HOME, report, test, withTempDir } from './lib/harness.mjs'

/**
 * Make one executable file.
 * @param {string} file - absolute path.
 * @returns {string} the same path.
 */
function makeExecutable(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'stub')
  return file
}

/**
 * Stage one provisioned copy, exactly as `dsh-ops provision-shells` lays it out.
 * @param {string} home - the DSH home whose store to write into.
 * @param {'bash'|'pwsh'} kind - which shell.
 * @param {string} version - the version directory.
 * @returns {string} the executable path.
 */
function stageProvisioned(home, kind, version) {
  const pin = shellUpstreamPin({ kind, platform: process.platform, arch: process.arch })
  // The same rule the resolver applies, so the fixture cannot disagree with the
  // store it is pretending to be: the pin's own layout, or `bin/<name on this
  // platform>` when this platform has no pin at all.
  const relative = pin?.executableRelativePath ?? path.join('bin', shellExecutable(kind, process.platform))
  return makeExecutable(path.join(provisionedShellVersionDir({ kind, version, env: { DSH_HOME: home } }), relative))
}

/**
 * The published platform package name for one rung on this platform.
 * @param {'bash'|'pwsh'} kind - which rung.
 * @returns {string} the package name.
 */
/**
 * The platform package one rung is carried by.
 *
 * `platform`/`arch` are parameters rather than `process.platform`: the suite runs on both hosts, and
 * the cases that describe the **Windows** pinned payload (its package layout, the missing-package
 * advice, the `allowSystemShellFallback` gate) must exercise that payload wherever the suite runs.
 * A case that means "this host" passes the host's values explicitly.
 * @param {'bash'|'pwsh'} kind - which rung.
 * @param {string} [platform] - the target platform.
 * @param {string} [arch] - the target architecture.
 * @returns {string} the package name.
 */
function platformPackageName(kind, platform = process.platform, arch = process.arch) {
  return `@dsh-ops/${kind}-${platform}-${arch}`
}

/**
 * A configuration with every key the plugin documents, overridden per case.
 * @param {Record<string, unknown>} [overrides] - the keys to set.
 * @returns {import('../lib/config.js').ResolvedConfig} the resolved config.
 */
function config(overrides = {}) {
  return resolveConfig(overrides)
}

/**
 * A PATH-shaped string holding one directory.
 * @param {string} dir - the directory.
 * @returns {string} the PATH value.
 */
function onlyPath(dir) {
  return dir
}

// ---------------------------------------------------------------------------
// 1. Resolution order
// ---------------------------------------------------------------------------

await test('a configured bashPath wins and is authoritative', async () => {
  await withTempDir('shells-config', async (dir) => {
    const bash = makeExecutable(path.join(dir, 'my-bash'))
    const env = { PATH: onlyPath(makeExecutable(path.join(dir, 'onpath', 'bash'))) }
    const resolved = resolveShells(config({ bashPath: bash }), {
      bundleRoot: dir,
      env,
      platform: process.platform,
      arch: process.arch,
    })
    assert.deepEqual(resolved.bash, {
      available: true, file: bash, source: 'config', detail: 'configured bash executable',
    })
  })
})

await test('an unusable configured path reports available:false instead of falling through', async () => {
  await withTempDir('shells-config-bad', async (dir) => {
    const onPath = makeExecutable(path.join(dir, 'bin', 'bash.exe'))
    const broken = path.join(dir, 'missing', 'bash.exe')
    const resolved = resolveShells(config({ bashPath: broken }), {
      bundleRoot: dir,
      env: { DSH_HOME: TEST_HOME, PATH: onlyPath(path.dirname(onPath)) },
      platform: process.platform,
      arch: process.arch,
    })
    assert.equal(resolved.bash.available, false)
    assert.equal(resolved.bash.source, 'config')
    assert.match(resolved.bash.detail, /does not exist/)
    assert.equal(resolved.bash.file, undefined)
  })
})

await test('the bundled copy outranks PATH and the well-known install locations', async () => {
  await withTempDir('shells-bundled', async (dir) => {
    const bundledBash = makeExecutable(bundledShellPath({
      kind: 'bash', bundleRoot: dir, platform: process.platform, arch: process.arch,
    }))
    const bundledPwsh = makeExecutable(bundledShellPath({
      kind: 'pwsh', bundleRoot: dir, platform: process.platform, arch: process.arch,
    }))
    const onPathDir = path.join(dir, 'onpath')
    makeExecutable(path.join(onPathDir, process.platform === 'win32' ? 'bash.exe' : 'bash'))
    makeExecutable(path.join(onPathDir, process.platform === 'win32' ? 'pwsh.exe' : 'pwsh'))

    const resolved = resolveShells(config(), {
      bundleRoot: dir,
      env: { DSH_HOME: TEST_HOME, PATH: onlyPath(onPathDir) },
      platform: process.platform,
      arch: process.arch,
    })
    assert.equal(resolved.bash.source, 'bundled')
    assert.equal(resolved.bash.file, bundledBash)
    assert.equal(resolved.pwsh.source, 'bundled')
    assert.equal(resolved.pwsh.file, bundledPwsh)
  })
})

await test('with no bundled copy, PATH is searched before the well-known locations', async () => {
  await withTempDir('shells-path', async (dir) => {
    const onPathDir = path.join(dir, 'onpath')
    const onPathBash = makeExecutable(path.join(onPathDir, process.platform === 'win32' ? 'bash.exe' : 'bash'))
    // A system pwsh on PATH must NOT make L3 live: the rung means the plugin's
    // own PowerShell 7, which is what the host's row is pointed at.
    makeExecutable(path.join(onPathDir, process.platform === 'win32' ? 'pwsh.exe' : 'pwsh'))

    const resolved = resolveShells(config({ allowSystemShellFallback: true }), {
      bundleRoot: dir,
      env: { DSH_HOME: TEST_HOME, PATH: onlyPath(onPathDir) },
      platform: process.platform,
      arch: process.arch,
    })
    assert.equal(resolved.bash.source, 'path')
    assert.equal(resolved.bash.file, onPathBash)
    assert.equal(resolved.pwsh.available, false)
    assert.equal(resolved.pwsh.source, 'missing')
  })
})

await test('a Windows deployment finds the well-known Git for Windows install for bash', async () => {
  await withTempDir('shells-wellknown', async (dir) => {
    const programFiles = path.join(dir, 'Program Files')
    const gitBash = makeExecutable(path.join(programFiles, 'Git', 'bin', 'bash.exe'))
    // A system PowerShell 7 install is not the plugin's own pwsh either.
    makeExecutable(path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'))

    const resolved = resolveShells(config({ allowSystemShellFallback: true }), {
      bundleRoot: path.join(dir, 'plugin'),
      env: { DSH_HOME: TEST_HOME, PATH: '', ProgramFiles: programFiles },
      platform: 'win32',
      arch: 'x64',
    })
    assert.equal(resolved.bash.available, true)
    assert.equal(resolved.bash.source, 'well-known')
    assert.equal(resolved.bash.file, gitBash)
    assert.equal(resolved.pwsh.available, false)
    assert.equal(resolved.pwsh.source, 'missing')
  })
})

await test('the System32 WSL launcher is skipped even when it is first on PATH', async () => {
  await withTempDir('shells-wsl', async (dir) => {
    const systemRoot = path.join(dir, 'Windows')
    const launcher = makeExecutable(path.join(systemRoot, 'System32', 'bash.exe'))
    const gitBash = makeExecutable(path.join(dir, 'Program Files', 'Git', 'bin', 'bash.exe'))
    const resolved = resolveShells(config({ allowSystemShellFallback: true }), {
      bundleRoot: path.join(dir, 'plugin'),
      // Use the Windows separator because this resolves a Windows target even
      // when the suite is run on another platform.
      env: {
        DSH_HOME: TEST_HOME,
        PATH: path.dirname(launcher),
        SystemRoot: systemRoot,
        ProgramFiles: path.join(dir, 'Program Files'),
      },
      platform: 'win32',
      arch: 'x64',
    })
    assert.notEqual(resolved.bash.file, launcher)
    assert.equal(resolved.bash.file, gitBash)
    assert.equal(resolved.bash.source, 'well-known')
  })
})

await test('a bundled shell is not a system shell, so it survives allowSystemShellFallback:false', async () => {
  await withTempDir('shells-nofallback', async (dir) => {
    // The Windows payload: there the bundled copy is what `allowSystemShellFallback` guards.
    const bundled = makeExecutable(bundledShellPath({
      kind: 'bash', bundleRoot: dir, platform: 'win32', arch: 'x64',
    }))
    const withBundle = resolveShells(config({ allowSystemShellFallback: false }), {
      bundleRoot: dir,
      env: { DSH_HOME: TEST_HOME, PATH: onlyPath(makeExecutable(path.join(dir, 'onpath', 'bash'))) },
      platform: 'win32',
      arch: 'x64',
    })
    assert.equal(withBundle.bash.available, true)
    assert.equal(withBundle.bash.source, 'bundled')
    assert.equal(withBundle.bash.file, bundled)

    const withoutBundle = resolveShells(config({ allowSystemShellFallback: false }), {
      bundleRoot: path.join(dir, 'no-plugin'),
      env: { DSH_HOME: TEST_HOME, PATH: onlyPath(path.dirname(bundled)) },
      platform: 'win32',
      arch: 'x64',
    })
    assert.equal(withoutBundle.bash.available, false)
    assert.equal(withoutBundle.bash.source, 'disabled')
  })
})

await test('publishBashTool:false disables only the bash rung', async () => {
  await withTempDir('shells-publish-off', async (dir) => {
    makeExecutable(bundledShellPath({
      kind: 'pwsh', bundleRoot: dir, platform: process.platform, arch: process.arch,
    }))
    const resolved = resolveShells(config({ publishBashTool: false }), {
      bundleRoot: dir,
      env: { DSH_HOME: TEST_HOME, PATH: onlyPath(makeExecutable(path.join(dir, 'onpath', 'bash'))) },
      platform: process.platform,
      arch: process.arch,
    })
    assert.equal(resolved.bash.available, false)
    assert.equal(resolved.bash.source, 'disabled')
    // The pwsh rung is a separate fact and stays live.
    assert.equal(resolved.pwsh.available, true)
    assert.equal(resolved.pwsh.source, 'bundled')
  })
})

await test('bundledShellPath names the platform package layout phase C will ship', () => {
  const file = bundledShellPath({
    kind: 'pwsh', bundleRoot: 'C:\\plugin', platform: 'win32', arch: 'x64',
  })
  assert.equal(file, path.join('C:\\plugin', 'vendor', 'pwsh', 'win32-x64', 'pwsh.exe'))
})

// --- the published platform packages (phase C), exercised without installing one

/**
 * Stage a bundle root whose manifest declares an optional platform package.
 * @param {string} root - the temporary plugin root.
 * @param {'bash'|'pwsh'} kind - which rung.
 * @param {{install: boolean, binary: boolean}} shape - how the package is present.
 * @returns {string} the plugin root.
 */
function stagePlatformPackage(root, kind, { install, binary, platform = process.platform, arch = process.arch }) {
  const name = platformPackageName(kind, platform, arch)
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'dsh-ops',
    version: '0.1.0',
    optionalDependencies: { [name]: '0.1.0' },
  }))
  if (!install) return root
  const packageDir = path.join(root, 'node_modules', ...name.split('/'))
  fs.mkdirSync(packageDir, { recursive: true })
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    name, version: '0.1.0',
  }))
  if (binary) {
    makeExecutable(path.join(packageDir, 'bin', shellExecutable(kind, process.platform)))
  }
  return root
}

await test('an installed platform package resolves to its bin/<exe>', async () => {
  await withTempDir('shells-package', async (dir) => {
    stagePlatformPackage(dir, 'bash', { install: true, binary: true })
    const found = bundledShell({ kind: 'bash', bundleRoot: dir, platform: process.platform, arch: process.arch })
    assert.equal(
      found.file,
      path.join(dir, 'node_modules', ...platformPackageName('bash').split('/'), 'bin', shellExecutable('bash', process.platform)),
    )
    assert.equal(found.detail, undefined)
  })
})

await test('"installed without its executable" is reported apart from "not installed"', async () => {
  await withTempDir('shells-package-partial', async (dir) => {
    stagePlatformPackage(dir, 'bash', { install: true, binary: false })
    const withoutBinary = bundledShell({
      kind: 'bash', bundleRoot: dir, platform: process.platform, arch: process.arch,
    })
    assert.equal(withoutBinary.file, undefined)
    assert.match(withoutBinary.detail, new RegExp(`is installed without bin/${shellExecutable('bash', process.platform)}`))
  })

  // A separate root: node resolution walks UP from the bundle, so a sibling of
  // an installed package would find that package and hide this branch.
  await withTempDir('shells-package-absent', async (dir) => {
    stagePlatformPackage(dir, 'bash', { install: false, binary: false })
    const notInstalled = bundledShell({
      kind: 'bash', bundleRoot: dir, platform: process.platform, arch: process.arch,
    })
    assert.equal(notInstalled.file, undefined)
    assert.match(notInstalled.detail, /is declared but not installed/)
  })
})

await test('a plugin with no manifest reports the package as not installed, and undecorated rungs too', async () => {
  await withTempDir('shells-package-none', async (dir) => {
    const bare = bundledShell({ kind: 'pwsh', bundleRoot: dir, platform: process.platform, arch: process.arch })
    assert.equal(bare.file, undefined)
    assert.match(bare.detail, /is not installed \(no readable plugin manifest\)/)

    const undeclared = path.join(dir, 'undeclared')
    fs.mkdirSync(undeclared, { recursive: true })
    fs.writeFileSync(path.join(undeclared, 'package.json'), JSON.stringify({ name: 'dsh-ops', version: '0.1.0' }))
    const other = bundledShell({ kind: 'pwsh', bundleRoot: undeclared, platform: process.platform, arch: process.arch })
    assert.equal(other.file, undefined)
    assert.match(other.detail, /is not installed$/)
  })
})

await test('the package-missing reason reaches the rung it belongs to', async () => {
  await withTempDir('shells-package-detail', async (dir) => {
    const root = stagePlatformPackage(path.join(dir, 'plugin'), 'bash', { install: true, binary: false, platform: 'win32', arch: 'x64' })
    const resolved = resolveShells(config({ allowSystemShellFallback: false }), {
      bundleRoot: root,
      env: { DSH_HOME: TEST_HOME, PATH: '' },
      platform: 'win32',
      arch: 'x64',
    })
    assert.equal(resolved.bash.available, false)
    assert.equal(resolved.bash.source, 'disabled')
    assert.ok(resolved.bash.detail.includes(`is installed without bin/${shellExecutable('bash', process.platform)}`))
  })
})

await test('a package the registry never carried and a broken tree get different advice', async () => {
  // AC-1 / AC-2. Both shapes end in `available: false`, and one sentence used
  // to serve both — but only one of them is repaired by reinstalling the
  // profile's dependencies. A package the registry never carried (the mirror
  // shape) cannot be conjured by any local repair, so that line points at the
  // registry-free provisioner instead and does not use the word at all.
  /**
   * Resolve the bash rung against one staged platform-package shape.
   * @param {string} dir - the temporary root.
   * @param {{install: boolean, binary: boolean}} shape - how the package is present.
   * @returns {string} the rung's detail.
   */
  const detailFor = (dir, shape) => resolveShells(config({ allowSystemShellFallback: false }), {
    bundleRoot: stagePlatformPackage(path.join(dir, 'plugin'), 'bash', { ...shape, platform: 'win32', arch: 'x64' }),
    env: { DSH_HOME: TEST_HOME, PATH: '' },
    platform: 'win32',
    arch: 'x64',
  }).bash.detail

  let missing
  await withTempDir('shells-cause-missing', async (dir) => {
    missing = detailFor(dir, { install: false, binary: false })
    assert.ok(missing.includes('is declared but not installed'), missing)
    assert.ok(missing.includes('may not carry that platform package'), missing)
    assert.ok(missing.includes('provision-shells --bash'), missing)
    assert.equal(/\brepair(s|ing)?\b/u.test(missing), false, missing)
  })

  let corrupt
  await withTempDir('shells-cause-corrupt', async (dir) => {
    corrupt = detailFor(dir, { install: true, binary: false })
    assert.ok(corrupt.includes(`is installed without bin/${shellExecutable('bash', process.platform)}`), corrupt)
    assert.match(corrupt, /repairs that/u)
    assert.ok(corrupt.includes('provision-shells --bash'), corrupt)
  })

  assert.notEqual(missing, corrupt)
})

await test('bundledShell names the machine-readable cause of every miss', async () => {
  // D1: the advice above is chosen by `cause`, never by matching words inside
  // the detail, so each way of missing has to name itself. These four values
  // are the whole domain; anything a future version adds lands on the default
  // remedy until it is mapped, and this check is where that shows up.
  /**
   * Resolve the plugin's own bash out of one staged root.
   * @param {string} bundleRoot - the plugin root.
   * @returns {{file: string|undefined, detail: string|undefined, cause: string|undefined}} the probe.
   */
  const causeOf = (bundleRoot) => bundledShell({
    kind: 'bash', bundleRoot, platform: process.platform, arch: process.arch,
  })

  await withTempDir('shells-cause-manifest', async (dir) => {
    const bare = path.join(dir, 'bare')
    fs.mkdirSync(bare, { recursive: true })
    assert.equal(causeOf(bare).cause, 'no-manifest')
  })

  await withTempDir('shells-cause-undeclared', async (dir) => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-ops', version: '0.1.0' }))
    assert.equal(causeOf(dir).cause, 'not-declared')
  })

  await withTempDir('shells-cause-absent', async (dir) => {
    assert.equal(causeOf(stagePlatformPackage(dir, 'bash', { install: false, binary: false })).cause, 'not-installed')
  })

  await withTempDir('shells-cause-partial', async (dir) => {
    assert.equal(causeOf(stagePlatformPackage(dir, 'bash', { install: true, binary: false })).cause, 'incomplete-tree')
  })

  await withTempDir('shells-cause-found', async (dir) => {
    const found = causeOf(stagePlatformPackage(dir, 'bash', { install: true, binary: true }))
    assert.equal(found.file !== undefined, true)
    assert.equal(found.cause, undefined, 'a cause only explains a miss')
  })
})

// --- the upstream pins (phase C: pointers, not distributed binaries)

await test('the pin table names one upstream release per shell, and nothing is spelled twice', () => {
  // One pin per (shell, target). Pinning a target has to be possible without
  // the count being the contract: what must never happen is two entries
  // answering the same lookup, which would make `shellUpstreamPin` order decide
  // which bytes get downloaded.
  const keys = SHELL_UPSTREAM_PINS.map((pin) => `${pin.name}/${pin.platform}-${pin.arch}`)
  assert.deepEqual(keys, [...new Set(keys)], 'a shell and target is pinned at most once')
  assert.equal(new Set(SHELL_UPSTREAM_PINS.map((pin) => pin.name)).size, 2, 'both shells are pinned')
  for (const pin of SHELL_UPSTREAM_PINS) {
    assert.equal(Object.isFrozen(pin), true, `${pin.name}: a pin is a frozen fact`)
    assert.equal(pin.name === 'bash' || pin.name === 'pwsh', true, `unexpected shell ${pin.name}`)
    assert.equal(pin.url, `${pin.upstreamRepo}/releases/download/${pin.releaseTag}/${pin.assetFile}`,
      `${pin.name}: the URL is the pinned release's own asset`)
    assert.match(pin.sha256, /^[0-9a-f]{64}$/u, `${pin.name}: the archive digest is a SHA-256`)
    assert.match(pin.executableSha256, /^[0-9a-f]{64}$/u, `${pin.name}: the executable digest is a SHA-256`)
    assert.equal(Number.isSafeInteger(pin.bytes) && pin.bytes > 0, true, `${pin.name}: bytes is a size`)
    assert.equal(typeof pin.license, 'string')
    assert.equal(typeof pin.releaseTag, 'string')
    // The two layouts the store and the provisioner share: the executable the
    // resolver looks for is the one the unpack step puts there — and the name it
    // looks for is the one this platform's shells actually carry.
    assert.equal(path.basename(pin.executableRelativePath), shellExecutable(pin.name, pin.platform),
      `${pin.name}: the pin's executable is the one this module resolves on ${pin.platform}`)
    assert.equal(['zip', 'sfx-7z', 'tar.gz'].includes(pin.extractor), true, `${pin.name}: a known extractor`)
    // The provisioner's own invariant: `<extractTo>/<file name>` is inside the
    // version directory, and it is where `executableRelativePath` was written
    // for the shapes this distribution pins.
    assert.equal(pin.extractTo === '.' || !path.isAbsolute(pin.extractTo), true)
  }

  const pwsh = shellUpstreamPin({ kind: 'pwsh', platform: 'win32', arch: 'x64' })
  assert.equal(pwsh?.extractTo, 'bin')
  assert.equal(pwsh?.executableRelativePath, 'bin/pwsh.exe')
  const bash = shellUpstreamPin({ kind: 'bash', platform: 'win32', arch: 'x64' })
  assert.equal(bash?.extractTo, '.')
  assert.equal(bash?.executableRelativePath, 'bin/bash.exe')
  // The macOS pwsh pin: a gzipped tar whose root is the payload, unpacked into
  // `bin/`, so the provisioner's `tar.gz` branch and the store path agree.
  const pwshArm64 = shellUpstreamPin({ kind: 'pwsh', platform: 'darwin', arch: 'arm64' })
  assert.equal(pwshArm64?.extractor, 'tar.gz')
  assert.equal(pwshArm64?.extractTo, 'bin')
  assert.equal(pwshArm64?.executableRelativePath, 'bin/pwsh')
  // The one published layout each archive has, and the store path both sides of
  // the L3 contract compute.
  const shellHome = process.platform === 'win32' ? 'C:\\home' : '/home/dsh-ops'
  assert.equal(provisionedShellVersionDir({ kind: 'pwsh', version: '7.6.6', env: { DSH_HOME: shellHome } }),
    path.join(shellHome, 'dsh-ops', 'shells', 'pwsh', '7.6.6'))
})

await test('a platform the pins do not cover has no pin, and the store still resolves layout-only', () => {
  assert.equal(shellUpstreamPin({ kind: 'pwsh', platform: 'linux', arch: 'x64' }), undefined)
  assert.equal(shellUpstreamPin({ kind: 'bash', platform: 'darwin', arch: 'arm64' }), undefined)
})

// --- the provisioned copies (`dsh-ops provision-shells`)

await test('a provisioned copy outranks the bundled layouts and PATH, for both shells', async () => {
  await withTempDir('shells-provisioned', async (dir) => {
    const home = path.join(dir, 'home')
    const provisionedBash = stageProvisioned(home, 'bash', '2.56.0.2')
    const provisionedPwsh = stageProvisioned(home, 'pwsh', '7.6.6')
    // Everything the provisioned copy has to beat: the bundled platform package
    // (declared and installed, so it really is a candidate), the vendored
    // layout, and a bash on PATH. The whole package is staged, manifest
    // included, because node only resolves a package that has one.
    const bundleRoot = stagePlatformPackage(path.join(dir, 'plugin'), 'bash', { install: true, binary: true })
    const packaged = path.join(
      bundleRoot, 'node_modules', ...platformPackageName('bash').split('/'), 'bin', shellExecutable('bash', process.platform),
    )
    const onPath = makeExecutable(path.join(dir, 'onpath', shellExecutable('bash', process.platform)))
    const bundledPwsh = makeExecutable(bundledShellPath({
      kind: 'pwsh', bundleRoot, platform: process.platform, arch: process.arch,
    }))

    const resolved = resolveShells(config(), {
      bundleRoot,
      env: { DSH_HOME: home, PATH: path.dirname(onPath) },
      platform: process.platform,
      arch: process.arch,
    })
    assert.equal(resolved.bash.available, true, resolved.bash.detail)
    assert.equal(resolved.bash.source, 'provisioned', resolved.bash.detail)
    assert.equal(resolved.bash.file, provisionedBash)
    assert.notEqual(resolved.bash.file, packaged, 'the provisioned copy beats the platform package')
    assert.notEqual(resolved.bash.file, onPath, 'the provisioned copy beats PATH')
    assert.match(resolved.bash.detail, /version 2\.56\.0\.2/u)
    assert.equal(resolved.pwsh.available, true, resolved.pwsh.detail)
    assert.equal(resolved.pwsh.source, 'provisioned', resolved.pwsh.detail)
    assert.equal(resolved.pwsh.file, provisionedPwsh)
    assert.notEqual(resolved.pwsh.file, bundledPwsh, 'the provisioned copy beats the vendored layout')

    // The package it beat is a live candidate, not an absent one: with the
    // store gone, the bundled platform package is the rung that answers, and
    // the PATH copy is the one behind it.
    const withoutStore = resolveShells(config({ allowSystemShellFallback: true }), {
      bundleRoot,
      env: { DSH_HOME: path.join(dir, 'empty-home'), PATH: path.dirname(onPath) },
      platform: process.platform,
      arch: process.arch,
    })
    assert.equal(withoutStore.bash.source, 'bundled', withoutStore.bash.detail)
    assert.equal(withoutStore.bash.file, packaged)

    // Confining the ladder to plugin-provided shells leaves the provisioned
    // copy alone: it is not a system shell, it is ours.
    const confined = resolveShells(config({ allowSystemShellFallback: false }), {
      bundleRoot,
      env: { DSH_HOME: home, PATH: path.dirname(onPath) },
      platform: process.platform,
      arch: process.arch,
    })
    assert.equal(confined.bash.source, 'provisioned', confined.bash.detail)
    assert.equal(confined.bash.file, provisionedBash)
    assert.equal(confined.pwsh.file, provisionedPwsh)
  })
})

await test('a configured path still wins over the provisioned copy', async () => {
  await withTempDir('shells-provisioned-config', async (dir) => {
    const home = path.join(dir, 'home')
    stageProvisioned(home, 'bash', '2.56.0.2')
    const configured = makeExecutable(path.join(dir, 'my-bash'))
    const resolved = resolveShells(config({ bashPath: configured }), {
      bundleRoot: path.join(dir, 'plugin'),
      env: { DSH_HOME: home, PATH: '' },
      platform: process.platform,
      arch: process.arch,
    })
    assert.equal(resolved.bash.source, 'config')
    assert.equal(resolved.bash.file, configured)
  })
})

await test('the store takes the greatest version name, and skips a version without the executable', async () => {
  await withTempDir('shells-provisioned-versions', async (dir) => {
    const home = path.join(dir, 'home')
    const store = path.join(home, 'dsh-ops', 'shells', 'bash')
    const newest = stageProvisioned(home, 'bash', '2.56.0.2')
    const older = stageProvisioned(home, 'bash', '2.40.1')
    // A directory that sorts above both but holds no executable is not a
    // candidate at all, so the greatest *usable* version wins.
    fs.mkdirSync(path.join(store, '9.9.9'), { recursive: true })
    fs.writeFileSync(path.join(store, '9.9.9', 'README.txt'), 'nothing to run here\n')

    const found = provisionedShell({ kind: 'bash', env: { DSH_HOME: home } })
    assert.equal(found?.file, newest)
    assert.equal(found?.version, '2.56.0.2')

    // With the executable gone from the greatest usable name, the next one answers.
    fs.rmSync(newest)
    const fallback = provisionedShell({ kind: 'bash', env: { DSH_HOME: home } })
    assert.equal(fallback?.file, older)
    assert.equal(fallback?.version, '2.40.1')
  })
})

await test('an absent store, an unreadable store, and a file where a directory belongs all resolve nothing', async () => {
  await withTempDir('shells-provisioned-empty', async (dir) => {
    const home = path.join(dir, 'home')
    fs.mkdirSync(home, { recursive: true })
    assert.equal(provisionedShell({ kind: 'pwsh', env: { DSH_HOME: home } }), undefined)

    // A file named like the shell's store directory must not throw out of a
    // load-time probe.
    fs.mkdirSync(path.join(home, 'dsh-ops', 'shells'), { recursive: true })
    fs.writeFileSync(path.join(home, 'dsh-ops', 'shells', 'pwsh'), 'not a directory\n')
    assert.equal(provisionedShell({ kind: 'pwsh', env: { DSH_HOME: home } }), undefined)
  })
})

// ---------------------------------------------------------------------------
// 2. Environment invariants
// ---------------------------------------------------------------------------

await test('resolveShells never throws, whatever it is handed', () => {
  const inputs = [
    undefined,
    null,
    {},
    { bashPath: '', publishBashTool: 'yes', allowSystemShellFallback: 'no' },
    { publishBashTool: false, allowSystemShellFallback: false },
    // Keys the plugin deliberately does not implement: still no throw.
    { pwshPath: 'C:\\pwsh.exe', overridePwshExecutor: true },
  ]
  for (const raw of inputs) {
    const resolved = resolveShells(raw)
    assert.equal(typeof resolved.bash.available, 'boolean')
    assert.equal(typeof resolved.pwsh.available, 'boolean')
    assert.equal(typeof resolved.bash.source, 'string')
    assert.equal(typeof resolved.pwsh.source, 'string')
  }
  // The option bag is a test seam, not a contract: a hostile one must not throw either. Resolution
  // follows the TARGET platform, so an unknown one takes the POSIX rung — what must hold is that a
  // definite answer comes back.
  const hostile = resolveShells(config(), { bundleRoot: '/nonexistent', env: { DSH_HOME: TEST_HOME }, platform: 'plan9', arch: 'x64' })
  assert.equal(typeof hostile.bash.available, 'boolean')
  assert.equal(typeof hostile.pwsh.available, 'boolean')
  // Windows is the platform where "no pinned payload" is the answer: nothing to fall back to, and
  // the flag that would allow it is off.
  const windows = resolveShells(config(), { bundleRoot: '/nonexistent', env: { DSH_HOME: TEST_HOME }, platform: 'win32', arch: 'x64' })
  assert.equal(windows.bash.available, false)
  assert.equal(windows.pwsh.available, false)
})

await test('resolveShells leaves process.env and the working directory untouched', () => {
  const before = { ...process.env }
  const cwd = process.cwd()
  for (let round = 0; round < 3; round += 1) {
    resolveShells(config({ bashPath: 'C:\\tools\\bash.exe', allowSystemShellFallback: false }))
    resolveShells(config({ bashPath: undefined, allowSystemShellFallback: true }))
    resolveShells(config({ publishBashTool: false }))
  }
  assert.deepEqual({ ...process.env }, before)
  assert.equal(process.cwd(), cwd)
})

// ---------------------------------------------------------------------------
// 3. Publishing the ops_bash tool
// ---------------------------------------------------------------------------

/**
 * A tool registry that records registrations the way the host's own does.
 * @param {object} [options] - the fakes to mount.
 * @param {object|undefined} [options.subprocess] - the subprocess service; an
 *   explicit `undefined` means this composition has none.
 * @returns {object} the fake context plus the inspection helpers.
 */
function fakeRegistry(options = {}) {
  // A present key wins even when its value is `undefined`: "this deployment has
  // no subprocess service" is one of the cases under test.
  const subprocess = Object.hasOwn(options, 'subprocess')
    ? options.subprocess
    : { spawn() { throw new Error('not expected in this check') } }
  const live = new Map()
  const registrations = []
  const ctx = {
    logger: { warn() {}, error() {}, info() {} },
    get(service) {
      if (service === 'tools') {
        return {
          register(definition) {
            registrations.push(definition)
            live.set(definition.name, definition)
            return () => live.delete(definition.name)
          },
        }
      }
      if (service === 'subprocess') return subprocess
      return undefined
    },
    subprocess,
  }
  return { ctx, live, registrations, subprocess }
}

await test('a missing bash publishes nothing and warns instead of failing', async () => {
  await withTempDir('shells-nobash', async (dir) => {
    const warnings = []
    const { ctx, live, registrations } = fakeRegistry()
    ctx.logger = { warn: (message) => warnings.push(message) }
    const publish = config({ allowSystemShellFallback: false })
    // The wording this case pins is the pinned-Windows-payload remedy (`provision-shells`), so the
    // platform is Windows; a POSIX host resolves its own bash and has no such rung.
    const shells = resolveShells(publish, {
      bundleRoot: path.join(dir, 'plugin'),
      env: { DSH_HOME: TEST_HOME, PATH: '' },
      platform: 'win32',
      arch: 'x64',
    })
    const dispose = publishShellTools(ctx, publish, shells)

    assert.equal(shells.bash.available, false)
    assert.equal(live.size, 0)
    assert.equal(registrations.length, 0)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /bash is unavailable/)
    // AC-7's assembly channel, pinned at the unit level: the logger receives
    // the same detail the ladder reports, and that detail carries the action.
    // This root has no manifest at all, so the wording comes from the default
    // branch of the cause mapping (D8) — never a bare statement of the problem.
    assert.ok(warnings[0].includes('provision-shells --bash'), warnings[0])
    assert.ok(
      warnings[0].includes('run `dsh-ops provision-shells --bash` to install the pinned upstream copy'),
      warnings[0],
    )
    assert.equal(typeof dispose, 'function')
    dispose()
    dispose()
    assert.equal(live.size, 0)
  })
})

await test('publishBashTool:false publishes nothing even when a bash was resolved', async () => {
  await withTempDir('shells-off', async (dir) => {
    const bash = makeExecutable(path.join(dir, 'bash'))
    const { ctx, registrations } = fakeRegistry()
    const publish = config({ bashPath: bash, publishBashTool: false })
    const shells = resolveShells(publish, { bundleRoot: dir, env: { DSH_HOME: TEST_HOME, PATH: '' }, platform: process.platform })
    publishShellTools(ctx, publish, shells)
    assert.equal(registrations.length, 0)
  })
})

await test('no subprocess service means no ops_bash, with a warning', async () => {
  await withTempDir('shells-nosubprocess', async (dir) => {
    // A resolved bash is not enough: without `ctx.subprocess` the tool could be
    // registered and then fail on every call, which would let the ladder
    // advertise rung two for a tool that cannot run.
    const bash = makeExecutable(path.join(dir, 'bash'))
    const warnings = []
    const { ctx, live, registrations } = fakeRegistry({ subprocess: undefined })
    ctx.logger = { warn: (message) => warnings.push(message) }
    const publish = config({ bashPath: bash })
    const shells = resolveShells(publish, { bundleRoot: dir, env: { DSH_HOME: TEST_HOME, PATH: '' }, platform: process.platform })
    assert.equal(shells.bash.available, true, 'the probe still resolves the bash')

    const dispose = publishShellTools(ctx, publish, shells)
    assert.equal(registrations.length, 0)
    assert.equal(live.size, 0)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /no subprocess service/)
    assert.match(warnings[0], /ops_bash is not published/)
    dispose()
  })
})

await test('an available bash registers ops_bash, and the disposer removes it', async () => {
  await withTempDir('shells-register', async (dir) => {
    const bash = makeExecutable(path.join(dir, 'bash'))
    const { service } = fakeSubprocess()
    const { ctx, live, registrations } = fakeRegistry({ subprocess: service })
    const publish = config({ bashPath: bash })
    const shells = resolveShells(publish, { bundleRoot: dir, env: { DSH_HOME: TEST_HOME, PATH: '' }, platform: process.platform })

    const dispose = publishShellTools(ctx, publish, shells)
    assert.equal(registrations.length, 1)
    assert.deepEqual([...live.keys()], [BASH_TOOL_NAME])
    assert.equal(registrations[0].name, BASH_TOOL_NAME)
    assert.ok(registrations[0].parameters.properties.script_path)
    assert.equal(typeof registrations[0].execute, 'function')
    assert.equal(typeof registrations[0].output.render, 'function')

    const text = registrations[0].output.render(
      { command: 'echo hi' },
      {
        exitCode: 0,
        timedOut: false,
        timeoutMs: DEFAULT_BASH_TIMEOUT_MS,
        stdout: { text: 'hi\n', truncated: false },
        stderr: { text: '', truncated: false },
      },
    )
    assert.equal(text[0].text, 'hi\n')

    dispose()
    assert.equal(live.size, 0)
  })
})

await test('the ops_bash definition passes the real registry\'s schema gate', async () => {
  // The fake registry used above does not validate anything, which is exactly
  // how a type-array schema (`['integer', 'null']`) once shipped and then made
  // the real registry refuse the registration with
  // "type arrays are not supported"
  // (packages/core/tools/src/json-schema.ts:302-307). This check runs the
  // harness's own validator, so the definition cannot drift back.
  const { assertSupportedJsonSchema } = await import('@deepseek-ai/dsh-tools')
  await withTempDir('shells-schema', async (dir) => {
    const bash = makeExecutable(path.join(dir, 'bash'))
    const { service } = fakeSubprocess()
    const definition = bashToolDefinition({ file: bash, source: 'config', subprocess: service })

    assert.equal(typeof assertSupportedJsonSchema, 'function')
    assert.doesNotThrow(() => assertSupportedJsonSchema(definition.output.schema))
  })
})

await test('no part of the ops_bash definition declares a type array', async () => {
  // An equivalent structural check that does not depend on the host package,
  // walking `output` AND `parameters`, so the same mistake cannot reappear in
  // the argument schema either.
  await withTempDir('shells-schema-walk', async (dir) => {
    const bash = makeExecutable(path.join(dir, 'bash'))
    const { service } = fakeSubprocess()
    const definition = bashToolDefinition({ file: bash, source: 'config', subprocess: service })

    /** @type {string[]} */
    const offenders = []
    /**
     * @param {unknown} node - the schema node to walk.
     * @param {string} where - its path, for the failure message.
     * @returns {void}
     */
    const walk = (node, where) => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) {
        node.forEach((entry, index) => walk(entry, `${where}[${index}]`))
        return
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === 'type' && Array.isArray(value)) offenders.push(`${where}.type`)
        else walk(value, `${where}.${key}`)
      }
    }
    walk(definition.output.schema, 'output.schema')
    walk(definition.parameters, 'parameters')
    assert.deepEqual(offenders, [])
  })
})

// ---------------------------------------------------------------------------
// 4. The command the tool actually runs
// ---------------------------------------------------------------------------
/**
 * A subprocess service that records one spawn spec and settles it on demand.
 * @returns {object} the fake service and its recorded state.
 */
function fakeSubprocess({ exitCode = 0, signal = null, stdout = '', stderr = '', lossy = false } = {}) {
  const specs = []
  let settle
  const done = new Promise((resolve) => { settle = resolve })
  const service = {
    spawn(spec) {
      specs.push(spec)
      return {
        collected: {
          stdout: { readFrom: (from) => ({ text: from === 0 ? stdout : '', nextOffset: stdout.length, lossy }) },
          stderr: { readFrom: (from) => ({ text: from === 0 ? stderr : '', nextOffset: stderr.length, lossy: false }) },
        },
        done,
      }
    },
  }
  return { service, specs, settle: () => settle({ exitCode, signal }) }
}

await test('ops_bash runs the resolved bash as `bash -c <command>` through ctx.subprocess', async () => {
  await withTempDir('shells-exec', async (dir) => {
    const bash = makeExecutable(path.join(dir, 'plugin-bash'))
    const { service, specs, settle } = fakeSubprocess({ exitCode: 3, stdout: 'out\n', stderr: 'err\n' })
    const publish = config({ bashPath: bash })
    const shells = resolveShells(publish, { bundleRoot: dir, env: { DSH_HOME: TEST_HOME, PATH: '' }, platform: process.platform })
    const definition = bashToolDefinition({ file: shells.bash.file, source: shells.bash.source, subprocess: service })

    const controller = new AbortController()
    const spec = { cwd: dir }
    const running = definition.execute(
      { command: 'echo $BASH_VERSION', workdir: spec.cwd, timeoutMs: 5_000, graceMs: 250 },
      { signal: controller.signal },
    )
    settle()
    const value = await running

    assert.equal(specs.length, 1)
    const [spawned] = specs
    assert.deepEqual(spawned.argv, [bash, '-c', 'echo $BASH_VERSION'])
    assert.equal(spawned.cwd, dir)
    assert.equal(spawned.graceMs, 250)
    assert.equal(spawned.signal.aborted, false)
    // The spawn env is the overrides as they must reach a child given THIS host environment: a
    // host that sets `LC_ALL` gets it neutralized (see the locale case below).
    assert.deepEqual(spawned.env, shellEnvOverrides(process.env))
    assert.equal(spawned.stdio.stdin, 'ignore')
    assert.equal(typeof spawned.stdio.stdout.maxBytes, 'number')
    assert.equal(typeof spawned.stdio.stderr.maxBytes, 'number')
    assert.equal(spawned.stdio.stdout.spill.maxBytes, spawned.stdio.stderr.spill.maxBytes)

    // A normal exit reports its code and OMITS `signal`: the canonical value
    // never carries a null, because the output schema declares single types.
    assert.deepEqual(value, {
      exitCode: 3,
      status: 'failed',
      timedOut: false,
      timeoutMs: 5_000,
      stdout: { text: 'out\n', truncated: false },
      stderr: { text: 'err\n', truncated: false },
    })
    assert.equal(Object.hasOwn(value, 'signal'), false)
    const rendered = definition.output.render({}, value)
    assert.equal(rendered[0].text, 'out\n[stderr]\nerr\n\n[exit code: 3]')
  })
})

await test('ops_bash reports a signal death with a signal and no exit code', async () => {
  await withTempDir('shells-signal', async (dir) => {
    const bash = makeExecutable(path.join(dir, 'bash'))
    const { service, settle } = fakeSubprocess({ exitCode: null, signal: 'SIGTERM', stdout: '', stderr: '' })
    const definition = bashToolDefinition({ file: bash, source: 'config', subprocess: service })
    const running = definition.execute({ command: 'sleep 99' }, { signal: new AbortController().signal })
    settle()
    const value = await running

    assert.deepEqual(value, {
      signal: 'SIGTERM',
      status: 'failed',
      timedOut: false,
      timeoutMs: DEFAULT_BASH_TIMEOUT_MS,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
    })
    assert.equal(Object.hasOwn(value, 'exitCode'), false)
    assert.equal(definition.output.render({}, value)[0].text, '(no output)\n[signal: SIGTERM]')
  })
})

await test('ops_bash results carry status: completed only for a clean zero exit (#44)', async () => {
  await withTempDir('shells-status', async (dir) => {
    const bash = makeExecutable(path.join(dir, 'bash'))
    const run = async (outcome, args = { command: 'true' }) => {
      const { service, settle } = fakeSubprocess(outcome)
      const running = bashToolDefinition({ file: bash, source: 'config', subprocess: service }).execute(args, { signal: new AbortController().signal })
      settle()
      return running
    }
    assert.equal((await run({ exitCode: 0, stdout: 'ok' })).status, 'completed')
    assert.equal((await run({ exitCode: 1 })).status, 'failed')
    assert.equal((await run({ exitCode: null, signal: 'SIGKILL' })).status, 'failed')
    const broken = { spawn() { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) } }
    const spawnError = await bashToolDefinition({ file: bash, source: 'config', subprocess: broken }).execute({ command: 'true' }, {})
    assert.equal(spawnError.status, 'failed')
    assert.match(spawnError.error, /ENOENT/)
    // Stamping after a wrapper adds error/permission always yields failed.
    assert.equal(withBashStatus({ exitCode: 0, timedOut: false, error: 'EXECUTOR_UNAVAILABLE' }).status, 'failed')
    assert.equal(withBashStatus({ exitCode: 0, timedOut: false, permission: {} }).status, 'failed')
    assert.equal(withBashStatus({ exitCode: 0, timedOut: true }).status, 'failed')
    // Argument errors still throw, so the host reports them as a failed tool call.
    await assert.rejects(() => run({ exitCode: 0 }, { command: 'true', bogus: 1 }), /unknown key "bogus"/)
  })
})

await test('ops_bash forwards the terminal overrides and no credential-shaped name of its own', async () => {
  await withTempDir('shells-env', async (dir) => {
    const bash = makeExecutable(path.join(dir, 'bash'))
    const { service, specs, settle } = fakeSubprocess()
    const definition = bashToolDefinition({ file: bash, source: 'config', subprocess: service })
    const running = definition.execute({ command: 'true' }, { signal: new AbortController().signal })
    settle()
    await running

    const env = specs[0].env
    assert.deepEqual(env, shellEnvOverrides(process.env))
    assert.equal(env.NO_COLOR, '1')
    assert.equal(env.TERM, 'dumb')
    assert.equal(env.PAGER, 'cat')
    assert.equal(env.GIT_PAGER, 'cat')
    // Message catalogs are pinned so the host's English `denialSignatures` still
    // match a localized libc; `LC_ALL=C` would break UTF-8 I/O instead.
    assert.equal(env.LC_MESSAGES, 'C')
    for (const name of Object.keys(env)) {
      assert.equal(/KEY|PASSWORD|SECRET|TOKEN/i.test(name), false, `${name} looks like a credential`)
      assert.equal(name.toUpperCase().startsWith('DSH_'), false, `${name} is a harness fact`)
    }
  })
})

await test('ops_bash executes a script_path without embedding its contents in argv', async () => {
  await withTempDir('shells-script-path', async (dir) => {
    const bash = makeExecutable(path.join(dir, 'bash'))
    const script = path.join(dir, 'long-script.sh')
    makeExecutable(script)
    const { service, specs, settle } = fakeSubprocess()
    const definition = bashToolDefinition({ file: bash, source: 'config', subprocess: service })
    const running = definition.execute({ script_path: script, workdir: dir }, { signal: new AbortController().signal })
    settle()
    await running

    assert.deepEqual(specs[0].argv, [bash, script])
    assert.equal(specs[0].cwd, dir)
    assert.equal(specs[0].stdio.stdin, 'ignore')
  })
})

await test('ops_bash rejects a missing or non-directory workdir before spawning', async () => {
  await withTempDir('shells-workdir', async (dir) => {
    const bash = makeExecutable(path.join(dir, 'bash'))
    const file = path.join(dir, 'a-file')
    fs.writeFileSync(file, 'placeholder')
    // The service records any spawn: a rejected workdir must never reach it,
    // or the failure would come back as the misleading missing-payload ENOENT.
    const { service, specs } = fakeSubprocess()
    const definition = bashToolDefinition({ file: bash, source: 'bundled', subprocess: service })
    const exec = { signal: new AbortController().signal }
    const missing = path.join(dir, 'definitely-missing')

    await assert.rejects(
      () => definition.execute({ command: 'echo hi', workdir: missing }, exec),
      { message: `invalid workdir: must be an existing directory, got ${missing}` })
    await assert.rejects(
      () => definition.execute({ command: 'echo hi', workdir: file }, exec),
      { message: `invalid workdir: must be an existing directory, got ${file}` })
    assert.equal(specs.length, 0)
  })
})

await test('ops_bash rejects an empty workdir string instead of spawning it', async () => {
  const { service, specs } = fakeSubprocess()
  const definition = bashToolDefinition({ file: 'bash', source: 'config', subprocess: service })
  const exec = { signal: new AbortController().signal }
  // Placeholder strings are the session layer's job (sessionWorkdir resolves
  // them to the session directory); a string that reaches the executor is a
  // chosen path, and "" names no directory.
  for (const workdir of ['', '   ']) {
    await assert.rejects(
      () => definition.execute({ command: 'echo hi', workdir }, exec),
      /invalid workdir: must be an existing directory/)
  }
  assert.equal(specs.length, 0)
})

await test('sessionWorkdir resolves placeholders to the session directory', async () => {
  const cwd = path.resolve('session', 'cwd')
  const session = { header: { cwd } }
  assert.equal(sessionWorkdir({}, session), cwd)
  assert.equal(sessionWorkdir({ workdir: undefined }, session), cwd)
  assert.equal(sessionWorkdir({ workdir: null }, session), cwd)
  assert.equal(sessionWorkdir({ workdir: '' }, session), cwd)
  assert.equal(sessionWorkdir({ workdir: '   ' }, session), cwd)
  const chosen = path.resolve('chosen')
  assert.equal(sessionWorkdir({ workdir: chosen }, session), chosen)
  // Meaningful spaces are filename bytes, and non-strings still reach validation.
  assert.equal(sessionWorkdir({ workdir: '  chosen  ' }, session), path.resolve(cwd, '  chosen  '))
  assert.equal(sessionWorkdir({ workdir: 5 }, session), 5)
})

await test('ops_bash turns a missing executable into the remedy its source deserves', async () => {
  const spawnError = Object.assign(new Error('spawn missing bash'), { code: 'ENOENT' })
  const service = { spawn() { throw spawnError } }
  /**
   * Run one ENOENT spawn through a tool bound to `source`.
   * @param {string} source - the rung the executable came from.
   * @returns {Promise<{value: object, definition: object}>} the settled result.
   */
  const runFor = async (source) => {
    const definition = bashToolDefinition({ file: 'C:\\missing\\bash.exe', source, subprocess: service })
    const value = await definition.execute({ command: 'echo hi' }, { signal: new AbortController().signal })
    return { value, definition }
  }
  const head = 'bash executable is unavailable (ENOENT): C:\\missing\\bash.exe. '

  // AC-3: each source is told what would actually restore that copy. The old
  // single line sent all of them to "repair the profile installation", which is
  // the wrong move for a configured path and for a system bash.
  const bundled = await runFor('bundled')
  assert.equal(bundled.value.error, `${head}The bundled bash left the profile after it was resolved; restore the profile's dependencies, or run \`dsh-ops provision-shells --bash\` to fetch the pinned copy from upstream releases instead.`)
  assert.equal(bundled.value.timedOut, false)
  assert.deepEqual(bundled.value.stdout, { text: '', truncated: false })
  assert.deepEqual(bundled.value.stderr, { text: '', truncated: false })
  assert.match(bundled.definition.output.render({}, bundled.value)[0].text, /The bundled bash left the profile after it was resolved/)

  const provisioned = await runFor('provisioned')
  assert.equal(provisioned.value.error, `${head}The provisioned copy under this DSH_HOME is gone; run \`dsh-ops provision-shells --bash\` again to reinstall the pinned upstream copy.`)

  const config = await runFor('config')
  assert.equal(config.value.error, `${head}The configured bashPath no longer exists; point bashPath at a real executable, or clear it and run \`dsh-ops provision-shells --bash\`.`)

  const errors = [bundled.value.error, provisioned.value.error, config.value.error]
  assert.equal(new Set(errors).size, 3, 'one wording per source')
  for (const error of errors) {
    assert.equal(/repair the profile installation/u.test(error), false, error)
  }

  // The two system sources share the one remedy that cannot be a registry
  // fetch, and a source this table has never seen still gets a usable line
  // rather than nothing (D8).
  const system = 'The system bash this deployment fell back to is gone; reinstall it, or run `dsh-ops provision-shells --bash` for a copy the registry cannot take away.'
  for (const source of ['path', 'well-known']) {
    assert.equal((await runFor(source)).value.error, `${head}${system}`, `${source}: the system bash remedy`)
  }
  assert.equal(
    (await runFor('a-source-added-later')).value.error,
    `${head}run \`dsh-ops provision-shells --bash\` to install the pinned upstream copy.`,
    'an unmapped source still gets the generic remedy',
  )
})

await test('ops_bash requires exactly one command input', async () => {
  await withTempDir('shells-inputs', async (dir) => {
    const bash = makeExecutable(path.join(dir, 'bash'))
    const { service, specs } = fakeSubprocess()
    const definition = bashToolDefinition({ file: bash, source: 'config', subprocess: service })
    const exec = { signal: new AbortController().signal }

    await assert.rejects(() => definition.execute({}, exec), /exactly one of command or script_path/)
    await assert.rejects(() => definition.execute({ command: 'echo ok', script_path: 'x.sh' }, exec), /exactly one of command or script_path/)
    await assert.rejects(() => definition.execute({ script_path: '   ' }, exec), /invalid script_path/)
    assert.equal(specs.length, 0)
  })
})

await test('ops_bash accepts empty optional input placeholders without discarding real inputs', async () => {
  for (const placeholder of ['', '   ', null, undefined]) {
    for (const script of [false, true]) {
      const { service, specs, settle } = fakeSubprocess({ stdout: 'ok\n' })
      settle()
      const definition = bashToolDefinition({ file: 'bash', source: 'config', subprocess: service })
      const args = script ? { command: placeholder, script_path: 'test.sh' }
        : { command: 'echo ok', script_path: placeholder }
      const value = await definition.execute(args)
      assert.equal(value.error, undefined)
      assert.deepEqual(specs[0].argv, script ? ['bash', 'test.sh'] : ['bash', '-c', 'echo ok'])
    }
  }
  const { service, specs, settle } = fakeSubprocess()
  settle()
  const definition = bashToolDefinition({ file: 'bash', source: 'config', subprocess: service })
  for (const args of [
    { command: 'echo ok', script_path: '/dev/null' },
    { command: 'echo ok', script_path: 123 },
    { command: false, script_path: 'test.sh' },
    { command: '', script_path: '' },
    { command: null, script_path: null },
  ]) await assert.rejects(() => definition.execute(args), /invalid/)
  assert.equal(specs.length, 0)
})

await test('ops_bash rejects a missing command and a bad timeout before spawning', async () => {
  await withTempDir('shells-args', async (dir) => {
    const bash = makeExecutable(path.join(dir, 'bash'))
    const { service, specs } = fakeSubprocess()
    const definition = bashToolDefinition({ file: bash, source: 'config', subprocess: service })
    const exec = { signal: new AbortController().signal }

    await assert.rejects(() => definition.execute({}, exec), /exactly one of command or script_path/)
    await assert.rejects(() => definition.execute({ command: '   ' }, exec), /invalid command/)
    await assert.rejects(() => definition.execute({ command: 'ls', timeoutMs: 0 }, exec), /invalid timeoutMs/)
    await assert.rejects(
      () => definition.execute({ command: 'ls', timeoutMs: MAX_BASH_TIMEOUT_MS + 1 }, exec),
      /no greater than/,
    )
    await assert.rejects(() => definition.execute({ command: 'ls', graceMs: -1 }, exec), /invalid graceMs/)
    assert.equal(specs.length, 0)
  })
})

await test('ops_bash refuses an argument its schema does not declare', async () => {
  // The host validates a `defineTool` body's arguments before it runs, but
  // `ctx.tools.register` — the path this plugin uses to avoid an
  // `@deepseek-ai/*` value import — validates only `output.schema`. Arguments
  // therefore reach `execute` verbatim, and reading known fields with `args?.x`
  // drops an undeclared key silently. `run_in_background` is the case that
  // hurts: the host's own bash/pwsh tools accept it, so a model that expects a
  // job id gets a foreground call that occupies the whole `timeoutMs`.
  await withTempDir('shells-unknown-args', async (dir) => {
    const bash = makeExecutable(path.join(dir, 'bash'))
    const { service, specs, settle } = fakeSubprocess()
    // Settle up front: if the guard were missing, the call would otherwise hang
    // on this fake forever and the suite would die of an unsettled await instead
    // of reporting which assertion failed.
    settle()
    const definition = bashToolDefinition({ file: bash, source: 'config', subprocess: service })
    const exec = { signal: new AbortController().signal }

    await assert.rejects(
      () => definition.execute({ command: 'node server.js', run_in_background: true }, exec),
      /unknown key "run_in_background"/,
    )
    // The refusal names what IS accepted, so a retry does not need a second guess.
    await assert.rejects(
      () => definition.execute({ command: 'ls', run_in_background: true }, exec),
      new RegExp(BASH_ARGUMENTS.join(', ')),
    )
    // Several unknown keys are reported together, in argument order.
    await assert.rejects(
      () => definition.execute({ command: 'ls', bogus: 1, other: 2 }, exec),
      /unknown keys "bogus", "other"/,
    )
    // Host-style per-call escalation is named as unsupported, with the real next step (#42).
    await assert.rejects(
      () => definition.execute({ command: 'ls', sandbox_permissions: 'danger-full-access', justification: 'x' }, exec),
      /unknown keys "sandbox_permissions", "justification".*no per-call sandbox escalation; ask the user to change the session permission mode/,
    )
    await assert.rejects(
      () => definition.execute({ command: 'ls', bogus: 1 }, exec),
      (error) => !/sandbox escalation/.test(error.message),
    )
    // A non-object body is refused for the same reason, not coerced.
    await assert.rejects(() => definition.execute([], exec), /expected an object/)
    // Nothing reached the subprocess service: the guard runs before the spawn.
    assert.equal(specs.length, 0)

    // Every declared argument still passes, and each reaches the spawn spec.
    const { service: ok, specs: okSpecs, settle: settleOk } = fakeSubprocess({ stdout: 'ok\n' })
    const passing = bashToolDefinition({ file: bash, source: 'config', subprocess: ok })
    const running = passing.execute(
      { command: 'echo hi', workdir: dir, timeoutMs: 5_000, graceMs: 250 },
      { signal: new AbortController().signal },
    )
    settleOk()
    await running
    assert.equal(okSpecs.length, 1)
    assert.equal(okSpecs[0].cwd, dir)
    assert.equal(okSpecs[0].graceMs, 250)
  })
})

await test('the ops_bash argument guard and its schema cannot drift apart', async () => {
  // `BASH_ARGUMENTS` is what `execute` enforces; `parameters.properties` is what
  // the model is told. A name in one but not the other would either refuse a
  // documented argument or silently accept an undeclared one.
  await withTempDir('shells-args-drift', async (dir) => {
    const bash = makeExecutable(path.join(dir, 'bash'))
    const { service } = fakeSubprocess()
    const definition = bashToolDefinition({ file: bash, source: 'config', subprocess: service })

    assert.deepEqual(Object.keys(definition.parameters.properties), [...BASH_ARGUMENTS])
    assert.equal(definition.parameters.additionalProperties, false)
    // Neither input is `required`: exactly one of command/script_path must be
    // present, which a JSON Schema `required` list cannot express. The guard
    // deliberately does not add a required-check the schema does not state.
    assert.equal(Object.hasOwn(definition.parameters, 'required'), false)
  })
})

await test('the ops_bash description says the tool has no background mode', async () => {
  // The prompt is the reliable correction channel: a model that has learned
  // "shell tools can run in the background" from the host's pwsh tool must be
  // told otherwise where it will read it.
  const description = bashToolDescription()
  assert.match(description, /Foreground only/)
  assert.match(description, /no run_in_background/)
  assert.match(description, /pwsh/)
})

// A definition whose subprocess service is missing cannot exist in a real
// deployment: `publishShellTools` refuses to register one (see section 3), so
// there is deliberately no "the tool throws when the service is gone" case to
// pin — the registration gate is the contract.

// ---------------------------------------------------------------------------
// 5. The L3 patch override
// ---------------------------------------------------------------------------

/** The bundle patch's raw text, read once. */
const PATCH_TEXT = fs.readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')

/**
 * Teach a general-purpose YAML parser the loader's `!!js` tag, so a tagged
 * scalar arrives as its expression text instead of an unknown-tag warning.
 * @returns {object} a schema that resolves `!!js` scalars.
 */
function entryListSchema() {
  const probe = parseDocument(PATCH_TEXT)
  probe.schema.tags.push({
    tag: 'tag:yaml.org,2002:js',
    resolve: (data) => data,
    construct: (data) => ({ __jsExpr: data }),
    identify: (value) => typeof value === 'object' && value !== null && '__jsExpr' in value,
  })
  return probe.schema
}

/**
 * The bundle patch as the loader reads it: `!!js` scalars stay expression text
 * (the loader wraps them into expression nodes one step later).
 * @returns {object[]} the patch entries.
 */
function patchEntries() {
  return parseDocument(PATCH_TEXT, { schema: entryListSchema() }).toJS()
}

/**
 * The L3 override expression exactly as written in the patch.
 * @returns {string} the expression body.
 */
function pwshOverrideExpression() {
  return 'runtime-overlay'
}

/**
 * Evaluate one loader expression exactly as the vendored loader does.
 * @param {string} expr - the expression body.
 * @param {object} ctx - the evaluation scope (`with (ctx)`).
 * @returns {unknown} the expression's value.
 */
function evaluateLoaderExpression(expr, ctx) {
  // Exercise the real runtime overlay against a loader fixture instead of the
  // removed YAML expression. The resolver and the component share this input.
  if (expr !== 'runtime-overlay') return undefined
  if (!ctx.baseUrl) return undefined
  const { fileURLToPath } = urlHelpers
  const bundleRoot = fs.realpathSync(path.join(fileURLToPath(ctx.baseUrl), 'node_modules', 'dsh-ops'))
  const shells = resolveShells(config(), { bundleRoot })
  let hook
  let result
  const entry = { options: { id: 'pwsh-sandbox', name: '@deepseek-ai/dsh-pwsh-sandbox', config: {} },
    fiber: { state: 2, update() { result = hook.call({ entry }, {}, () => ({})).pwshPath } } }
  mountBundledPwsh({ inject(_deps, body) { body({ get() { return { entries: () => [entry] } },
    on(_event, body) { hook = body; return () => {} }, effect() {} }) } }, shells)
  return result
}

await test('the manifest declares the plugin\'s own shell tools as their own namespace', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'dsh-plugin.json'), 'utf8'))
  const namespaces = manifest.contributes['x-tool-namespaces']
  // Unconditional: the manifest describes the capability, not this deployment's
  // switch state, so `bash` is declared even while a profile ships no bash.
  // Index 1, directly after the native file namespace (the FastCtx namespace is gone).
  assert.deepEqual(namespaces[1], {
    serverName: 'dsh-ops',
    transport: 'in-process',
    source: "the plugin's bash layer via host subprocess",
    publicPrefix: 'ops_',
    tools: ['bash'],
    shellPermission: 'shell component enabled AND publishBashTool AND authoritative per-session DSH policy; restricted modes require host confinement',
  })
  // The declared name is the name the tool actually registers under.
  assert.equal(BASH_TOOL_NAME, `${namespaces[1].publicPrefix}${namespaces[1].tools[0]}`)
})

await test('the bundle patch declares independent components, with no persistent pwsh override', () => {
  const entries = patchEntries()
  assert.equal(entries.length, 1)
  assert.deepEqual(entries[0].insert.map(row => row.id), ['dsh-ops-shell', 'dsh-ops-file', 'dsh-ops-ptc', 'dsh-ops-tui', 'dsh-ops-hide-official'])
  assert.equal(entries[0].insert[0].disabled, undefined)
  assert.equal(entries[0].insert[1].disabled, undefined)
  assert.equal(entries[0].insert[2].disabled, true)
  assert.equal(entries[0].insert[3].disabled, true)
  assert.equal(entries[0].insert[4].disabled, true)
})

await test('the shipped dsh-ops row states the documented shell defaults', () => {
  const row = patchEntries()[0].insert.find((candidate) => candidate.id === 'dsh-ops-shell')
  const resolved = resolveConfig(row.config)
  assert.equal(resolved.bashPath, undefined)
  assert.equal(resolved.publishBashTool, true)
  assert.equal(resolved.allowSystemShellFallback, false)
})

await test('the L3 override is inert while the plugin carries no pwsh', async () => {
  await withTempDir('shells-patch-inert', async (dir) => {
    // A profile that resolves the plugin perfectly well — the plugin simply
    // carries no pwsh yet, which is the documented state until phase C.
    const { bundleRoot, profileUrl } = stageLinkedProfile(dir)
    fs.writeFileSync(path.join(bundleRoot, 'package.json'), JSON.stringify({
      name: 'dsh-ops', version: '0.1.0',
      optionalDependencies: { [platformPackageName('pwsh')]: '0.1.0' },
    }))
    const expr = pwshOverrideExpression()

    // No pwsh in the plugin: the expression yields `undefined`, which is the
    // row's own default, so the host keeps its own PowerShell resolution.
    assert.equal(evaluateLoaderExpression(expr, { baseUrl: profileUrl, ctx: {} }), undefined)
    // An unresolvable base URL must degrade to undefined rather than throw.
    assert.equal(evaluateLoaderExpression(expr, { baseUrl: undefined, ctx: {} }), undefined)
  })
})

await test('the L3 override follows the plugin\'s own pwsh on every platform', async () => {
  await withTempDir('shells-patch-platform', async (dir) => {
    const { bundleRoot, profileUrl } = stageLinkedProfile(dir)
    const bundled = makeExecutable(bundledShellPath({
      kind: 'pwsh', bundleRoot, platform: process.platform, arch: process.arch,
    }))
    fs.writeFileSync(path.join(bundleRoot, 'package.json'), JSON.stringify({ name: 'dsh-ops', version: '0.1.0' }))
    const value = evaluateLoaderExpression(pwshOverrideExpression(), { baseUrl: profileUrl, ctx: {} })
    // The plugin carries the executable and the overlay points the owning row at
    // exactly that file. There is no platform gate left: the overlay is gated by
    // `shells.pwsh.available` alone. Whether the owning `pwsh-sandbox` row is
    // mounted stays the host's decision — `cordis.patch.yml` ships no persistent
    // pwsh override — so on a host that disables its pwsh rows this stays a no-op.
    assert.equal(value, bundled)
  })
})

await test('L3 reports unavailable without a bundled pwsh, and says what the last rung is', async () => {
  await withTempDir('shells-pwsh-absent', async (dir) => {
    const fallback = resolveShells(config({ allowSystemShellFallback: true }), {
      bundleRoot: path.join(dir, 'plugin'),
      env: { DSH_HOME: TEST_HOME, PATH: '' },
      platform: 'linux',
      arch: 'x64',
    })
    assert.equal(fallback.pwsh.available, false)
    assert.equal(fallback.pwsh.source, 'missing')
    assert.equal(fallback.pwsh.file, undefined)
    // The host's own pwsh tool is the ladder's last rung, and the detail says so.
    assert.match(fallback.pwsh.detail, /host's own pwsh tool is the ladder's last rung/)

    // Confining the ladder to plugin-provided shells changes the wording, not
    // the fact: L3 is still unavailable.
    const confined = resolveShells(config({ allowSystemShellFallback: false }), {
      bundleRoot: path.join(dir, 'plugin'),
      env: { DSH_HOME: TEST_HOME, PATH: '' },
      platform: 'linux',
      arch: 'x64',
    })
    assert.equal(confined.pwsh.available, false)
    assert.match(confined.pwsh.detail, /no PowerShell rung/)
  })
})

/**
 * Stage one profile whose `dsh-ops` is installed as a junction, exactly as a
 * `link:` install looks: `dir/` is the profile directory (it holds
 * `cordis.yml`, so `ctx.baseUrl` is `dir/`), `dir/node_modules/dsh-ops` links to
 * the bundle at `dir/dsh-ops`, and any platform package sits beside it in
 * `dir/node_modules/`. That shared `node_modules` is the point: the patch
 * expression reaches it through the profile's `baseUrl`, and `resolveShells`
 * reaches the same directory by walking up from its `bundleRoot`.
 * @param {string} dir - the temporary root, used as the profile directory.
 * @returns {{bundleRoot: string, profileUrl: string}} the tree.
 */
function stageLinkedProfile(dir) {
  const bundleRoot = path.join(dir, 'dsh-ops')
  fs.mkdirSync(bundleRoot, { recursive: true })
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
  fs.symlinkSync(bundleRoot, path.join(dir, 'node_modules', 'dsh-ops'), 'junction')
  return {
    bundleRoot,
    profileUrl: new URL('.', `file:///${dir.replace(/\\/g, '/')}/`).href,
  }
}

await test('the L3 override and the plugin probe agree on all three places, in the same order', async () => {
  const expr = pwshOverrideExpression()
  const platformPackage = platformPackageName('pwsh')

  /**
   * Build a linked profile whose pwsh sits in the named places, then report what
   * each side of the contract says.
   *
   * The platform package is staged beside the linked bundle (in the same
   * `node_modules`), so `createRequire` from either side resolves the identical
   * directory — the patch expression through the profile's `baseUrl`, the probe
   * through its own `bundleRoot`. The provisioned store is the one input the
   * expression reads from `process.env` rather than from `baseUrl`, so `DSH_HOME`
   * is set for the evaluation and restored afterwards.
   * @param {string} dir - the temporary root.
   * @param {('provisioned'|'package'|'vendor')[]} places - which places carry the pwsh.
   * @returns {{made: Record<string, string>, expression: unknown, probe: object}} both answers.
   */
  const build = (dir, places) => {
    const { bundleRoot, profileUrl } = stageLinkedProfile(dir)
    fs.writeFileSync(path.join(bundleRoot, 'package.json'), JSON.stringify({
      name: 'dsh-ops',
      version: '0.1.0',
      optionalDependencies: { [platformPackage]: '0.1.0' },
    }))
    const home = path.join(dir, 'home')
    /** @type {Record<string, string>} */
    const made = {}
    if (places.includes('provisioned')) {
      // What `dsh-ops provision-shells` installs: the pinned upstream release,
      // at the layout the pin for this platform names.
      made.provisioned = makeExecutable(path.join(
        provisionedShellVersionDir({ kind: 'pwsh', version: '7.6.6', env: { DSH_HOME: home } }),
        'bin', shellExecutable('pwsh', process.platform),
      ))
    }
    if (places.includes('package')) {
      const packageDir = path.join(dir, 'node_modules', ...platformPackage.split('/'))
      fs.mkdirSync(packageDir, { recursive: true })
      fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
        name: platformPackage, version: '0.1.0',
      }))
      made.package = makeExecutable(path.join(packageDir, 'bin', shellExecutable('pwsh', process.platform)))
    }
    if (places.includes('vendor')) {
      made.vendor = makeExecutable(bundledShellPath({
        kind: 'pwsh', bundleRoot, platform: process.platform, arch: process.arch,
      }))
    }

    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      return {
        made,
        expression: evaluateLoaderExpression(expr, { baseUrl: profileUrl, ctx: {} }),
        probe: resolveShells(config(), {
          bundleRoot,
          env: { DSH_HOME: home, PATH: '' },
          platform: process.platform,
        }),
      }
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  }

  // Each place ALONE: the one place present is the one both sides answer with.
  for (const place of PWSH_LAYOUT_ORDER) {
    await withTempDir(`shells-place-${place}`, async (dir) => {
      const { made, expression, probe } = build(dir, [place])
      assert.equal(probe.pwsh.available, true, probe.pwsh.detail)
      assert.equal(probe.pwsh.source, place === 'provisioned' ? 'provisioned' : 'bundled', probe.pwsh.detail)
      assert.equal(probe.pwsh.file, made[place])
      // Both sides of the L3 contract resolve the same file. The overlay has no
      // platform gate, so this holds everywhere.
      assert.equal(expression, made[place])
    })
  }

  // Every place at once: the ORDER itself is pinned, on both sides.
  await withTempDir('shells-place-all', async (dir) => {
    const { made, expression, probe } = build(dir, ['vendor', 'package', 'provisioned'])
    assert.notEqual(made.provisioned, made.package)
    assert.notEqual(made.package, made.vendor)
    assert.equal(probe.pwsh.source, 'provisioned', probe.pwsh.detail)
    assert.equal(probe.pwsh.file, made.provisioned)
    assert.equal(expression, made.provisioned)
  })

  await withTempDir('shells-place-bundled', async (dir) => {
    const { made, expression, probe } = build(dir, ['vendor', 'package'])
    assert.equal(probe.pwsh.source, 'bundled', probe.pwsh.detail)
    assert.equal(probe.pwsh.file, made.package)
    assert.equal(expression, made.package)
  })
})

await test('the L3 override declines without a base URL, whatever the plugin carries', () => {
  const expr = pwshOverrideExpression()
  assert.equal(evaluateLoaderExpression(expr, { baseUrl: undefined, ctx: {} }), undefined)
})

await test('system discovery is opt-in on Windows and is the rung on a POSIX host', async () => {
  await withTempDir('shells-default-confined', dir => {
    // Both spellings exist, so the case asserts the same facts on either host.
    const system = makeExecutable(path.join(dir, 'bin', 'bash'))
    const systemExe = makeExecutable(path.join(dir, 'bin', 'bash.exe'))
    const programFiles = path.join(dir, 'Program Files')
    const wellKnown = makeExecutable(path.join(programFiles, 'Git', 'bin', 'bash.exe'))
    const base = { bundleRoot: path.join(dir, 'plugin'), env: { DSH_HOME: TEST_HOME, PATH: path.join(dir, 'bin'), ProgramFiles: programFiles } }
    const host = process.platform
    // Windows: with no pinned payload and the flag off, PATH and the well-known install are both
    // visible and both deliberately not taken — `allowSystemShellFallback` is the gate on reaching
    // past the pinned copy, and there is none.
    for (const raw of [resolveConfig({}), {}, undefined]) {
      const result = resolveShells(raw, { ...base, platform: 'win32', arch: 'x64' }).bash
      assert.equal(result.available, false, JSON.stringify(result))
      assert.equal(result.source, 'disabled')
      assert.equal(result.file, undefined)
    }
    // Windows with the flag ON: PATH answers first, and the well-known install answers when PATH
    // does not — the same two rungs the POSIX host uses, reached through the gate instead.
    const winFallback = resolveShells(config({ allowSystemShellFallback: true }), { ...base, platform: 'win32', arch: 'x64' }).bash
    assert.equal(winFallback.source, 'path')
    assert.equal(winFallback.file, systemExe)
    const winWellKnown = resolveShells(config({ allowSystemShellFallback: true }), {
      ...base, platform: 'win32', arch: 'x64', env: { ...base.env, PATH: '/nonexistent-bin' },
    }).bash
    assert.equal(winWellKnown.source, 'well-known', JSON.stringify(winWellKnown))
    assert.equal(winWellKnown.file, wellKnown)
    // POSIX: the machine's own bash IS the rung, so the same config resolves it with no flag — and
    // `config.bashPath` still outranks discovery.
    const linux = resolveShells(config({}), { ...base, platform: 'linux', arch: 'x64' }).bash
    assert.equal(linux.available, true, JSON.stringify(linux))
    assert.equal(linux.source, 'path')
    assert.equal(linux.file, system)
    if (process.platform !== 'win32') {
      const posixWellKnown = resolveShells(config({}), { ...base, platform: 'linux', arch: 'x64', env: { ...base.env, PATH: '/nonexistent-bin' } }).bash
      assert.equal(posixWellKnown.source, 'well-known', JSON.stringify(posixWellKnown))
    }
    assert.equal(resolveShells(config({ bashPath: system }), { ...base, platform: host, arch: process.arch }).bash.source, 'config')
  })
})

await test('runtime pwsh overlay targets only the owning row and restores latest raw config without saving', () => {
  let hook, cleanup
  const updates = []
  const target = { options: { id: 'pwsh-sandbox', name: '@deepseek-ai/dsh-pwsh-sandbox', config: { pwshPath: 'original', retained: true } } }
  target.fiber = { state: 2, update(raw, noSave) {
    updates.push({ config: hook ? hook.call({ entry: target }, raw, () => ({ ...raw })) : { ...raw }, noSave })
  } }
  const foreign = { options: { id: 'pwsh-sandbox', name: 'foreign-executor', config: {} }, fiber: { state: 2, update() { throw new Error('foreign update') } } }
  const fixture = { inject(_deps, body) { body({
    get() { return { entries: () => [target, foreign] } },
    on(_name, callback) { hook = callback; return () => { hook = undefined } },
    effect(callback) { cleanup = callback() },
  }) } }
  const original = target.options.config
  mountBundledPwsh(fixture, { pwsh: { available: true, file: 'approved-pwsh' } })
  // No platform gate: the overlay is gated by `shells.pwsh.available` alone, so
  // the whole contract holds here — owning row only, no config saved, and the
  // restore recomputed from the owner's latest raw config.
  assert.deepEqual(updates[0], { config: { pwshPath: 'approved-pwsh', retained: true }, noSave: true })
  assert.equal(target.options.config, original)
  assert.deepEqual(hook.call({ entry: foreign }, {}, () => ({ pwshPath: 'foreign' })), { pwshPath: 'foreign' })
  target.options.config = { pwshPath: 'new-owner-choice', retained: false }
  cleanup()
  assert.deepEqual(updates[1], { config: target.options.config, noSave: true })
  cleanup()
  assert.equal(updates.length, 2, 'cleanup is idempotent')
})


await test('an inherited LC_ALL cannot un-pin the message locale, and encoding survives it', () => {
  // Reported by @Haoming9527 in review of #81: POSIX resolves LC_ALL before LC_MESSAGES, so on a host
  // that sets LC_ALL (`zh_CN.UTF-8` desktops commonly set nothing else) the English pin below was
  // silently ineffective, and a localized libc stopped matching the host's English
  // `denialSignatures`. Measured on this host before the fix: `LC_MESSAGES="zh_CN.UTF-8"`.
  const pinned = shellEnvOverrides({ LC_ALL: 'zh_CN.UTF-8' }, {})
  assert.equal(pinned.LC_MESSAGES, 'C')
  assert.equal(pinned.LC_ALL, '', 'an empty value is "unset" to the C library, so the pin holds')
  assert.equal(pinned.LC_CTYPE, 'zh_CN.UTF-8', "the variable's encoding intent must survive")
  // A host that stated its own ctype keeps it: only the language is pinned, never the codeset.
  assert.equal(Object.hasOwn(shellEnvOverrides({ LC_ALL: 'zh_CN.UTF-8', LC_CTYPE: 'en_US.UTF-8' }, {}), 'LC_CTYPE'), false)
  // No ambient override to neutralize: the plain shape is unchanged, byte for byte.
  assert.deepEqual(shellEnvOverrides({ LANG: 'zh_CN.UTF-8' }, {}), { ...ENV_OVERRIDES })
  // A caller's own LC_ALL is neutralized the same way, so the seam cannot un-pin it either.
  assert.equal(shellEnvOverrides({}, { LC_ALL: 'zh_CN.UTF-8' }).LC_ALL, '')
  assert.equal(shellEnvOverrides({}, { LC_ALL: 'zh_CN.UTF-8' }).LC_CTYPE, 'zh_CN.UTF-8')
  if (process.platform === 'win32') return
  // Effective locale, read back from the C library rather than from the environment: `locale` prints
  // what libc resolved, and `wc -m` counts characters, which `LC_ALL=C` would break (6 for `中文`).
  const utfLocale = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8'
  const probe = spawnSync('/bin/sh', ['-c', 'locale 2>/dev/null | grep "^LC_MESSAGES="; printf "中文" | wc -m'], {
    env: { ...process.env, ...shellEnvOverrides({ LC_ALL: utfLocale }, {}), LC_CTYPE: utfLocale }, encoding: 'utf8',
  })
  assert.equal(probe.status, 0, probe.stderr)
  assert.match(probe.stdout, /LC_MESSAGES="?C"?/, `the effective message locale must be C: ${probe.stdout}`)
  assert.equal(probe.stdout.trim().split('\n').pop().trim(), '2', `UTF-8 input must still count per character: ${probe.stdout}`)
})

report('shells')
