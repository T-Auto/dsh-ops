# Review snapshot CLI

中文：[审阅快照](审阅快照.md).

Collect the P0 review evidence from #356 in one explicit command. This integration
adds no resident tools or file/PTC schema. It needs authenticated `gh` for
github.com and Git for the optional local merge probe.

```console
dsh-ops review snapshot --repo T-Auto/dsh-ops --prs 389,392 --base main --workflow ci.yml --checkout .
```

From a built source checkout, use `node bin/dsh-ops.mjs review snapshot ...`.
`--repo` and `--prs` are required. A request accepts 1–5 distinct positive PR
numbers, `--base` defaults to `main`, and `--workflow` defaults to `ci.yml` (another
workflow filename or numeric ID is accepted). Omit `--checkout` to collect only
GitHub evidence. The command does not install/authenticate `gh` or change a profile.

The JSON contains:

- PR author, state, draft/review status, size, exact head and PR base SHAs, fork
  repository and maintainer-edit permission.
- Up to 25 changed paths and dependency/workflow/schema/changelog risk flags.
  These flags are review hints, not findings; an incomplete file window is marked.
- Up to three closing issues, their assignees and possible claim comments from
  the last ten comments. A comment match carries author, excerpt and URL. It does
  not prove ownership; other timeline cross-references are not collected.
- The newest matching `pull_request` run for the exact head SHA and PR number,
  its event, attempt, URL and up to 50 job conclusions. A push or manual run is
  never substituted for PR validation.
- The current requested base SHA and its newest matching `push` run for the
  **same workflow**. This separates base evidence from PR evidence. It is not an
  aggregate verdict over other workflows, required checks or branch protection.
- A local merge result against that captured base SHA: `clean`, `conflicts` with
  paths, or `unknown` with a reason. It is a point-in-time probe, not merge approval.

## Bounds and unknown results

Reads are fresh on each invocation; identical reads only share a result within
that invocation. The CLI never reuses an old passing CI result for a changed
head. Run lookup examines at most 20 matching API results. Absent credentials,
missing runs, invalid responses, missing local commit objects, process failures
and timeouts remain explicit unknown evidence. Narrow file/issue/comment/job
windows are not represented as complete inventories.

Each subprocess has a 20-second deadline and 512 KiB collection ceiling, with a
120-second invocation signal. JSON output is capped at 64 KiB; if details exceed
it, the command retains PR identifiers and URLs, sets `outputTruncated` and asks
for fewer PRs. Exit 0 means the requested bounded snapshot was assembled without
missing required evidence. Exit 1 means partial evidence or invalid/unavailable
input; inspect the JSON. A completed snapshot can report failing CI. Neither exit
code certifies that a PR is safe to merge.

## Local merge isolation

`--checkout` names a local repository that already contains the captured commit
objects. No fetch, branch checkout, branch update, push or merge is performed in
it. The probe creates a temporary bare repository with an empty template, ignores
global/system Git config and inherited Git command overrides, and reads the
source object store through an alternate. It does not copy the source repository's
hooks or configured merge drivers. New merge objects go only into the temporary
store, which is removed afterward. Missing objects are reported as unknown; the
CLI does not fetch them automatically.

This slice implements the CLI-first P0 evidence snapshot discussed in #356. It
does not implement review-environment setup, baseline test runs, automatic claims,
CI waiting/log analysis, merge trains, schema probes or an optional review-tool
component. No review decision or GitHub mutation is automated.
