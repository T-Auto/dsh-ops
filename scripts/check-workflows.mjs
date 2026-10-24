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

// The validation workflow is the one branch protection points at, so its shape is pinned here.
const ci = workflows.get('ci.yml')
if (!ci) {
  check(false, 'ci.yml exists')
} else {
  const triggers = ci.doc.on
  check(triggers?.push !== undefined, 'ci.yml: runs on push to the protected branch')
  check(triggers?.pull_request !== undefined, 'ci.yml: runs on pull_request before a merge')
  check(triggers?.merge_group !== undefined, 'ci.yml: runs on merge_group, so a merge queue can use it')
  for (const event of ['push', 'pull_request']) {
    check(triggers?.[event]?.branches?.includes('release/0.4.0'), `ci.yml: ${event} includes the 0.4.0 staging branch`)
  }
  const jobs = ci.doc.jobs ?? {}
  checkPluginBuild('ci.yml', jobs, ['validate-posix', 'validate-macos-intel', 'validate-windows', 'node-floor', 'tools-trial', 'bench-smoke'])
  const entry = Object.entries(jobs).find(([, job]) => job?.name === 'CI required')
  check(entry !== undefined, 'ci.yml: exposes one aggregate check named "CI required"')
  if (entry) {
    const [id, job] = entry
    const needs = [].concat(job.needs ?? [])
    const others = Object.keys(jobs).filter((name) => name !== id)
    // A job blocks a merge unless it opts out explicitly with the literal boolean `true`. An
    // expression (`${{ ... }}`) is not accepted here: it cannot be evaluated statically, so it
    // would let a job look non-blocking to this lint while blocking in practice.
    const blocking = others.filter((name) => jobs[name]?.['continue-on-error'] !== true)
    const nonBlocking = others.filter((name) => jobs[name]?.['continue-on-error'] === true)
    const missing = blocking.filter((name) => !needs.includes(name))
    check(missing.length === 0, `ci.yml: "CI required" depends on every blocking job (missing: ${missing.join(', ') || 'none'})`)
    // Waiting on a non-blocking job is the same as blocking on it: the required check stays pending
    // until that job finishes, whatever its result, so the merge queue waits for the slowest leg.
    // The aggregate therefore neither needs nor reports such a job.
    const waited = nonBlocking.filter((name) => needs.includes(name))
    check(waited.length === 0, `ci.yml: "CI required" depends on no continue-on-error job (waited on: ${waited.join(', ') || 'none'})`)
    // Escape is explicit or not at all: a job outside the aggregate must say `continue-on-error:
    // true` itself. An `if:` that merely skips it on a pull request is the silent escape this check
    // exists to catch, so it does not count as non-blocking.
    const escaped = others.filter((name) => !needs.includes(name) && jobs[name]?.['continue-on-error'] !== true)
    check(escaped.length === 0, `ci.yml: every job outside the aggregate sets continue-on-error: true explicitly (implicit: ${escaped.join(', ') || 'none'})`)
    // Depending on a job is not judging it: a blocking job left in `needs` but dropped from the
    // failure loop would let the aggregate report success without reading its result. The loop's
    // job list must therefore be exactly the blocking set, in both directions.
    const scripts = (job.steps ?? []).map((step) => String(step.run ?? '')).join('\n')
    const loops = [...scripts.matchAll(/\bfor\s+job\s+in\s+([^\n;]+?)\s*;\s*do\b/g)]
    const loopJobs = loops.length === 1 ? loops[0][1].trim().split(/\s+/).filter(Boolean) : []
    check(loops.length === 1, 'ci.yml: "CI required" judges the blocking jobs in exactly one loop')
    const unjudged = blocking.filter((name) => !loopJobs.includes(name))
    const phantom = loopJobs.filter((name) => !blocking.includes(name))
    check(unjudged.length === 0 && phantom.length === 0, `ci.yml: "CI required" failure loop covers exactly the blocking jobs (unjudged: ${unjudged.join(', ') || 'none'}; not blocking: ${phantom.join(', ') || 'none'})`)
    check(job.if === 'always()', 'ci.yml: "CI required" runs even when a dependency fails, so the result is reported')
  }
}

// The release path is deliberately secret-free (see its header); that promise is enforced, not
// documented, because a half-wired publish is worse than none. The assertion is tied to the gated
// rewrite's `publish` job: the legacy file still names `NPM_TOKEN`, and #177 replaces that path, so
// pinning the *new* shape is what makes this check harden the moment the rewrite lands.
const release = workflows.get('release.yml')
if (release) {
  checkPluginBuild('release.yml', release.doc.jobs ?? {}, ['native', 'gate'])
  if (release.doc.jobs?.publish) {
    check(!/\$\{\{\s*secrets\./.test(release.text), 'release.yml: the gated publish path consumes no repository secrets')
  } else {
    notes.push('note: release.yml still carries the legacy npm publish path (`NPM_TOKEN`); #177 replaces it with a secret-free gated release')
  }
}

for (const note of notes) console.log(`  ok   ${note}`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL ${failure}`)
  console.error(`\ncheck-workflows: ${failures.length} of ${notes.length + failures.length} check(s) failed`)
  process.exit(1)
}
console.log(`check-workflows: all ${notes.length} checks passed`)
