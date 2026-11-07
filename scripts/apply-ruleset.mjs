#!/usr/bin/env node
// One-shot, idempotent application of `.github/required-ci-ruleset.json` to the live repository.
//
// Why a script and not YAML: a ruleset — including the required status check and the merge queue —
// is repository administration, not repository content. It cannot be expressed in a workflow file,
// and only an account with the admin role can write it. This script makes that single admin action
// reviewable, repeatable and auditable instead of a series of clicks:
//
//   node scripts/apply-ruleset.mjs                 # dry run: show what would change
//   GH_ADMIN_TOKEN=… node scripts/apply-ruleset.mjs --apply
//
// The token is read from the environment and is never stored in the repository or in Actions
// secrets. `--apply` needs a classic token with `admin:repo` (or a fine-grained token with
// Administration: write); the dry run needs only read access to rulesets.
//
// `scripts/check-workflows.mjs` keeps the template honest offline; this script is the only thing
// that talks to the live API, and it is never run by CI.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const templatePath = path.join(root, '.github', 'required-ci-ruleset.json')
const api = process.env.GH_API_URL ?? 'https://api.github.com'
const repo = process.env.GH_REPO ?? 'T-Auto/dsh-ops'
const token = process.env.GH_ADMIN_TOKEN ?? process.env.GH_TOKEN
const apply = process.argv.includes('--apply')

const template = JSON.parse(await readFile(templatePath, 'utf8'))

function headers() {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
  }
}

async function call(method, url, body) {
  const response = await fetch(`${api}${url}`, {
    method,
    headers: headers(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${method} ${url} -> ${response.status}: ${text.slice(0, 600)}`)
  }
  return text === '' ? undefined : JSON.parse(text)
}

function stable(value) {
  return JSON.stringify(value)
}

// The fields that decide whether a merge is gated. A ruleset with the right name but the wrong
// branch set, bypass actors or required check is worse than no ruleset: it looks enforced.
function fingerprint(ruleset) {
  const status = ruleset.rules?.find((rule) => rule.type === 'required_status_checks')?.parameters
  return stable({
    target: ruleset.target,
    enforcement: ruleset.enforcement,
    bypass_actors: ruleset.bypass_actors,
    ref_name: ruleset.conditions?.ref_name,
    pull_request: Boolean(ruleset.rules?.some((rule) => rule.type === 'pull_request')),
    status_checks: status?.required_status_checks,
    strict: status?.strict_required_status_checks_policy,
    merge_queue: ruleset.rules?.find((rule) => rule.type === 'merge_queue')?.parameters ?? null,
    non_fast_forward: ruleset.rules?.some((rule) => rule.type === 'non_fast_forward'),
  })
}

const existing = await call('GET', `/repos/${repo}/rulesets`)
const match = existing.find((ruleset) => ruleset.name === template.name)
const before = match === undefined ? null : await call('GET', `/repos/${repo}/rulesets/${match.id}`)

process.stdout.write(`${repo}: ruleset "${template.name}" ${match === undefined ? 'MISSING (or hidden from this token)' : `id=${match.id}`}\n`)
if (existing.length === 0) {
  // The ruleset list is administration-scoped: a non-admin token gets an empty list even when a
  // ruleset is enforced. Say so instead of reporting a false MISSING that looks like an outage.
  process.stdout.write('note: the ruleset list is empty. Non-admin tokens see an empty list even when a ruleset\n' +
    '      is enforced; a `protected: true` branch is the tell. Run this with an admin token to see it.\n')
}
process.stdout.write(`desired fingerprint: ${fingerprint(template)}\n`)
process.stdout.write(`live fingerprint:    ${before === null ? '<none>' : fingerprint(before)}\n`)

if (!apply) {
  process.stdout.write('\ndry run: nothing written. Re-run with --apply and GH_ADMIN_TOKEN to upsert.\n')
  process.stdout.write('The merge queue is part of the payload: enabling it is the same write.\n')
  process.exit(0)
}

if (token === undefined) {
  throw new Error('--apply needs GH_ADMIN_TOKEN (an admin token); refusing to write anonymously')
}

const payload = {
  name: template.name,
  target: template.target,
  enforcement: template.enforcement,
  bypass_actors: template.bypass_actors,
  conditions: template.conditions,
  rules: template.rules,
}
if (before === null) {
  const created = await call('POST', `/repos/${repo}/rulesets`, payload)
  process.stdout.write(`created ruleset id=${created.id}\n`)
} else if (fingerprint(before) === fingerprint(template)) {
  process.stdout.write('ruleset already matches the template; nothing to update\n')
} else {
  await call('PUT', `/repos/${repo}/rulesets/${before.id}`, payload)
  process.stdout.write(`updated ruleset id=${before.id}\n`)
}

const after = await call('GET', `/repos/${repo}/rulesets`)
const live = after.find((ruleset) => ruleset.name === template.name)
if (live === undefined || live.enforcement !== 'active') {
  throw new Error('the ruleset is not active after the write')
}
const detail = await call('GET', `/repos/${repo}/rulesets/${live.id}`)
if (fingerprint(detail) !== fingerprint(template)) {
  throw new Error(`the live ruleset does not match the template:\n  live:    ${fingerprint(detail)}\n  desired: ${fingerprint(template)}`)
}
process.stdout.write(`verified: "${template.name}" is active and matches the template, merge queue included\n`)
process.stdout.write('merge queue takes effect on the next merge; expectations are recorded in docs/ci.md\n')
