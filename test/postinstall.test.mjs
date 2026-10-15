/**
 * `postinstall.mjs`: which payloads a consuming install downloads, where they
 * land, and what happens when that download cannot happen.
 *
 * The script is run as a real child process with a controlled environment,
 * because everything it decides is decided from `process.env` and from the
 * `node_modules` tree it sits in — importing it would decide from this suite's
 * own machine instead. It also installs into its own package directory, so the
 * suite stages a copy of the package beside it and drives that copy: a case may
 * then assert the payload arrived under `node_modules/@dsh-ops/`, and the
 * checkout's own tree is never written to.
 *
 * `npm` is replaced by a batch shim on the child's `PATH` (a two-line `.cmd`
 * that hands over to Node, because `--no-package-lock` and a scoped spec are
 * not something a batch file parses well). The shim records its argv and, when
 * it is told to succeed, writes the payload directories it was asked for; that
 * is what proves the scratch project and the move into place both happen. The
 * failing case proves the contract the script exists to keep: a payload that
 * cannot be fetched may not fail the host's own install.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { PACKAGE_ROOT, TEST_HOME, assert, report, skipSuite, test, withTempDir } from './lib/harness.mjs'

if (process.platform !== 'win32') skipSuite('postinstall', 'the payloads are Windows-only')

/** The shell payloads the script installs, and the executable each one carries. */
const PAYLOADS = [
  { name: `@dsh-ops/bash-${process.platform}-${process.arch}`, executable: 'bash.exe' },
  { name: `@dsh-ops/pwsh-${process.platform}-${process.arch}`, executable: 'pwsh.exe' },
]

/**
 * Copy the package beside the checkout, so the cases can install into it.
 *
 * `lib/` comes along whole: the script imports `lib/shells.js`, which imports
 * the rest, and copying the tree keeps that closure honest without a list to
 * maintain. The manifest is written rather than copied, so a case can choose
 * between the published shape (the payloads are not declared) and the
 * unpublished one (they are, and their version is what gets asked for).
 * @param {string} dir - the case's own directory.
 * @param {{pins?: boolean}} [options] - the manifest shape.
 * @returns {{root: string, script: string}} the staged package.
 */
function stagePackage(dir, { pins = false } = {}) {
  const root = path.join(dir, 'package')
  fs.mkdirSync(root, { recursive: true })
  fs.copyFileSync(path.join(PACKAGE_ROOT, 'postinstall.mjs'), path.join(root, 'postinstall.mjs'))
  fs.cpSync(path.join(PACKAGE_ROOT, 'lib'), path.join(root, 'lib'), { recursive: true })
  const optionalDependencies = pins
    ? Object.fromEntries(PAYLOADS.map((payload) => [payload.name, '0.2.1']))
    : {}
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({
    name: 'dsh-ops', version: '0.0.0-test', optionalDependencies,
  }, null, 2)}\n`)
  return { root, script: path.join(root, 'postinstall.mjs') }
}

/**
 * Stage one payload directory under a package root.
 * @param {string} root - the package root.
 * @param {{name: string, executable: string}} payload - which payload.
 * @returns {void}
 */
function stagePayload(root, payload) {
  const directory = path.join(root, 'node_modules', ...payload.name.split('/'), 'bin')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, payload.executable), 'stub\n')
}

/**
 * Write the npm shim a case wants on the child's `PATH`.
 * @param {string} dir - the directory to write it into.
 * @param {number} exitCode - the status the shim exits with.
 * @returns {string} the directory that holds it.
 */
function stageNpmShim(dir, exitCode) {
  fs.mkdirSync(dir, { recursive: true })
  const shim = path.join(dir, 'npm-shim.mjs')
  fs.writeFileSync(shim, [
    "import fs from 'node:fs'",
    "import path from 'node:path'",
    'const args = process.argv.slice(2)',
    'fs.writeFileSync(process.env.FAKE_NPM_MARKER, args.join(\' \'))',
    'const status = Number(process.env.FAKE_NPM_EXIT ?? \'0\')',
    "if (status === 0) {",
    '  for (const spec of args.filter((arg) => arg.startsWith(\'@dsh-ops/\'))) {',
    '    const name = spec.split(\'@\').slice(0, 2).join(\'@\')',
    '    const directory = path.join(process.cwd(), \'node_modules\', ...name.split(\'/\'), \'bin\')',
    '    fs.mkdirSync(directory, { recursive: true })',
    "    fs.writeFileSync(path.join(directory, name.includes('bash') ? 'bash.exe' : 'pwsh.exe'), 'stub\\n')",
    '  }',
    '}',
    'process.exit(status)',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(dir, 'npm.cmd'), [
    '@echo off',
    `"${process.execPath}" "${shim}" %*`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n'))
  return dir
}

/**
 * Run the staged script with one environment and report what it did.
 * @param {object} options - run inputs.
 * @param {{root: string, script: string}} options.pkg - the staged package.
 * @param {string} options.shimDir - the directory holding the npm shim.
 * @param {string} options.marker - where that shim records its argv.
 * @param {number} options.exitCode - the status the shim exits with.
 * @param {string} options.programFiles - the `ProgramFiles` the child sees.
 * @param {NodeJS.ProcessEnv} [options.env] - extra environment.
 * @returns {{status: number|null, stdout: string, argv: string|undefined}} the run.
 */
function run({ pkg, shimDir, marker, exitCode, programFiles, env = {} }) {
  const result = spawnSync(process.execPath, [pkg.script], {
    cwd: pkg.root,
    encoding: 'utf8',
    env: {
      SystemRoot: process.env.SystemRoot,
      ComSpec: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      PATH: `${shimDir};${process.env.SystemRoot}\\System32`,
      ProgramFiles: programFiles,
      'ProgramFiles(x86)': programFiles,
      LOCALAPPDATA: programFiles,
      USERPROFILE: programFiles,
      DSH_HOME: TEST_HOME,
      FAKE_NPM_MARKER: marker,
      FAKE_NPM_EXIT: String(exitCode),
      ...env,
    },
  })
  const argv = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : undefined
  return { status: result.status, stdout: `${result.stdout ?? ''}${result.stderr ?? ''}`, argv }
}

/**
 * Whether one payload is installed under a package root.
 * @param {string} root - the package root.
 * @param {{name: string, executable: string}} payload - which payload.
 * @returns {boolean} true when its executable is there.
 */
function payloadInstalled(root, payload) {
  return fs.existsSync(path.join(root, 'node_modules', ...payload.name.split('/'), 'bin', payload.executable))
}

await test('a forced install lands both payloads under the package and never fails the install', async () => {
  await withTempDir('postinstall-force', async (dir) => {
    const pkg = stagePackage(dir, { pins: true })
    const empty = path.join(dir, 'program-files')
    fs.mkdirSync(empty, { recursive: true })
    const result = run({
      pkg,
      shimDir: stageNpmShim(path.join(dir, 'shim'), 0),
      marker: path.join(dir, 'marker.txt'),
      exitCode: 0,
      programFiles: empty,
      env: { DSH_OPS_INSTALL_PAYLOADS: '1' },
    })
    assert.equal(result.status, 0, result.stdout)
    assert.match(result.stdout, /installing the pinned Windows shell payload\(s\)/u)
    // The declared version is what gets asked for when the manifest carries one,
    // and the flags keep npm from resolving the package's development tree.
    assert.match(result.argv ?? '', /install --no-save --no-package-lock --ignore-scripts --no-audit --no-fund --loglevel=error/u)
    for (const payload of PAYLOADS) {
      assert.match(result.argv ?? '', new RegExp(`${payload.name.replace('/', '\\/')}@0\\.2\\.1`, 'u'))
      assert.equal(payloadInstalled(pkg.root, payload), true, `${payload.name} did not land: ${result.stdout}`)
    }
    // The scratch project is gone, so the package keeps only what it installed.
    assert.equal(fs.existsSync(path.join(pkg.root, '.payload-install')), false)
  })
})

await test('a bare machine asks the registry for both pinned payloads', async () => {
  await withTempDir('postinstall-bare', async (dir) => {
    const pkg = stagePackage(dir)
    const empty = path.join(dir, 'program-files')
    fs.mkdirSync(empty, { recursive: true })
    const result = run({
      pkg,
      shimDir: stageNpmShim(path.join(dir, 'shim'), 0),
      marker: path.join(dir, 'marker.txt'),
      exitCode: 0,
      programFiles: empty,
    })
    assert.equal(result.status, 0, result.stdout)
    // The published manifest does not declare the payloads, so the request is
    // unpinned and the registry's own latest is what answers it.
    for (const payload of PAYLOADS) {
      assert.match(result.argv ?? '', new RegExp(`${payload.name.replace('/', '\\/')}@latest`, 'u'))
      assert.equal(payloadInstalled(pkg.root, payload), true, `${payload.name} did not land: ${result.stdout}`)
    }
  })
})

await test('a registry that refuses still exits 0 and names the way around it', async () => {
  await withTempDir('postinstall-fail', async (dir) => {
    const pkg = stagePackage(dir)
    const empty = path.join(dir, 'program-files')
    fs.mkdirSync(empty, { recursive: true })
    const result = run({
      pkg,
      shimDir: stageNpmShim(path.join(dir, 'shim'), 1),
      marker: path.join(dir, 'marker.txt'),
      exitCode: 1,
      programFiles: empty,
      env: { DSH_OPS_INSTALL_PAYLOADS: '1' },
    })
    assert.equal(result.status, 0, result.stdout)
    assert.match(result.stdout, /did not complete/u)
    assert.match(result.stdout, /provision-shells --bash --pwsh/u)
    for (const payload of PAYLOADS) assert.equal(payloadInstalled(pkg.root, payload), false)
    assert.equal(fs.existsSync(path.join(pkg.root, '.payload-install')), false)
  })
})

await test('a system shell on the machine means no payload is downloaded', async () => {
  await withTempDir('postinstall-system', async (dir) => {
    const pkg = stagePackage(dir)
    const programFiles = path.join(dir, 'program-files')
    for (const relative of ['Git/bin/bash.exe', 'PowerShell/7/pwsh.exe']) {
      fs.mkdirSync(path.dirname(path.join(programFiles, relative)), { recursive: true })
      fs.writeFileSync(path.join(programFiles, relative), 'stub\n')
    }
    const result = run({
      pkg,
      shimDir: stageNpmShim(path.join(dir, 'shim'), 0),
      marker: path.join(dir, 'marker.txt'),
      exitCode: 0,
      programFiles,
    })
    assert.equal(result.status, 0, result.stdout)
    assert.equal(result.argv, undefined, `npm was invoked: ${String(result.argv)}`)
    assert.match(result.stdout, /no payload downloaded/u)
  })
})

await test('a payload already under the package is not downloaded again', async () => {
  await withTempDir('postinstall-present', async (dir) => {
    const pkg = stagePackage(dir)
    for (const payload of PAYLOADS) stagePayload(pkg.root, payload)
    const empty = path.join(dir, 'program-files')
    fs.mkdirSync(empty, { recursive: true })
    const result = run({
      pkg,
      shimDir: stageNpmShim(path.join(dir, 'shim'), 0),
      marker: path.join(dir, 'marker.txt'),
      exitCode: 0,
      programFiles: empty,
    })
    assert.equal(result.status, 0, result.stdout)
    assert.equal(result.argv, undefined, `npm was invoked: ${String(result.argv)}`)
    assert.match(result.stdout, /no payload downloaded/u)
  })
})

report('postinstall')
