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

import { readdirSync } from 'node:fs'
import { runPool, runSuite, testJobs } from './lib/suite-runner.mjs'
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
 * Full-payload Niubash suites include cold artifact setup and payload preparation.
 * Cold setup measured below 60s locally; allow 300s for CI, versus 120s for other suites.
 * An explicit positive environment budget wins.
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

let jobs
try { jobs = testJobs() } catch (error) {
  console.error(`dsh-ops test: ${error.message}`)
  process.exit(2)
}

const COLD_PAYLOAD_SUITES = new Set(['niubash-consumer.test.mjs', 'niubash-payload-integration.test.mjs',
  'niubash-preparation.test.mjs', 'niubash-security-host.test.mjs'])
// Measured Windows long tail: start expensive independent suites before the short tail.
const HEAVY = ['permissions', 'bash-ipc', 'niubash-preparation', 'niubash-security-host',
  'wsl-readonly', 'bin', 'niubash-payload-integration', 'release-tar-modes', 'prepack', 'ptc', 'file-operations']
const weight = suite => {
  const index = HEAVY.indexOf(path.basename(suite).replace(/\.test\.mjs$/, ''))
  return index === -1 ? HEAVY.length : index
}
selected.sort((a, b) => weight(a) - weight(b) || a.localeCompare(b))
const EXCLUSIVE = new Set([
  // Only prepack rebuilds shared lib/; other Niubash suites copy into their own DSH_HOME.
  'niubash-consumer.test.mjs',
])
const started = Date.now()
const durations = []
console.log(`dsh-ops test: ${selected.length} suites, ${jobs} worker(s); exclusive suites run afterwards`)

await runPool(selected, { jobs, exclusive: EXCLUSIVE, run: async suite => {
  const label = path.basename(suite)
  const result = await runSuite(suite, { cwd: root,
    env: bashFixture ? { DSH_OPS_TEST_BASH: bashFixture } : {},
    timeoutMs: SUITE_TIMEOUT_MS ?? (COLD_PAYLOAD_SUITES.has(label) ? 300_000 : 120_000) })
  const { status, timedOut, durationMs, output } = result
  durations.push({ label, durationMs })
  process.stdout.write(`\n=== ${label} (${(durationMs / 1000).toFixed(2)}s)\n${output}${output.endsWith('\n') || !output ? '' : '\n'}`)
  if (status === SKIPPED_EXIT && !timedOut) {
    if (requireRuntime && !isAllowedSkip(label)) {
      // A skip is the suite's way of saying "this environment cannot answer".
      // When the caller has said the runtime is required, that is a failure —
      // at both layers, so neither one alone can turn it back into a pass.
      failed += 1
      console.error(`--- ${label} skipped while DSH_OPS_REQUIRE_RUNTIME=1`)
      return
    }
    skipped += 1
    console.log(`--- ${label} skipped`)
    return
  }
  if (status !== 0 || timedOut) {
    failed += 1
    console.error(`--- ${label} exited ${status}${timedOut ? ' (timeout)' : ''}`)
  }
} })

console.log('\n10 slowest suites:')
for (const { label, durationMs } of durations.sort((a, b) => b.durationMs - a.durationMs).slice(0, 10)) {
  console.log(`  ${(durationMs / 1000).toFixed(2)}s ${label}`)
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
