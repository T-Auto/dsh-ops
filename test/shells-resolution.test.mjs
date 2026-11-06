/**
 * The shell ladder's resolution order: the configured path, the plugin's own
 * copies, PATH, and the well-known installs — plus the two phase-C layouts the
 * resolver must see (`@dsh-ops/<shell>-<platform>-<arch>` packages and the
 * `dsh-ops provision-shells` store).
 *
 * Every case is a fake by construction — temp directories, a synthetic PATH,
 * and a staged store or package tree — because a suite that asserted "Git for
 * Windows is installed here" would be testing the developer's laptop.
 *
 * The shared fixtures live in `test/lib/shells-fixtures.mjs`.
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  SHELL_UPSTREAM_PINS,
  bundledShell,
  bundledShellPath,
  provisionedShell,
  provisionedShellVersionDir,
  resolveShells,
  shellExecutable,
  shellUpstreamPin,
} from '../lib/shells.js'
import { gitBashCandidates } from '../lib/shells/manager.js'
import { assert, TEST_HOME, report, test, withTempDir } from './lib/harness.mjs'
import {
  config,
  makeExecutable,
  onlyPath,
  platformPackageName,
  stagePlatformPackage,
  stageProvisioned,
} from './lib/shells-fixtures.mjs'

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
    assert.equal(resolved.bash.source, process.platform === 'win32' ? 'missing' : 'bundled')
    assert.equal(resolved.bash.file, process.platform === 'win32' ? undefined : bundledBash)
    assert.equal(resolved.pwsh.source, 'host')
    assert.equal(resolved.pwsh.file, undefined)
    assert.equal(fs.existsSync(bundledPwsh), true, 'legacy files are not removed')
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
    assert.equal(resolved.bash.source, process.platform === 'win32' ? 'missing' : 'path')
    assert.equal(resolved.bash.file, process.platform === 'win32' ? undefined : onPathBash)
    assert.equal(resolved.pwsh.available, false)
    assert.equal(resolved.pwsh.source, 'host')
  })
})

await test('a Windows deployment does not implicitly select a well-known Git install', async () => {
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
    assert.equal(resolved.bash.available, false)
    assert.equal(resolved.bash.source, 'missing')
    assert.equal(resolved.bash.file, undefined)
    assert.equal(resolved.pwsh.available, false)
    assert.equal(resolved.pwsh.source, 'host')
  })
})

await test('the Store WindowsApps bash alias is never resolved as Git Bash', async () => {
  await withTempDir('shells-wsl-alias', async (dir) => {
    const localAppData = path.join(dir, 'AppData')
    const alias = makeExecutable(path.join(localAppData, 'Microsoft', 'WindowsApps', 'bash.exe'))
    const gitBash = makeExecutable(path.join(dir, 'Git', 'bin', 'bash.exe'))
    const env = {
      DSH_HOME: TEST_HOME,
      PATH: path.dirname(alias),
      LOCALAPPDATA: localAppData,
      ProgramFiles: path.join(dir, 'Program Files'),
    }
    const resolved = resolveShells(config({ allowSystemShellFallback: true }), {
      bundleRoot: path.join(dir, 'plugin'), env, platform: 'win32', arch: 'x64',
    })
    // The alias is a WSL distribution, not the Git Bash the operator asked for.
    assert.notEqual(resolved.bash.file, alias)
    // It is not offered as a candidate either.
    const candidates = gitBashCandidates({ env, platform: 'win32' })
    assert.equal(candidates.includes(alias), false)
    assert.equal(candidates.includes(gitBash), false, 'a non-Git directory on PATH is not a Git install claim')
    assert.ok(gitBash.length > 0)
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
    assert.equal(resolved.bash.file, undefined)
    assert.equal(resolved.bash.source, 'missing')
  })
})

await test('legacy bundled Bash cannot substitute for a missing verified Niubash tree', async () => {
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
    assert.equal(withBundle.bash.available, false)
    assert.equal(withBundle.bash.source, 'missing')
    assert.equal(withBundle.bash.file, undefined)

    const withoutBundle = resolveShells(config({ allowSystemShellFallback: false }), {
      bundleRoot: path.join(dir, 'no-plugin'),
      env: { DSH_HOME: TEST_HOME, PATH: onlyPath(path.dirname(bundled)) },
      platform: 'win32',
      arch: 'x64',
    })
    assert.equal(withoutBundle.bash.available, false)
    assert.equal(withoutBundle.bash.source, 'missing')
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
    assert.equal(resolved.pwsh.available, false)
    assert.equal(resolved.pwsh.source, 'host')
  })
})

await test('bundledShellPath names the platform package layout phase C will ship', () => {
  const file = bundledShellPath({
    kind: 'pwsh', bundleRoot: 'C:\\plugin', platform: 'win32', arch: 'x64',
  })
  assert.equal(file, path.join('C:\\plugin', 'vendor', 'pwsh', 'win32-x64', 'pwsh.exe'))
})

// --- the published platform packages (phase C), exercised without installing one

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
    assert.equal(resolved.bash.source, 'missing')
    assert.match(resolved.bash.detail, /Niubash.*missing/)
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
    assert.match(missing, /Niubash.*missing/)
    assert.ok(missing.includes('provision-shells --bash'), missing)
    assert.equal(/\brepair(s|ing)?\b/u.test(missing), false, missing)
  })

  let corrupt
  await withTempDir('shells-cause-corrupt', async (dir) => {
    corrupt = detailFor(dir, { install: true, binary: false })
    assert.match(corrupt, /Niubash.*missing/)
    assert.ok(corrupt.includes('provision-shells --bash'), corrupt)
  })

  assert.equal(missing, corrupt, 'legacy npm package state cannot change the native-backend remedy')
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

await test('provisioned Bash outranks other copies while legacy PowerShell remains host-owned', async () => {
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
    if (process.platform === 'win32') {
      assert.equal(resolved.bash.available, false)
      assert.equal(resolved.bash.source, 'missing', 'legacy provisioned Bash cannot replace Niubash')
      assert.equal(fs.existsSync(provisionedBash), true, 'legacy install remains operator-owned')
      return
    }
    assert.equal(resolved.bash.available, true, resolved.bash.detail)
    assert.equal(resolved.bash.source, 'provisioned', resolved.bash.detail)
    assert.equal(resolved.bash.file, provisionedBash)
    assert.notEqual(resolved.bash.file, packaged, 'the provisioned copy beats the platform package')
    assert.notEqual(resolved.bash.file, onPath, 'the provisioned copy beats PATH')
    assert.match(resolved.bash.detail, /version 2\.56\.0\.2/u)
    assert.equal(resolved.pwsh.available, false, resolved.pwsh.detail)
    assert.equal(resolved.pwsh.source, 'host', resolved.pwsh.detail)
    assert.equal(resolved.pwsh.file, undefined)
    assert.equal(fs.existsSync(provisionedPwsh), true)
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
    assert.equal(confined.pwsh.file, undefined)
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

report('shells-resolution')
