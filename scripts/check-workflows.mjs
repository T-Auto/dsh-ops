#!/usr/bin/env node
// Structural lint for this repository's workflows.
//
// `actionlint` is not installed on the runners this project uses, and the failure mode a CI review
// cannot see is the silent one: a workflow that stops running, or that quietly stops blocking a
// merge. These assertions are cheap, depend only on the repository's own `yaml`, and pin exactly
// the properties that branch protection and a merge queue rely on.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = join(root, '.github', 'workflows')
const notes = []
const failures = []
const check = (ok, message) => (ok ? notes.push(message) : failures.push(message))

// The blocking topology, in one place. Every job in `ci.yml` must be classified here; the
// aggregate check must wait on exactly the blocking set and its failure loop must judge exactly
// that set. `v0.5.0` shipped a red Windows leg because the leg could opt out of the gate; there is
// deliberately no way to add such a leg without failing this lint.
const EXPECTED_BLOCKING = [
  'validate-posix',
  'validate-macos-intel',
  'validate-windows',
  'tools-trial',
  'node-floor',
  'workflow-lint',
  'source-size',
  'rust-lint',
]
// A job that is not deterministic enough to gate a merge belongs in another workflow, not here.
const EXPECTED_NON_BLOCKING = []

// These entry points import generated lib modules. A fresh checkout must build before
// reaching them; the release gate and verify commands perform that build themselves.
function checkPluginBuild(file, jobs, ids) {
  for (const id of ids) {
    const commands = (jobs[id]?.steps ?? []).flatMap(step => String(step.run ?? '').split(/\r?\n/))
    let built = false
    const premature = []
    for (const command of commands) {
      if (/^\s*npm run (?:build|verify(?::release)?)(?:\s|$)/.test(command)
          || /^\s*node scripts\/verify-gate\.mjs(?:\s|$)/.test(command)) built = true
      const consumesPlugin = /^\s*(?:node (?:bin\/|scripts\/(?:tools-trial|validate-manifest|build-platform-packages)\.mjs|test\/run\.mjs|bench\/cli\.mjs)|npm run (?:build:|stage:|check:ptc-runtime|validate:manifest))/.test(command)
      if (consumesPlugin && !built) premature.push(command.trim())
    }
    check(built, `${file}: job ${id} builds the plugin directly or through verification`)
    check(premature.length === 0, `${file}: job ${id} builds before lib consumers (${premature.join('; ') || 'ordered'})`)
  }
}

const sorted = values => [...values].sort()
const sameSet = (left, right) => JSON.stringify(sorted(left)) === JSON.stringify(sorted(right))

const files = (await readdir(dir).catch(() => [])).filter((name) => /\.ya?ml$/.test(name)).sort()
check(files.length > 0, 'at least one workflow exists')

const workflows = new Map()
for (const file of files) {
  const text = await readFile(join(dir, file), 'utf8')
  let doc
  try {
    doc = parse(text)
  } catch (error) {
    check(false, `${file}: not valid YAML (${error.message})`)
    continue
  }
  workflows.set(file, { doc, text })
  check(doc !== null && typeof doc === 'object', `${file}: parses to a mapping`)
  check(doc?.on !== undefined, `${file}: declares triggers`)
  const jobs = doc?.jobs
  check(jobs && typeof jobs === 'object' && Object.keys(jobs).length > 0, `${file}: declares jobs`)
  check(doc?.permissions !== undefined, `${file}: declares top-level permissions`)
  check(!/permissions:\s*write-all/.test(text), `${file}: does not ask for write-all`)
  // `pull_request_target` runs a fork's code with this repository's token: nothing here needs it.
  check(!/\bpull_request_target\b/.test(text), `${file}: does not use pull_request_target`)
  for (const [id, job] of Object.entries(jobs ?? {})) {
    check(job?.['runs-on'] !== undefined, `${file}: job ${id} declares runs-on`)
    check(job?.['timeout-minutes'] !== undefined, `${file}: job ${id} bounds its runtime`)
  }
}

// One toolchain version, stated once: `native/rust-toolchain.toml` is the source and every
// workflow's `rustup toolchain install` must name the same channel.
const toolchain = await readFile(join(root, 'native', 'rust-toolchain.toml'), 'utf8').catch(() => '')
const channel = /channel\s*=\s*"([^"]+)"/.exec(toolchain)?.[1]
check(channel !== undefined, 'native/rust-toolchain.toml pins a channel')
check(/"rustfmt"/.test(toolchain) && /"clippy"/.test(toolchain), 'native/rust-toolchain.toml installs rustfmt and clippy')
if (channel !== undefined) {
  for (const [file, { text }] of workflows) {
    for (const install of text.matchAll(/rustup toolchain install\s+(\S+)/g)) {
      check(install[1] === channel, `${file}: rustup installs the toolchain pinned by native/rust-toolchain.toml (${channel})`)
    }
  }
}

// The validation workflow is the one branch protection points at, so its shape is pinned here.
const ci = workflows.get('ci.yml')
if (!ci) {
  check(false, 'ci.yml exists')
} else {
  const triggers = ci.doc.on
  check(triggers?.push !== undefined, 'ci.yml: runs on push to the protected branch')
  check(triggers?.pull_request !== undefined, 'ci.yml: runs on pull_request before a merge')
  check(triggers?.merge_group !== undefined, 'ci.yml: runs on merge_group, so a merge queue can use it')
  for (const event of ['push']) {
    check(triggers?.[event]?.branches?.includes('release/0.4.0'), `ci.yml: ${event} includes the 0.4.0 staging branch`)
  }
  check(triggers?.pull_request?.branches === undefined && triggers?.pull_request?.['branches-ignore'] === undefined,
    'ci.yml: pull_request has no target-branch filter, including stacked PRs')
  check(triggers?.pull_request?.paths === undefined && triggers?.pull_request?.['paths-ignore'] === undefined,
    'ci.yml: pull_request has no path filter')
  const jobs = ci.doc.jobs ?? {}
  checkPluginBuild('ci.yml', jobs, ['validate-posix', 'validate-macos-intel', 'validate-windows', 'node-floor', 'tools-trial'])
  const entry = Object.entries(jobs).find(([, job]) => job?.name === 'CI required')
  check(entry !== undefined, 'ci.yml: exposes one aggregate check named "CI required"')
  if (entry) {
    const [id, job] = entry
    const others = Object.keys(jobs).filter((name) => name !== id)
    const classified = new Set([...EXPECTED_BLOCKING, ...EXPECTED_NON_BLOCKING])
    const unclassified = others.filter((name) => !classified.has(name))
    check(unclassified.length === 0, `ci.yml: every job is classified in EXPECTED_BLOCKING / EXPECTED_NON_BLOCKING (missing: ${unclassified.join(', ') || 'none'})`)
    const stale = [...classified].filter((name) => !others.includes(name))
    check(stale.length === 0, `ci.yml: the expected job list still exists (stale: ${stale.join(', ') || 'none'})`)
    // A blocking job opts out exactly by being listed as non-blocking: `continue-on-error: true`
    // is not accepted, because a job that may fail cannot gate a merge.
    const blocking = others.filter((name) => EXPECTED_BLOCKING.includes(name))
    const nonBlocking = others.filter((name) => EXPECTED_NON_BLOCKING.includes(name))
    const waiting = blocking.filter((name) => jobs[name]?.['continue-on-error'] === true)
    check(waiting.length === 0, `ci.yml: no blocking job sets continue-on-error (opted out: ${waiting.join(', ') || 'none'})`)
    const escaped = nonBlocking.filter((name) => jobs[name]?.['continue-on-error'] !== true)
    check(escaped.length === 0, `ci.yml: every non-blocking job sets continue-on-error: true explicitly (implicit: ${escaped.join(', ') || 'none'})`)
    const needs = [].concat(job.needs ?? [])
    check(sameSet(needs, EXPECTED_BLOCKING), `ci.yml: "CI required" waits on exactly the blocking jobs (waits on: ${needs.join(', ') || 'none'})`)
    // Depending on a job is not judging it: a blocking job left in `needs` but dropped from the
    // failure loop would let the aggregate report success without reading its result. The loop's
    // job list must therefore be exactly the blocking set, in both directions.
    const scripts = (job.steps ?? []).map((step) => String(step.run ?? '')).join('\n')
    const loops = [...scripts.matchAll(/\bfor\s+job\s+in\s+([^\n;]+?)\s*;\s*do\b/g)]
    const loopJobs = loops.length === 1 ? loops[0][1].trim().split(/\s+/).filter(Boolean) : []
    check(loops.length === 1, 'ci.yml: "CI required" judges the blocking jobs in exactly one loop')
    const unjudged = EXPECTED_BLOCKING.filter((name) => !loopJobs.includes(name))
    const phantom = loopJobs.filter((name) => !EXPECTED_BLOCKING.includes(name))
    check(unjudged.length === 0 && phantom.length === 0, `ci.yml: "CI required" failure loop covers exactly the blocking jobs (unjudged: ${unjudged.join(', ') || 'none'}; not blocking: ${phantom.join(', ') || 'none'})`)
    check(job.if === 'always()', 'ci.yml: "CI required" runs even when a dependency fails, so the result is reported')
  }
}

// The ruleset template is what an admin one-shot applies to the live repository; the merge queue is
// part of the same write, so the template has to carry it or the gate is only half configured.
const ruleset = JSON.parse(await readFile(join(root, '.github', 'required-ci-ruleset.json'), 'utf8'))
check(ruleset.target === 'branch' && ruleset.enforcement === 'active', 'ruleset template enforces branches')
check(JSON.stringify(ruleset.conditions?.ref_name) === JSON.stringify({ include: ['refs/heads/main', 'refs/heads/0.3.2', 'refs/heads/release/0.4.0'], exclude: [] }), 'ruleset template targets the three maintained branches')
check(Array.isArray(ruleset.bypass_actors) && ruleset.bypass_actors.length === 0, 'ruleset template has no bypass actors')
check(ruleset.rules.some(rule => rule.type === 'pull_request'), 'ruleset template requires a pull request')
check(ruleset.rules.some(rule => rule.type === 'merge_queue'), 'ruleset template enables the merge queue')
const statusRule = ruleset.rules.find(rule => rule.type === 'required_status_checks')?.parameters
check(statusRule?.strict_required_status_checks_policy === true, 'ruleset template requires validation against current base')
check(JSON.stringify(statusRule?.required_status_checks) === JSON.stringify([{ context: 'CI required', integration_id: 15368 }]), 'ruleset template requires CI required from GitHub Actions')

// The release path is deliberately secret-free and immutable (see its header); those promises are
// enforced, not documented, because a half-wired publish is worse than none. Each guard below has
// a name a reviewer can grep for, and deleting one fails this lint instead of shipping a release
// path that no longer refuses a moved tag or an unvalidated commit.
const release = workflows.get('release.yml')
if (release) {
  const text = release.text
  checkPluginBuild('release.yml', release.doc.jobs ?? {}, ['native', 'gate'])
  if (release.doc.jobs?.publish) {
    check(!/\$\{\{\s*secrets\./.test(text), 'release.yml: the gated publish path consumes no repository secrets')
  } else {
    notes.push('note: release.yml still carries the legacy npm publish path (`NPM_TOKEN`); #177 replaces it with a secret-free gated release')
  }
  check(/name: Refuse a moved tag/.test(text), 'release.yml: refuses a tag that was force-moved away from the built commit')
  check(/name: Require a green CI required check/.test(text), 'release.yml: requires a green CI required check on the tagged commit')
  check(/node scripts\/verify-gate\.mjs --skip-install/.test(text), 'release.yml: the release gate runs the same verify-gate as CI')
  check(/node bin\/check-release\.mjs/.test(text), 'release.yml: the release gate checks the release closure')
  // The comment above the publish step names `--clobber` to explain why it is absent; only the
  // commands matter, so assert on the publish job's run blocks rather than on the raw file.
  const publishRuns = (release.doc.jobs?.publish?.steps ?? []).map(step => String(step.run ?? '')).join('\n')
  check(!/--clobber/.test(publishRuns), 'release.yml: publishing is append-only (no --clobber)')
  check(/checks:\s*read/.test(text), 'release.yml: the gate may read the tagged commit\'s check runs')
}

// The bench smoke is a measurement, not a merge gate: it lives in the benchmark workflow and runs
// on a schedule. Keeping it there is what makes `ci.yml` free of non-blocking jobs.
const bench = workflows.get('benchmark-gates.yml')
check(bench?.doc.jobs?.['bench-smoke'] !== undefined, 'benchmark-gates.yml: carries the bench smoke')
check(bench?.doc.on?.schedule !== undefined, 'benchmark-gates.yml: schedules the measurement monthly')

for (const note of notes) console.log(`  ok   ${note}`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL ${failure}`)
  console.error(`\ncheck-workflows: ${failures.length} of ${notes.length + failures.length} check(s) failed`)
  process.exit(1)
}
console.log(`check-workflows: all ${notes.length} checks passed`)
