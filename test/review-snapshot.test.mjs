import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { reviewSnapshot, renderSnapshot, validateSnapshot } from '../lib/review/snapshot.js'
import { probeMerge } from '../lib/review/merge.js'
import { assert, test, report, withTempDir, PACKAGE_ROOT } from './lib/harness.mjs'

const BASE = '1'.repeat(40), HEAD = '2'.repeat(40)
const pr = () => ({ number: 12, title: 'Review fixture', url: 'https://github.com/example/project/pull/12', state: 'OPEN',
  isDraft: false, reviewDecision: 'REVIEW_REQUIRED', additions: 3, deletions: 1, changedFiles: 2,
  headRefOid: HEAD, baseRefOid: BASE, baseRefName: 'main', headRepository: { nameWithOwner: 'contributor/project' },
  maintainerCanModify: false, author: { login: 'contributor' },
  files: { nodes: [{ path: '.github/workflows/ci.yml' }, { path: 'package-lock.json' }], pageInfo: { hasNextPage: false } },
  closingIssuesReferences: { pageInfo: { hasNextPage: false }, nodes: [{ number: 4, url: 'https://github.com/example/project/issues/4',
    assignees: { nodes: [], pageInfo: { hasNextPage: false } }, comments: { pageInfo: { hasPreviousPage: false }, nodes: [
      { author: { login: 'contributor' }, body: 'I am taking this issue; scoped fix follows.', url: 'https://github.com/example/project/issues/4#comment' },
    ] } }] } })

function github({ metadata = pr(), missingRun = false, failure = false, jobCount = 1 } = {}) {
  const calls = []
  const runner = async (file, args) => {
    calls.push([file, ...args])
    assert.equal(file, 'gh')
    assert.deepEqual(args.slice(0, 3), ['api', '--hostname', 'github.com'])
    if (failure) return { code: 1, stdout: '', stderr: 'authentication unavailable' }
    const endpoint = args[3]
    let value
    if (endpoint.endsWith('/commits/main')) value = { sha: BASE }
    else if (endpoint === 'graphql') {
      const query = args.find(arg => arg.startsWith('query='))
      assert.equal([...query].filter(char => char === '{').length, [...query].filter(char => char === '}').length, 'GraphQL request must be balanced')
      value = { data: { repository: { pullRequest: metadata } } }
    }
    else if (endpoint.includes('/runs?')) {
      assert.ok(endpoint.includes('/actions/workflows/ci.yml/'), 'base and PR must compare the same workflow')
      const event = endpoint.includes('event=push') ? 'push' : 'pull_request', commit = event === 'push' ? BASE : HEAD
      value = { workflow_runs: [
        { id: 99, event: 'workflow_dispatch', head_sha: commit, created_at: '2026-10-25', conclusion: 'success', pull_requests: [{ number: 12 }] },
        { id: 98, event, head_sha: '3'.repeat(40), created_at: '2026-10-24', conclusion: 'success', pull_requests: [{ number: 12 }] },
        ...missingRun ? [] : [{ id: event === 'push' ? 10 : 20, event, head_sha: commit, status: 'completed',
          conclusion: event === 'push' ? 'failure' : 'success', name: 'Cross-platform validation',
          html_url: `https://github.com/example/project/actions/runs/${event === 'push' ? 10 : 20}`,
          run_attempt: 2, created_at: '2026-10-23', pull_requests: [{ number: 12 }] }],
      ] }
    } else if (endpoint.includes('/jobs?')) value = { total_count: jobCount, jobs: Array.from({ length: Math.min(jobCount, 50) }, () => ({ name: 'linux', status: 'completed', conclusion: endpoint.includes('/10/') ? 'failure' : 'success' })) }
    else throw new Error(`Unexpected endpoint ${endpoint}`)
    return { code: 0, stdout: JSON.stringify(value), stderr: '' }
  }
  return { runner, calls }
}

await test('snapshot separates base failure from exact PR-event evidence and preserves fork/claim facts', async () => {
  const { runner, calls } = github()
  const snapshot = await reviewSnapshot({ repo: 'example/project', prs: [12, 12] }, runner)
  assert.equal(snapshot.status, 'completed')
  assert.equal(snapshot.prs.length, 1)
  assert.equal(snapshot.base.ci.conclusion, 'failure')
  const row = snapshot.prs[0]
  assert.equal(row.ci.conclusion, 'success'); assert.equal(row.ci.event, 'pull_request'); assert.equal(row.ci.headSha, HEAD)
  assert.equal(row.ci.attempt, 2); assert.equal(row.ci.jobs[0].name, 'linux')
  assert.equal(row.headRepo, 'contributor/project'); assert.equal(row.maintainerCanModify, false)
  assert.equal(row.reviewDecision, 'REVIEW_REQUIRED')
  assert.deepEqual(row.risks, ['dependencies', 'workflows'])
  assert.equal(row.issues[0].claimStatus, 'possible_claim_comments')
  assert.match(row.issues[0].claims[0].excerpt, /taking/)
  assert.equal(row.merge.status, 'unknown'); assert.match(row.merge.reason, /No --checkout/)
  assert.equal(calls.filter(call => call.includes('graphql')).length, 1)
})

await test('missing runs, bounded evidence and API failures stay partial or unknown, never green', async () => {
  const missing = await reviewSnapshot({ repo: 'example/project', prs: [12] }, github({ missingRun: true }).runner)
  assert.equal(missing.status, 'partial'); assert.equal(missing.prs[0].ci.status, 'unknown')
  const metadata = pr(); metadata.files.pageInfo.hasNextPage = true
  metadata.closingIssuesReferences.nodes[0].comments.pageInfo.hasPreviousPage = true
  const bounded = await reviewSnapshot({ repo: 'example/project', prs: [12] }, github({ metadata }).runner)
  assert.equal(bounded.status, 'partial'); assert.equal(bounded.prs[0].filesTruncated, true)
  assert.equal(bounded.prs[0].issues[0].truncated, true)
  const manyJobs = await reviewSnapshot({ repo: 'example/project', prs: [12] }, github({ jobCount: 51 }).runner)
  assert.equal(manyJobs.status, 'partial'); assert.equal(manyJobs.base.ci.jobsTruncated, true)
  assert.equal(manyJobs.prs[0].ci.jobsTruncated, true); assert.equal(manyJobs.prs[0].ci.jobs.length, 50)
  const failed = await reviewSnapshot({ repo: 'example/project', prs: [12] }, github({ failure: true }).runner)
  assert.equal(failed.status, 'partial'); assert.equal(failed.prs[0].status, 'unknown')
  assert.match(failed.prs[0].reason, /authentication/)
})

await test('invalid input is refused before subprocesses and oversized rendering retains recovery guidance', async () => {
  let called = false
  await assert.rejects(reviewSnapshot({ repo: '../../outside', prs: [12] }, async () => { called = true }), /owner\/name/)
  assert.equal(called, false)
  assert.throws(() => validateSnapshot({ repo: 'a/b', prs: [1, 2, 3, 4, 5, 6] }), /1–5/)
  assert.throws(() => validateSnapshot({ repo: 'a/b', prs: [0] }), /positive/)
  const snapshot = await reviewSnapshot({ repo: 'example/project', prs: [12] }, github().runner)
  snapshot.prs[0].title = 'x'.repeat(100_000)
  const output = renderSnapshot(snapshot)
  assert.ok(Buffer.byteLength(output) <= 64 * 1024)
  const bounded = JSON.parse(output)
  assert.equal(bounded.outputTruncated, true); assert.equal(bounded.prs[0].headSha, HEAD)
  assert.match(bounded.prs[0].omitted, /request fewer PRs/)
  const cli = spawnSync(process.execPath, [path.join(PACKAGE_ROOT, 'bin/dsh-ops.mjs'), 'review', 'snapshot', '--bad'], { encoding: 'utf8' })
  assert.equal(cli.status, 1); assert.equal(JSON.parse(cli.stdout).status, 'failed')
})

await test('isolated merge probes cannot invoke source/global drivers or mutate source objects and refs', async () => {
  await withTempDir('review-merge', async root => {
    const source = path.join(root, 'source.git'), empty = path.join(root, 'empty'), template = path.join(root, 'template')
    fs.writeFileSync(empty, ''); fs.mkdirSync(template)
    const env = { ...process.env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: '1' }
    const git = (args, input) => {
      const result = spawnSync('git', args, { env, input, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      return result.stdout.trim()
    }
    git(['init', '--bare', `--template=${template}`, source])
    const inRepo = (args, input) => git(['--git-dir', source, ...args], input)
    const blob = value => inRepo(['hash-object', '-w', '--stdin'], value)
    const attributes = blob('file.txt merge=hostile\n')
    const commit = (value, parent) => {
      const tree = inRepo(['mktree'], `100644 blob ${attributes}\t.gitattributes\n100644 blob ${blob(value)}\tfile.txt\n`)
      return inRepo(['hash-object', '-w', '-t', 'commit', '--stdin'], `tree ${tree}\n${parent ? `parent ${parent}\n` : ''}author Fixture <fixture@example.test> 1 +0000\ncommitter Fixture <fixture@example.test> 1 +0000\n\nfixture\n`)
    }
    const base = commit('base\n'), ours = commit('ours\n', base), theirs = commit('theirs\n', base)
    inRepo(['update-ref', 'refs/heads/fixture', ours])
    const marker = path.join(root, 'driver-ran'), script = path.join(root, 'driver.mjs')
    fs.writeFileSync(script, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'unsafe');`)
    const driver = `"${process.execPath.replaceAll('\\', '/')}" "${script.replaceAll('\\', '/')}"`
    inRepo(['config', 'merge.hostile.driver', driver])
    const before = inRepo(['count-objects', '-v']), refs = inRepo(['show-ref'])
    const previous = process.env.GIT_CONFIG_COUNT
    process.env.GIT_CONFIG_COUNT = '1'; process.env.GIT_CONFIG_KEY_0 = 'merge.hostile.driver'; process.env.GIT_CONFIG_VALUE_0 = driver
    try {
      const clean = await probeMerge(source, base, base)
      assert.equal(clean.status, 'clean', JSON.stringify(clean))
      const conflict = await probeMerge(source, ours, theirs)
      assert.equal(conflict.status, 'conflicts', JSON.stringify(conflict)); assert.deepEqual(conflict.files, ['file.txt'])
      const absent = await probeMerge(source, ours, 'f'.repeat(40))
      assert.equal(absent.status, 'unknown'); assert.match(absent.reason, /not available locally/)
      assert.equal(fs.existsSync(marker), false, 'source and inherited custom drivers must never execute')
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_COUNT; else process.env.GIT_CONFIG_COUNT = previous
      delete process.env.GIT_CONFIG_KEY_0; delete process.env.GIT_CONFIG_VALUE_0
    }
    assert.equal(inRepo(['show-ref']), refs)
    assert.equal(inRepo(['count-objects', '-v']), before, 'only the isolated object store may receive merge objects')
  })
})
report('review-snapshot')
