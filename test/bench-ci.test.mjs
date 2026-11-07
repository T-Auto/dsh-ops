/**
 * P15: the bench smoke is a measurement that lives outside the merge-gating workflow.
 *
 * `ci.yml` is now entirely gates — every job is in `CI required`'s `needs` and failure loop — so the
 * smoke would either have to gate a merge on harness noise or stay in a workflow that does not gate
 * anything. It lives in `benchmark-gates.yml`: dispatched by hand, and also scheduled monthly so the
 * harness is exercised without anyone remembering. The regression this suite exists to catch is the
 * smoke quietly moving back into `ci.yml` (or a `bench` dispatch input reappearing there), because
 * that is how a measurement becomes a merge gate.
 *
 * Three properties of the smoke itself are still asserted here, since a green run cannot show them:
 *
 * 1. it is not started by `push`, `pull_request` or `merge_group` from the gating workflow;
 * 2. it runs the deterministic, model-free comparison: `bench/cli.mjs tools` with the **same**
 *    worker binary on both sides, and asserts no duration anywhere;
 * 3. it uploads evidence under the names the repository already uses (`*-report`, `warn` when a run
 *    produced nothing to upload).
 *
 * @module dsh-ops/test/bench-ci
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { assert, test, report, PACKAGE_ROOT } from './lib/harness.mjs'

const readWorkflow = (name) => parse(fs.readFileSync(path.join(PACKAGE_ROOT, '.github', 'workflows', name), 'utf8'))
const ci = readWorkflow('ci.yml')
const bench = readWorkflow('benchmark-gates.yml')
const ciJobs = ci.jobs ?? {}
const benchJobs = bench.jobs ?? {}
const benchJob = benchJobs['bench-smoke']
// Shell line continuations are joined, so a reformatted command still matches: this suite pins what
// the smoke *runs*, not how the command is wrapped.
const benchRuns = (benchJob?.steps ?? [])
  .map((step) => String(step?.run ?? ''))
  .join('\n')
  .replace(/\\\r?\n\s*/gu, ' ')

await test('the gating workflow has no bench input and no bench job', () => {
  assert.equal(ci.on?.workflow_dispatch?.inputs, undefined, 'ci.yml: workflow_dispatch declares no inputs')
  assert.equal(ciJobs['bench-smoke'], undefined, 'ci.yml: the smoke does not live in the gating workflow')
  for (const [id, job] of Object.entries(ciJobs)) {
    assert.doesNotMatch(String(job?.if ?? ''), /inputs\.bench/u, `ci.yml: job ${id} is not gated on a bench input`)
  }
  assert.doesNotMatch(JSON.stringify(ci), /bench\/cli\.mjs/u, 'ci.yml: no job runs the benchmark harness')
})

await test('the smoke lives in the benchmark workflow, which never gates a merge', () => {
  assert.ok(benchJob, 'benchmark-gates.yml: declares the bench-smoke job')
  assert.equal(bench.on?.workflow_dispatch !== undefined, true, 'the smoke can be dispatched by hand')
  assert.equal(bench.on?.schedule !== undefined, true, 'the smoke is also scheduled, not only remembered')
  assert.equal(benchJobs['CI required'], undefined, 'the benchmark workflow exposes no required check')
  assert.doesNotMatch(JSON.stringify(bench), /CI required|ci-required/u, 'the benchmark workflow does not impersonate the gate')
  assert.ok(Number(benchJob['timeout-minutes']) > 0, 'the job bounds its runtime')
})

await test('the smoke drives the one CLI entry point with the same binary on both sides', () => {
  assert.match(benchRuns, /node bench\/cli\.mjs tools\b/u, 'the smoke goes through the single cross-platform entry')
  assert.match(benchRuns, /--baseline "\$worker" --candidate "\$worker"/u, 'both sides are the same staged worker')
  assert.ok(benchRuns.includes('runtime/${{ matrix.target }}/${{ matrix.worker }}'), 'each runner uses its own staged worker')
  assert.equal(benchJob['runs-on'], '${{ matrix.os }}')
  assert.deepEqual(benchJob.strategy.matrix.include, [
    { os: 'ubuntu-24.04', target: 'linux-x64', worker: 'dsh-ops-worker' },
    { os: 'windows-latest', target: 'win32-x64', worker: 'dsh-ops-worker.exe' },
    { os: 'macos-latest', target: 'darwin-arm64', worker: 'dsh-ops-worker' },
  ])
  assert.doesNotMatch(benchRuns, /bench\/cli\.mjs ab\b/u, 'the model-driven sweep is never run in CI')
  for (const flag of ['--max-ms', '--budget', '--threshold']) {
    assert.equal(benchRuns.includes(flag), false, `no timing gate in the smoke (${flag})`)
  }
})

await test('the smoke reruns the harness deterministic suites', () => {
  assert.match(benchRuns, /node test\/run\.mjs bench\b/u, 'the deterministic bench suites run in the smoke too')
})

await test('the smoke uploads report.md / run.json / panel.html when they exist', () => {
  const uploads = (benchJob.steps ?? []).filter((step) => String(step?.uses ?? '').startsWith('actions/upload-artifact'))
  assert.equal(uploads.length, 1, 'the smoke uploads exactly one artifact')
  const upload = uploads[0]
  assert.match(String(upload.with?.name ?? ''), /-report$/u, 'the name follows the tools-trial-report convention')
  assert.ok(upload.with.name.includes('${{ matrix.target }}'), 'parallel platforms never overwrite one another’s artifact')
  assert.equal(upload.with?.['if-no-files-found'], 'warn', 'a tools-only smoke makes no run.json and must not fail on that')
  assert.match(String(upload.if ?? ''), /always\(\)/u, 'evidence is uploaded even when the comparison is red')
  const paths = String(upload.with?.path ?? '')
  for (const name of ['run.json', 'report.md', 'panel.html']) {
    assert.ok(paths.includes(name), `the artifact path list includes ${name}`)
  }
  assert.match(paths, /bench\/runs\/\*\/DSH-OPS Benchmark Report\*\.md/u, 'the default stamped report name is globbed too, so a group-level report is not silently left behind')
})

await test('.gitignore keeps bench evidence and the operator overlay out of the repository', () => {
  const lines = fs.readFileSync(path.join(PACKAGE_ROOT, '.gitignore'), 'utf8').split(/\r?\n/u).map((line) => line.trim())
  assert.ok(lines.includes('bench/runs/'), 'bench/runs/ is ignored: a run is evidence, not source')
  assert.ok(lines.includes('bench/llm.patch.yml'), 'the per-operator overlay is ignored')
})

report('bench-ci')
