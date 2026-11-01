import { runCommand, type Runner } from './process.js'
import { probeMerge } from './merge.js'

export interface SnapshotInput { repo: string; prs: number[]; base?: string; workflow?: string; checkout?: string }
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const text = (value: unknown, limit = 160) => typeof value === 'string' ? value.slice(0, limit) : ''
const sha = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(value) ? value : ''
const nodes = (value: unknown) => array(object(value).nodes)
const mergeable = (value: unknown) => {
  const state = text(value).toUpperCase()
  return state === 'MERGEABLE' ? true : state === 'CONFLICTING' ? false : null
}
const more = (value: unknown) => Object.values(object(object(value).pageInfo)).some(value => value === true)
const QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
number title url state isDraft reviewDecision additions deletions changedFiles headRefOid baseRefOid baseRefName maintainerCanModify mergeable mergeStateStatus
author{login} headRepository{nameWithOwner} headRefName
files(first:25){nodes{path} pageInfo{hasNextPage}}
closingIssuesReferences(first:3){pageInfo{hasNextPage} nodes{number url assignees(first:5){nodes{login} pageInfo{hasNextPage}}
comments(last:10){pageInfo{hasPreviousPage} nodes{author{login} body url}}}}}}}`

export function validateSnapshot(input: SnapshotInput): SnapshotInput & { base: string; workflow: string } {
  if (input.repo.length > 200 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repo)) throw new Error('--repo must be owner/name on github.com')
  if (!Array.isArray(input.prs) || input.prs.length < 1 || input.prs.length > 5 || input.prs.some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error('--prs must contain 1–5 positive PR numbers')
  const base = input.base ?? 'main'
  if (!base || base.length > 200 || /[\x00-\x20]/.test(base)) throw new Error('--base must be a nonempty branch/ref without whitespace')
  const workflow = input.workflow ?? 'ci.yml'
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(workflow)) throw new Error('--workflow must be a workflow filename or numeric ID')
  return { ...input, prs: [...new Set(input.prs)], base, workflow }
}

/** Every request is fresh; memoization only shares identical reads within this invocation. */
export async function reviewSnapshot(input: SnapshotInput, run: Runner = runCommand) {
  const request = validateSnapshot(input), signal = AbortSignal.timeout(120_000)
  const memo = new Map<string, Promise<unknown>>()
  const api = (args: string[]) => {
    const key = JSON.stringify(args)
    if (!memo.has(key)) memo.set(key, (async () => {
      const result = await run('gh', ['api', '--hostname', 'github.com', ...args], { signal })
      if (result.code !== 0) throw new Error(result.stderr || 'GitHub read failed')
      const value: unknown = JSON.parse(result.stdout)
      if (array(object(value).errors).length) throw new Error('GitHub returned GraphQL errors')
      return value
    })())
    return memo.get(key)!
  }
  const ci = async (commit: string, event: 'push' | 'pull_request', pr?: { number: number; repo: string; branch: string }) => {
    if (!commit) return { status: 'unknown', reason: 'No verified head SHA.' }
    try {
      const response = object(await api([`repos/${request.repo}/actions/workflows/${request.workflow}/runs?event=${event}&head_sha=${commit}&per_page=20`]))
      const candidates = array(response.workflow_runs).map(object).filter(run => run.event === event && run.head_sha === commit)
      const runs = candidates.flatMap(run => {
        if (pr === undefined) return [{ run, association: 'event' }]
        const linked = array(run.pull_requests).map(object)
        if (linked.length) return linked.some(value => value.number === pr.number) ? [{ run, association: 'pull_requests' }] : []
        const repo = text(object(run.head_repository).full_name, 200).toLowerCase()
        const branch = text(run.head_branch, 255)
        return repo !== '' && pr.repo !== '' && pr.branch !== '' && repo === pr.repo && branch === pr.branch
          ? [{ run, association: 'head' }] : []
      })
      const latest = runs.sort((a, b) => text(b.run.created_at).localeCompare(text(a.run.created_at)))[0]
      if (!latest) return { status: 'unknown', reason: candidates.length
        ? `No run in the latest 20 results is verifiably associated with PR #${pr?.number ?? ''}; absence is not a pass.`
        : 'No matching run in the latest 20 results; absence is not a pass.' }
      if (!Number.isSafeInteger(latest.run.id)) return { status: 'unknown', reason: 'The matching run has no usable id; absence is not a pass.' }
      const jobs = object(await api([`repos/${request.repo}/actions/runs/${latest.run.id}/jobs?per_page=50`]))
      return { status: text(latest.run.status), conclusion: text(latest.run.conclusion) || null, event,
        headSha: commit, ...(pr === undefined ? {} : { association: latest.association }),
        name: text(latest.run.name), url: text(latest.run.html_url, 500), attempt: latest.run.run_attempt,
        coverage: 'latest matching run of the requested workflow; not aggregate branch health',
        jobsTruncated: Number(jobs.total_count) > 50,
        jobs: array(jobs.jobs).slice(0, 50).map(value => { const job = object(value); return {
          name: text(job.name, 100), status: text(job.status), conclusion: text(job.conclusion) || null,
        } }) }
    } catch (error) { return { status: 'unknown', reason: String(error instanceof Error ? error.message : error).slice(0, 500) } }
  }
  let baseSha = '', baseError = ''
  try { baseSha = sha(object(await api([`repos/${request.repo}/commits/${encodeURIComponent(request.base)}`])).sha) }
  catch (error) { baseError = String(error instanceof Error ? error.message : error).slice(0, 500) }
  const baseCi = await ci(baseSha, 'push')
  const [owner, name] = request.repo.split('/')
  const prs = []
  for (const number of request.prs) {
    try {
      const response = object(await api(['graphql', '-f', `query=${QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`]))
      const pr = object(object(object(response.data).repository).pullRequest)
      if (pr.number !== number || !sha(pr.headRefOid)) throw new Error('PR metadata or exact head SHA unavailable')
      const files = nodes(pr.files).map(value => text(object(value).path, 200))
      const headRepo = text(object(pr.headRepository).nameWithOwner)
      const risks = [files.some(file => /(?:^|\/)(?:package(?:-lock)?\.json|Cargo\.(?:toml|lock))$/.test(file)) && 'dependencies',
        files.some(file => file.startsWith('.github/workflows/')) && 'workflows',
        files.some(file => /schema|contract|capabilities|host-tool/.test(file)) && 'schemas',
        files.some(file => /CHANGELOG/i.test(file)) && 'changelog'].filter(Boolean)
      const issues = nodes(pr.closingIssuesReferences).map(value => {
        const issue = object(value), comments = nodes(issue.comments).map(object)
        const claims = comments.filter(comment => /\b(?:claim|taking|working on|i am handling)\b|认领/i.test(text(comment.body, 4000))).slice(0, 2)
        const assignees = nodes(issue.assignees).map(value => text(object(value).login, 80))
        return { number: issue.number, url: text(issue.url, 500), assignees,
          claimStatus: assignees.length ? 'assigned' : claims.length ? 'possible_claim_comments' : 'no_evidence_in_window',
          coverage: 'closing issues and last 10 comments only; not all timeline cross-references',
          truncated: more(issue.comments) || more(issue.assignees),
          claims: claims.map(comment => ({ author: text(object(comment.author).login, 80), url: text(comment.url, 500), excerpt: text(comment.body) })) }
      })
      prs.push({ number, title: text(pr.title), url: text(pr.url, 500), author: text(object(pr.author).login, 80), state: text(pr.state),
        draft: pr.isDraft === true, reviewDecision: text(pr.reviewDecision), headSha: sha(pr.headRefOid), prBaseSha: sha(pr.baseRefOid),
        prBaseRef: text(pr.baseRefName), headRepo, maintainerCanModify: pr.maintainerCanModify === true,
        githubMerge: { mergeable: mergeable(pr.mergeable), state: text(pr.mergeStateStatus, 40) },
        additions: pr.additions, deletions: pr.deletions, changedFiles: pr.changedFiles, files, filesTruncated: more(pr.files), risks,
        issues, issuesTruncated: more(pr.closingIssuesReferences),
        ci: await ci(sha(pr.headRefOid), 'pull_request', { number, repo: headRepo.toLowerCase(), branch: text(pr.headRefName, 255) }),
        merge: await probeMerge(request.checkout, baseSha, sha(pr.headRefOid), signal, run) })
    } catch (error) { prs.push({ number, status: 'unknown', reason: String(error instanceof Error ? error.message : error).slice(0, 500) }) }
  }
  const partial = !baseSha || baseCi.status === 'unknown' || ('jobsTruncated' in baseCi && baseCi.jobsTruncated) || prs.some(pr => 'status' in pr || pr.ci.status === 'unknown'
    || ('jobsTruncated' in pr.ci && pr.ci.jobsTruncated)
    || pr.filesTruncated || pr.issuesTruncated || pr.issues.some(issue => issue.truncated)
    || (pr.merge.status === 'unknown' && pr.githubMerge.mergeable === null))
  return { version: 1, status: partial ? 'partial' : 'completed', repo: request.repo, workflow: request.workflow, observedAt: new Date().toISOString(),
    base: { ref: request.base, sha: baseSha, ...(baseError ? { error: baseError } : {}), ci: baseCi }, prs,
    limits: { prs: 5, filesPerPr: 25, closingIssuesPerPr: 3, commentsPerIssue: 10, jobsPerRun: 50 },
    scope: 'P0 evidence snapshot; no approval, fetch, branch mutation, CI wait, or cross-PR merge train' }
}

export function renderSnapshot(value: Awaited<ReturnType<typeof reviewSnapshot>>) {
  let output = JSON.stringify(value)
  if (Buffer.byteLength(output) > 64 * 1024) {
    const bounded = { ...value, status: 'partial', outputTruncated: true, prs: value.prs.map(pr => 'headSha' in pr
      ? { number: pr.number, headSha: pr.headSha, url: pr.url, omitted: 'details exceeded 64 KiB; request fewer PRs' } : pr) }
    output = JSON.stringify(bounded)
  }
  return output
}
