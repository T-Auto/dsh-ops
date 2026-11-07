#!/usr/bin/env node
/**
 * The gate runner: every `test/*.test.mjs` suite, one child process each, with
 * its own throwaway `DSH_HOME`.
 *
 * One process per file is what keeps the suites honest about global state — the
 * plugin reads `DSH_HOME`, the platform, and the tool registry from the process
 * it runs in — and a per-file home means a suite that provisions a runtime
 * cannot observe another suite's leftovers.
 *
 * THREE OUTCOMES, NOT TWO. A suite that cannot answer in this environment exits
 * with {@link SKIPPED_EXIT} (`skipSuite` in `test/lib/harness.mjs`) and is
 * counted as skipped, never as passed: a machine without a native worker build
 * must not be able to report a green runtime gate. `DSH_OPS_REQUIRE_RUNTIME=1` turns
 * such a skip into a failure here as well as in the suite, so the integration
 * job cannot silently lose the thing it exists to test.
 *
 * @module dsh-ops/test/run
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The exit code a suite uses to say "I skipped myself on purpose". Kept in step
 * with `SUITE_SKIPPED_EXIT` in `test/lib/harness.mjs`, which owns the protocol;
 * this runner deliberately imports nothing from the suites so that a gate can
 * still run when a suite's own dependencies cannot be resolved.
 */
const SKIPPED_EXIT = 77

const testDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(testDir, '..')

/**
 * The suites to run: every `*.test.mjs`, in name order, or the ones named on the
 * command line.
 * @returns {string[]} absolute suite paths.
 */
function suites() {
  const requested = process.argv.slice(2)
  const all = readdirSync(testDir)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
  const selected = requested.length === 0
    ? all
    : all.filter((name) => requested.some((filter) => name.includes(filter)))
  return selected.map((name) => path.join(testDir, name))
}

// Test homes stay isolated; only the explicitly acquired executable is shared read-only.
const bashFixture = process.platform === 'win32'
  ? (await import('../lib/shells/pinned.js')).pinnedBashExecutable({ file: process.env.DSH_OPS_TEST_BASH, required: false }) : undefined
const selected = suites()
if (selected.length === 0) {
  console.error('dsh-ops test: no suites matched')
  process.exit(1)
}

let failed = 0
let skipped = 0
const requireRuntime = process.env.DSH_OPS_REQUIRE_RUNTIME === '1'

/**
 * Suites whose skip says something about *this machine*, not about the runtime being absent: they
 * need an optional external checkout (`DSH_OPS_TUI_ROOT`, plus `DSH_OPS_TUI_WORKER` for the native
 * one). Naming them in `DSH_OPS_ALLOW_SKIPS` keeps them skips even under
 * `DSH_OPS_REQUIRE_RUNTIME=1`, whose whole point is to catch a *runtime* that is missing while a
 * build claims otherwise. Unset means "no exceptions", so the default stays strict.
 */
const allowedSkips = new Set((process.env.DSH_OPS_ALLOW_SKIPS ?? '')
  .split(',').map((name) => name.trim()).filter(Boolean))
const isAllowedSkip = (label) => allowedSkips.has(label) || allowedSkips.has(label.replace(/\.test\.mjs$/, ''))
/**
 * Full-payload Niubash suites include verified cold copies and a real 120s descendant deadline.
 * They need a 600s watchdog; other suites retain 120s. An explicit positive environment budget wins.
 */
const SUITE_TIMEOUT_MS = (() => {
  const raw = process.env.DSH_OPS_SUITE_TIMEOUT_MS
  if (raw === undefined || raw === '') return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`dsh-ops test: invalid DSH_OPS_SUITE_TIMEOUT_MS: ${raw}`)
    process.exit(2)
  }
  return value
})()

/**
 * A deadline is the environment's answer, not the suite's. Retrying a timeout once, when asked,
 * separates a loaded runner from a real regression; a logic failure is never retried, and every
 * retry prints, so a green summary still shows that it happened. Unset means "do not retry".
 */
const RETRY_TIMEOUTS = process.env.DSH_OPS_RETRY_TIMEOUTS === '1'

const COLD_PAYLOAD_SUITES = new Set(['niubash-consumer.test.mjs', 'niubash-payload-integration.test.mjs',
  'niubash-preparation.test.mjs', 'niubash-security-host.test.mjs'])
const started = Date.now()

/** Run one suite in its own process, with a throwaway DSH_HOME and a bounded deadline. */
async function runSuite(suite) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-ops-test-home-'))
  const label = path.basename(suite)
  const timeoutMs = SUITE_TIMEOUT_MS ?? (COLD_PAYLOAD_SUITES.has(label) ? 600_000 : 120_000)
  console.log(`\n=== ${label}`)
  const child = spawn(process.execPath, [suite], {
    cwd: root,
    env: { ...process.env, DSH_HOME: home, ...(bashFixture ? { DSH_OPS_TEST_BASH: bashFixture } : {}) },
    stdio: 'inherit',
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    console.error(`--- ${label} exceeded the ${Math.round(timeoutMs / 1000)}s suite deadline; stopping its owned process tree`)
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 })
    } else child.kill('SIGKILL')
  }, timeoutMs)
  const status = await new Promise(resolve => {
    child.once('error', error => { console.error(String(error)); resolve(null) })
    child.once('close', code => resolve(code))
  })
  clearTimeout(timer)
  removeHome(home)
  return { label, status, timedOut }
}

/**
 * Delete a suite's throwaway home, even if the suite left a deny ACE behind.
 *
 * A permission suite deliberately makes a directory unreadable or readonly, and on Windows that ACE
 * survives the process: `rmSync` then fails with EPERM and takes the whole run down with it. Reset the
 * tree's ACLs first, and never let cleanup failure fail a suite — the suite's own verdict already
 * happened.
 * @param home - the throwaway DSH_HOME directory.
 * @returns nothing.
 */
function removeHome(home) {
  try {
    rmSync(home, { recursive: true, force: true })
    return
  } catch { /* a deny ACE, a readonly file, or a handle that is still open */ }
  if (process.platform === 'win32') {
    const system32 = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32')
    spawnSync(path.join(system32, 'icacls.exe'), [home, '/reset', '/t', '/c', '/q'], { encoding: 'utf8' })
    spawnSync(path.join(system32, 'icacls.exe'), [home, '/grant', `${process.env.USERNAME}:(OI)(CI)F`, '/t', '/c', '/q'], { encoding: 'utf8' })
  }
  try { rmSync(home, { recursive: true, force: true }) } catch (error) {
    process.emitWarning(`left ${home} behind: ${error?.code ?? error}`)
  }
}

for (const suite of selected) {
  let { label, status, timedOut } = await runSuite(suite)
  if (timedOut && RETRY_TIMEOUTS) {
    console.error(`--- ${label} retrying once: that deadline was about the runner, not the suite`)
    ;({ label, status, timedOut } = await runSuite(suite))
    console.log(`--- ${label} ${timedOut ? 'timed out again' : `passed on the retry (exit ${status})`}`)
  }
  if (status === SKIPPED_EXIT && !timedOut) {
    if (requireRuntime && !isAllowedSkip(label)) {
      // A skip is the suite's way of saying "this environment cannot answer".
      // When the caller has said the runtime is required, that is a failure —
      // at both layers, so neither one alone can turn it back into a pass.
      failed += 1
      console.error(`--- ${label} skipped while DSH_OPS_REQUIRE_RUNTIME=1`)
      continue
    }
    skipped += 1
    console.log(`--- ${label} skipped`)
    continue
  }
  if (status !== 0 || timedOut) {
    failed += 1
    console.error(`--- ${label} exited ${status}${timedOut ? ' (timeout)' : ''}`)
  }
}

const seconds = Math.round((Date.now() - started) / 1000)
const passed = selected.length - failed - skipped
const skipNote = skipped === 0 ? '' : `, ${skipped} skipped`
if (failed === 0) {
  console.log(`\ndsh-ops test: ${passed} suite(s) passed${skipNote} in ${seconds}s`)
  process.exit(0)
}
console.error(`\ndsh-ops test: ${failed} of ${selected.length} suite(s) failed${skipNote} in ${seconds}s`)
process.exit(1)
