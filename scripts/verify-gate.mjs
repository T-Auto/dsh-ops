#!/usr/bin/env node
/**
 * The whole release gate, in the order `.github/workflows/ci.yml` runs it, with the
 * parts that differ per platform decided here instead of by a human remembering them.
 *
 * Why a script and not the checklist in `docs/windows-verification.md`: that document
 * is for a *human* on a host that cannot run `npm run verify`, and it has to explain
 * what to look at. This one is for a host that can run it, and it exists to make two
 * properties mechanical:
 *
 *   · **A skip is never a pass.** The runner already counts them apart, but a host that
 *     silently skips a suite still exits 0, so "green" and "answered" are different
 *     claims. This script knows which suites are *allowed* to skip on this platform,
 *     names any other one, and fails on it.
 *   · **The number in the docs matches the number on the host.** The manifest check
 *     count and the skip set are printed, and both are asserted, so a stale document or
 *     a newly-guarded suite is a failure here rather than a quiet drift.
 *
 * It never fabricates a platform: `--target` must equal `process.platform-process.arch`
 * (the same guard CI uses), because the expected skip set is derived from it.
 *
 * Usage (from the repository root):
 *
 *   node scripts/verify-gate.mjs                     # this host, full gate
 *   node scripts/verify-gate.mjs --skip-install      # node_modules is already current
 *   node scripts/verify-gate.mjs --json              # machine-readable summary
 *   node scripts/verify-gate.mjs --keep-going        # run every step, report all failures
 *
 * A red host is reported, not smoothed over: both of `test/run.mjs`'s summary shapes are
 * parsed (the green one and `N of M suite(s) failed`), so a failing run names the failing step
 * and suite count instead of reading as "the runner did not finish".
 *
 * Exit codes: 0 all steps passed, 1 a step failed, 2 the host cannot answer this gate
 * (wrong target, missing toolchain) — never a green run for either.
 *
 * @module dsh-ops/scripts/verify-gate
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { collectProcessOutput } from './lib/gate-output.mjs'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name, short) => argv.includes(`--${name}`) || (short !== undefined && argv.includes(`-${short}`))
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 || argv[index + 1] === undefined ? fallback : argv[index + 1]
}

const HOST = `${process.platform}-${process.arch}`
const TARGET = option('target', HOST)
const JSON_OUT = flag('json')
const KEEP_GOING = flag('keep-going')

/**
 * What each platform is allowed to skip, and no more.
 *
 * Windows is the interesting one: `file-metadata` and `linux-attributes` are POSIX
 * concepts (mode bits, POSIX ACLs, `user.*` xattrs, inode identity, sparse allocation),
 * and `linux-shell` drives the POSIX bash rung — its own subject. On a POSIX host the
 * Windows-only cache preparation and windows-security suites skip on POSIX; `mount` may skip when no native worker can be resolved
 * there (component composition needs it).
 * A platform that skips anything else is a finding, not a footnote.
 */
const ALLOWED_SKIPS = TARGET === 'win32-x64'
  ? ['file-metadata', 'linux-attributes', 'linux-shell']
  : ['mount', 'result-storage-cache-prep', 'windows-security', 'niubash-consumer', 'niubash-security-host']

/**
 * Suites that need an *optional external* checkout (`DSH_OPS_TUI_ROOT`, and for the native one also
 * `DSH_OPS_TUI_WORKER`). They may legitimately skip on a machine that has neither, so their names go
 * to the runner as `DSH_OPS_ALLOW_SKIPS` and to the skip assertion below as allowed. A suite that
 * really breaks is not a skip, so it still fails the run; runtime-absence skips (`permissions`,
 * `ptc`) are deliberately not on this list.
 */
const EXTERNAL_SUITE_DEPS = ['tui-host', 'tui-native']

/** The manifest check count the docs promise. */
/**
 * A floor, not the current size. `validate-manifest.mjs` gains checks as the manifest grows, and a
 * pinned number goes stale the moment `main` moves (#134 shipped `59` while the tree was at `62`).
 * The floor still catches a validator that collapses and reports nothing.
 */
const MANIFEST_CHECK_FLOOR = 59

/**
 * The suite inventory is the source of truth, discovered exactly as `test/run.mjs` does: every
 * `test/*.test.mjs`, in name order, on every platform — platform gating happens inside a suite as a
 * skip, never as a discovery filter. Deriving the expectation from that same directory keeps the
 * assertion meaningful (a suite whose file is still on disk but which stops being collected is a
 * failure) without pinning a number that every new suite invalidates.
 */
const EXPECTED_SUITES = readdirSync(new URL('../test/', import.meta.url))
  .filter((name) => name.endsWith('.test.mjs')).length

const steps = []
/** Steps that exited non-zero; only populated under `--keep-going`. */
const stepFailures = []

/** Run one step, stream its output, and return `{code, output}`. */
async function run(title, command, args, { env = {}, optional = false, cwd = PACKAGE_ROOT } = {}) {
  const shown = [command, ...args].join(' ')
  process.stdout.write(`\n=== ${title}\n$ ${shown}\n`)
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, shell: process.platform === 'win32' })
  // The listeners go on before the streams are touched. A `spawn` that cannot find its tool emits
  // `error` immediately, and an `error` event with no listener takes the whole runner down with a
  // stack trace instead of reporting "this host cannot answer the gate" (exit 2).
  let spawnError = null
  const finished = new Promise(resolve => {
    child.once('close', code => resolve(code))
    child.once('error', error => { spawnError = error; resolve(null) })
  })
  let output = ''
  try {
    output = await collectProcessOutput(child)
  } catch (error) {
    spawnError ??= error
  }
  const code = await finished
  if (spawnError !== null || code === null) {
    throw Object.assign(new Error(`cannot run ${shown}: ${spawnError?.message ?? 'the command did not start'}`), { exitCode: 2 })
  }
  const step = { title, command: shown, code, optional }
  steps.push(step)
  if (code !== 0 && !optional) {
    // `--keep-going` runs the rest and reports everything at the end; the default stops at
    // the first failure, because a later step's verdict is not independent of this one.
    if (!KEEP_GOING) throw Object.assign(new Error(`step failed (${code}): ${shown}`), { step })
    stepFailures.push(`${title}: exited ${code}`)
  }
  return { ...step, output }
}

/**
 * The suite summary `test/run.mjs` prints, in both of its shapes: the green one
 * (`30 suite(s) passed`) and the red one (`1 of 27 suite(s) failed`). A failing run still
 * has to be readable — "the runner did not finish" would hide which suite broke.
 */
function parseSummary(output) {
  // Parse the *runner's* line, not the suites' own: the runner names the suite file it skipped, in
  // both the green form and the `DSH_OPS_REQUIRE_RUNTIME=1` form, while a suite's own message is a
  // human label ("dsh-ops TUI host: skipped …") that does not identify the suite for the checks
  // below.
  const skipped = [...new Set([...output.matchAll(/^--- (\S+) skipped(?: while DSH_OPS_REQUIRE_RUNTIME=1)?/gm)]
    .map(match => match[1].replace(/\.test\.mjs$/, '')))]
  const green = /dsh-ops test: (\d+) suite\(s\) passed(?:, (\d+) skipped)?/.exec(output)
  if (green !== null) {
    return { passed: Number(green[1]), failed: 0, skippedCount: green[2] === undefined ? 0 : Number(green[2]), skipped, reported: true }
  }
  const red = /dsh-ops test: (\d+) of (\d+) suite\(s\) failed/.exec(output)
  if (red !== null) {
    return { passed: Number(red[2]) - Number(red[1]), failed: Number(red[1]), skippedCount: skipped.length, skipped, reported: true }
  }
  return { passed: null, failed: null, skippedCount: null, skipped, reported: false }
}

function parseManifest(output) {
  const match = /validate-manifest: all (\d+) checks passed/.exec(output)
  return match === null ? null : Number(match[1])
}

async function main() {
  if (TARGET !== HOST) {
    console.error(`this gate is for the host that runs it: --target ${TARGET} does not match ${HOST}`)
    console.error('run it on that host (or in CI, where the runner is pinned to the target)')
    process.exit(2)
  }

  await run('versions', 'node', ['--version'])
  await run('cargo version', 'cargo', ['--version'])
  if (!flag('skip-install') && !existsSync(path.join(PACKAGE_ROOT, 'node_modules'))) {
    await run('install locked dependencies', 'npm', ['ci', '--ignore-scripts', '--registry=https://registry.npmjs.org'])
  } else {
    process.stdout.write('\n=== install locked dependencies\n(skipped: node_modules is present; pass --skip-install to make this explicit)\n')
  }

  // The native build/staging CLI imports lib, just like the validator and suites.
  await run('build the plugin', 'npm', ['run', 'build'])
  await run('native worker unit tests', 'cargo', ['test', '--workspace', '--locked', '--manifest-path', 'native/Cargo.toml'])
  await run('build and stage the native worker', 'npm', ['run', 'build:ptc'])

  // Every pack (including POSIX packs) carries the frozen Windows payload.
  const stageArgs = ['run', 'stage:niubash', '--']
  const archive = process.env.DSH_OPS_NIUBASH_ARCHIVE
  if (archive) stageArgs.push('--archive', archive)
  if (process.env.DSH_OPS_OFFLINE === '1') stageArgs.push('--offline')
  await run('stage complete frozen Niubash payload', 'npm', stageArgs)
  const { NIUBASH_PIN } = await import('../lib/cli/niubash-payload.js')
  const runtimeEnv = { DSH_OPS_NIUBASH_ARCHIVE: archive ?? path.join(PACKAGE_ROOT, 'dist/downloads', NIUBASH_PIN.archive),
    DSH_OPS_SUITE_TIMEOUT_MS: process.env.DSH_OPS_SUITE_TIMEOUT_MS ?? '600000' }
  if (TARGET === 'win32-x64') {
    const { verifyNiubashTree, NIUBASH_PACKAGE_PATH } = await import('../lib/cli/niubash-payload.js')
    runtimeEnv.DSH_OPS_TEST_NIUBASH = verifyNiubashTree(path.join(PACKAGE_ROOT, NIUBASH_PACKAGE_PATH))
    // Compatibility coverage is explicit and separate from the default native backend.
    // Acquire the committed legacy pin only for the MSYS tests/proxy build.
    const { pinnedBashExecutable } = await import('../lib/shells/pinned.js')
    let fixture = process.env.DSH_OPS_TEST_BASH
    if (!fixture) {
      const fixtureEnv = { DSH_HOME: mkdtempSync(path.join(tmpdir(), 'dsh-ops-legacy-bash-fixture-')) }
      const { SHELL_UPSTREAM_PINS } = await import('../lib/shells/pins.js')
      const pinFile = path.join(fixtureEnv.DSH_HOME, 'legacy-pins.json')
      writeFileSync(pinFile, JSON.stringify(SHELL_UPSTREAM_PINS.filter(pin => pin.name === 'bash')))
      await run('Acquire explicit legacy MSYS fixture', 'node', ['bin/dsh-ops.mjs', 'provision-shells', '--bash', '--pin', pinFile], { env: fixtureEnv })
      fixture = pinnedBashExecutable({ env: fixtureEnv })
    }
    runtimeEnv.DSH_OPS_TEST_BASH = pinnedBashExecutable({ file: fixture })
    await run('Legacy Windows IPC payloads', 'npm', ['run', 'build:bash-ipc'], { env: runtimeEnv })
  }

  const manifest = await run('manifest contract', 'npm', ['run', 'validate:manifest'])
  const manifestChecks = parseManifest(manifest.output)

  // Require every runtime; only the named platform/external-checkout exceptions below
  // remain skips. Missing Windows Niubash fixtures are never permission-test success.
  const env = { ...runtimeEnv, DSH_HOME: mkdtempSync(path.join(tmpdir(), 'dsh-ops-gate-')) }
  env.DSH_OPS_REQUIRE_RUNTIME = '1'
  // Keep the external-checkout suites as skips: `DSH_OPS_REQUIRE_RUNTIME=1` would otherwise
  // count them as failures and make this gate permanently red on a machine without that checkout.
  env.DSH_OPS_ALLOW_SKIPS = [...EXTERNAL_SUITE_DEPS, ...ALLOWED_SKIPS].join(',')
  // Plugin and manifest were already built/validated above; do not repeat npm verify's prelude.
  const verify = await run('full suite verification', 'node', ['test/run.mjs'], { env })
  const summary = parseSummary(verify.output)

  await run('staged runtime closure', 'node', ['bin/native-runtime.mjs', 'check', '--platform', TARGET])

  // The artifact, not just the build. `npm pack` honours `files`, and a package that silently drops
  // `runtime/` installs fine and then fails in the user's profile — so check the thing users get.
  // Share the collection: --keep-going artifact failures must reach the final verdict too.
  const failures = stepFailures
  const packDir = mkdtempSync(path.join(tmpdir(), 'dsh-ops-pack-'))
  await run('pack the release artifact', 'npm', ['pack', '--pack-destination', packDir])
  const tarball = readdirSync(packDir).find(entry => entry.endsWith('.tgz'))
  if (tarball === undefined) failures.push('npm pack produced no .tgz in the pack destination')
  else {
    // Relative to the pack directory on purpose: Git for Windows ships GNU tar, which reads a
    // `C:\...` argument as a remote host ("Cannot connect to C: resolve failed").
    await run('unpack the release artifact', 'tar', ['-xzf', tarball], { cwd: packDir })
    await run('packed runtime closure', 'node',
      ['bin/native-runtime.mjs', 'check', '--root', path.join(packDir, 'package'), '--platform', TARGET])
  }

  // The assertions. Failures here are the point of the script, not a detail of it.
  if (!(typeof manifestChecks === 'number' && manifestChecks >= MANIFEST_CHECK_FLOOR)) failures.push(`manifest checks: expected at least ${MANIFEST_CHECK_FLOOR}, got ${manifestChecks ?? 'none reported'}`)
  if (!summary.reported) failures.push('no suite summary line; the runner did not finish')
  if (summary.failed > 0) failures.push(`the runner reported ${summary.failed} failing suite(s); see its output above for the check names`)
  // A suite that stopped being collected, or a file that stopped being discovered, still exits 0.
  const discovered = summary.reported ? summary.passed + summary.skippedCount : null
  if (discovered !== null && summary.failed === 0 && discovered !== EXPECTED_SUITES) failures.push(`the runner discovered ${discovered} suite(s); ${EXPECTED_SUITES} test file(s) are on disk (a suite that stops being collected still exits 0)`)
  if (verify.code !== 0 && stepFailures.length === 0) failures.push(`the verification step exited ${verify.code}`)
  const unexpected = summary.skipped.filter(name => !ALLOWED_SKIPS.includes(name) && !EXTERNAL_SUITE_DEPS.includes(name))
  if (unexpected.length > 0) failures.push(`suites skipped that must not skip on ${TARGET}: ${unexpected.join(', ')} (a skip is not a pass)`)
  if (summary.reported && summary.skippedCount !== summary.skipped.length) failures.push(`the runner counted ${summary.skippedCount} skip(s) but ${summary.skipped.length} were named`)

  const result = {
    host: HOST,
    target: TARGET,
    manifestChecks,
    suitesPassed: summary.passed,
    suitesFailed: summary.failed,
    suitesSkipped: summary.skipped,
    allowedSkips: ALLOWED_SKIPS,
    failures,
    steps: steps.map(({ title, command, code }) => ({ title, command, code })),
  }
  if (JSON_OUT) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  else {
    process.stdout.write('\n=== summary\n')
    for (const step of steps) process.stdout.write(`  ${step.code === 0 ? 'ok  ' : 'FAIL'} ${step.title}\n`)
    process.stdout.write(`  ${summary.passed ?? '?'} suites passed${summary.failed === null || summary.failed === 0 ? '' : `, ${summary.failed} failed`}; skipped: ${summary.skipped.join(', ') || 'none'} (allowed: ${[...ALLOWED_SKIPS, ...EXTERNAL_SUITE_DEPS].join(', ')})\n`)
    process.stdout.write(`  manifest: ${manifestChecks ?? '?'}/${MANIFEST_CHECK_FLOOR} checks\n`)
    for (const failure of failures) process.stdout.write(`  FAIL ${failure}\n`)
  }

  if (failures.length > 0) { console.error(`\n${failures.length} assertion(s) failed`); process.exit(1) }
  process.stdout.write(`\n${TARGET}: gate green\n`)
}

main().catch(error => {
  console.error(`\n${error.message}`)
  if (!KEEP_GOING) {
    process.stdout.write('\n=== summary of the steps that ran\n')
    for (const step of steps) process.stdout.write(`  ${step.code === 0 ? 'ok  ' : 'FAIL'} ${step.title}\n`)
  }
  process.exit(error?.exitCode ?? 1)
})
