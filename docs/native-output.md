# Native output and tool-name audit

中文：[Native 输出](Native输出.md).

This audit concerns direct Native calls, not `run_code` SDK calls. Native rendering
does not change canonical values, PTC data, revisions, references, permissions or
search ordering. It does not add a tool, alias, schema or prompt section.

## Repeated facts

Search `complete` means the whole query is exhausted. `pageComplete` means the
requested page was captured, and `scanComplete` means traversal completed. Display
truncation is a fourth fact. These remain separate even when their booleans match.

- For glob and grep, legacy `matched` aliases `matchedObserved`; the latter remains.
  `matchedObserved` and `matchedTotal` retain their observed-versus-full-scan labels.
- For glob only, `total` duplicates `matchedTotal` after a complete scan. Grep
  `total` counts output rows, so it remains even when it equals the match count.
- `skippedFiles` appears once with scan diagnostics. Skip reasons, continuation,
  next offset, omitted rows and recovery guidance remain visible.
- `changed=0` is omitted only for successful glob/grep results. Failures, unknown
  effects, mutation receipts and nonzero values retain their applicable facts.
- A text inspection's `Lines first-last of total` heading already states its line
  count. Duplicate `lineCount` and identical `total` summaries are omitted. Hex
  headings do not state a line total and therefore keep these summaries.
- Failed searches retain their observed paths and scan diagnostics beside the
  error/effect guidance. They are not presented as mutation receipts.

`test/native-summary.test.mjs` compares identical canonical fixtures against UTF-8
text byte counts from `77cd34f9`. These are output sizes, not token or task gains:

| Fixture | Before | After |
| --- | ---: | ---: |
| Empty glob | 264 | 218 |
| Two glob paths | 280 | 234 |
| Paged glob | 298 | 252 |
| Glob scan gap | 317 | 290 |
| Short text inspection | 194 | 172 |
| Empty text inspection | 196 | 174 |
| Paged text inspection | 203 | 181 |

The suite also covers independent grep totals, hex, conflicting counts, scan
early-stop, display truncation, stale failures and unknown effects, and checks
that rendering never mutates canonical input.

## Tool names and the remaining host dependency

OPS routing already obtains names from `publicToolName()` and filters them against
the captured step's admitted definitions. `test/native-guidance.test.mjs` checks
those explicit call targets in assembled Native requests across readiness,
replacement hiding, dynamic selection, mode changes and unload.

The exact instruction “Use the read tool” belongs to the pinned host package
`@deepseek-ai/dsh-tool-fs` 0.2.2-rc.1: `applyReadTool()` registers prompt section
`tool:read` in `lib/index.js`. Its callback reads `ctx.tools.get("read", scope)`
without the captured `toolSet`. A conditional fallback can therefore exist in the
registry while the actual Native request admits only `ops_inspect_local_file`.
The test reproduces that mismatch with the real host plugin and records the
section's ownership. Correcting the host callback to honor current step admission
remains a host dependency of #866. OPS does not rewrite that third-party prompt or
modify the shared registry, and does not add a permanent name-mapping prompt.
