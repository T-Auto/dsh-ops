/**
 * P15: the bench smoke is opt-in, non-blocking and self-describing.
 *
 * Three properties keep the smoke from becoming a gate, and a regression in any one of them is
 * invisible in a green CI run — which is exactly why they are asserted here instead of described:
 *
 * 1. it hangs off a `workflow_dispatch` **boolean input that defaults to false**, so `push`,
 *    `pull_request` and `merge_group` cannot start it;
 * 2. the aggregate `CI required` job neither names it in `needs` nor judges it in its failure loop:
 *    waiting on a non-blocking job would keep the required check pending until that job finished, so
 *    a `continue-on-error` job is not waited on at all (#316);
 * 3. it uploads evidence under the names the repository already uses (`*-report`, `warn` when a run
 *    produced nothing to upload) and asserts no duration anywhere.
 *
 * What it runs is the deterministic, model-free comparison: `bench/cli.mjs tools` with the **same**
 * worker binary on both sides. A model-driven sweep asserts a cost direction and must stay out of CI.
 *
 * @module dsh-ops/test/bench-ci
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { assert, test, report, PACKAGE_ROOT } from './lib/harness.mjs'

const ciText = fs.readFileSync(path.join(PACKAGE_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
const ci = parse(ciText)
const jobs = ci.jobs ?? {}
const input = ci.on?.workflow_dispatch?.inputs?.bench
const benchJobs = Object.entries(jobs).filter(([, job]) => String(job?.if ?? '').includes('inputs.bench'))
const [benchId, benchJob] = benchJobs[0] ?? []
// Shell line continuations are joined, so a reformatted command still matches: this suite pins what
// the smoke *runs*, not how the command is wrapped.
const benchRuns = (benchJob?.steps ?? [])
  .map((step) => String(step?.run ?? ''))
  .join('\n')
  .replace(/\\\r?\n\s*/gu, ' ')
const [, required] = Object.entries(jobs).find(([, job]) => job?.name === 'CI required') ?? []
const requiredScript = (required?.steps ?? []).map((step) => String(step?.run ?? '')).join('\n')

await test('the bench smoke is behind a manual, boolean, default-off input', () => {
  assert.ok(input, 'ci.yml: workflow_dispatch declares a `bench` input')
  assert.equal(input.type, 'boolean', 'a boolean cannot be turned on by a stray string value')
  assert.equal(input.default, false, 'the smoke is off unless a human asks for it')
  assert.ok(String(input.description ?? '').trim() !== '', 'the input explains what it turns on')
})

await test('exactly one job is gated on that input, and only workflow_dispatch can start it', () => {
  assert.equal(benchJobs.length, 1, 'one job owns the input, so the trigger surface is one place')
  assert.match(String(benchJob.if), /github\.event_name\s*==\s*'workflow_dispatch'/u, 'push and pull_request cannot start it')
  assert.equal(benchJob['continue-on-error'], true, 'a red smoke must not turn the run red')
  assert.ok(Number(benchJob['timeout-minutes']) > 0, 'the job bounds its runtime')
})

await test('"CI required" neither waits on nor judges the smoke', () => {
  assert.ok(required, 'ci.yml still exposes the aggregate "CI required" check')
  const needs = [].concat(required.needs ?? [])
  assert.equal(needs.includes(benchId), false, 'being in needs would keep the required check pending until the smoke finished')
  const loop = requiredScript.match(/for job in ([^;]+);/u)
  assert.ok(loop, 'the aggregate still has a blocking-job loop')
  assert.equal(loop[1].split(/\s+/u).includes(benchId), false, 'the smoke is not one of the blocking jobs')
  assert.doesNotMatch(requiredScript, new RegExp(`echo "${benchId}:`, 'u'), 'the aggregate has no result to print for a job it does not wait on')
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
