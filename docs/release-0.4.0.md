# 0.4.0 release candidate

> 历史文档：描述 0.4.x 的七行/承载行布局。当前分支已改为单行 `dsh-ops`，新行为以[配置参考](配置参考.md)为准。


中文：[0.4.0 发布候选](0.4.0发布候选.md).

**Not released.** Version fields identify this candidate; they do not authorize a tag, npm publication
or a final merge. Functional CI and the five acceptance benchmarks are separate gates. The approved
BM-01 threshold is at least 40% fewer output bytes than OPS 0.3.x; the official reader remains a
separate comparison. BM-03 applies ≤400 tokens to file/discovery schemas while retaining Bash at
startup and reporting its cost and the full startup total separately. Final measured evidence is required.

## Implemented surface

The package declares seven stable rows: shell, file, PTC, discovery, panel, TUI and official-tool
replacement. Fresh file/PTC/discovery rows are on; shell is on for every supported platform;
panel/TUI/replacement are off. Existing named overrides and explicit switches survive restart. An enabled fresh panel starts
collection; legacy explicit capture:false remains inert. Turning it off stops queued filesystem work.

Native starts with read_files and discover_tools, plus a usable Bash (pinned payload on Windows, host Bash on POSIX). Advanced tools activate only in
the owning agent's next provider request. The PTC SDK catalogue contains 18 APIs: 15 file/document tools,
batch, result and load_sdk. The complete shared catalogue also includes bash and discover_tools (20 entries).
The SDK and Native projections expose separate typed/text outputs; catalogue membership is not startup
residency. Current scopes, allowed pools and permissions still govern publication and every call.

The one-shot Rust worker checks authority per call. Native text is bounded and uses reversible line
escaping; PTC returns typed Outcomes. References preserve source scan/page/capture completeness and do
not grant filesystem access. Same-content re-read suppression requires exact provider-input evidence;
retained message history alone is insufficient. See [re-read evidence](context-read-dedup.md).

All plugin source is strict TypeScript/TSX. The build rejects JavaScript under src, compiles to lib,
and preserves shipped .js paths. Repository scripts/tests may remain JavaScript; lib/runtime are build
artifacts. Follow [source-build instructions](CONTRIBUTING.md), not an unbuilt Git install.

## Document scope

| Tool | Supported scope | Main bounds and exclusions |
| --- | --- | --- |
| read_table | CSV/TSV lexical string cells; strict UTF-8 or BOM-consistent UTF-16LE/BE | 32 MiB input, 100000 data rows, 1 MiB/record, 1024 columns, 30 s. No XLS/XLSX, formula evaluation or type coercion. |
| read_docx | DOCX main-body paragraphs, including table coordinates | 32 MiB archive, 8 MiB main XML, 1 MiB/paragraph, 100000 paragraphs, 30 s. No binary DOC, macros, encrypted/ZIP64 archives, external fetch or disk extraction. Excludes layout, headers/footers, notes/comments and metadata. |
| read_pdf | PDF 1.3–1.7 classic-xref text layer; standard Helvetica/Courier/Times Type 1 with Standard/WinAnsi | 16 MiB input, 32 pages, 1 MiB/page/stream, 16 MiB decoded and 16 MiB processed streams, 30 s. No OCR, images, general layout, forms, custom/embedded/CID fonts, ToUnicode, encryption, incremental or object/xref streams. |

These are bounded readers, not general office/PDF converters. Unsupported later content retains safe
preceding complete records with an error and next action. Offsets cannot skip a physical scan gap.
Only a stable full scan yields total/revision; a complete displayed or stored page does not repair
incomplete source coverage. See [detailed document contracts](native-kernel.md).

## Operator changes

Bash is a Windows-only optional npm payload of the main package (installed automatically);
PowerShell stays with the host and is not an npm payload. Managed Bash install/removal and Git Bash
selection remain explicit repair paths. Windows restricted execution remains partially enforced and requires the
compatible pinned MSYS runtime; approval does not create missing confinement. Host PowerShell upgrade
previews the standard installation; execute explicitly, restart DSH, and review any custom pwshPath.

Built-in row forms persist validated settings through the host. Optional browser pages need the
explicit offline settings-profile migration because the pinned host loads its browser facet only
from a bare package carrier. The default legacy file row remains supported. The migration preserves
seven IDs/configs, makes backups and checks exact composition; disabling the carrier unloads custom
pages. Re-enable through the host row switch. See [configuration](configuration-reference.md).

## Issue #261 acceptance matrix

This maps the original 16-part plan to the integrated implementation. Named suites identify concrete
regressions and proof boundaries; they are not a claim that pending final CI or manual checks passed.
The detailed limits above and in linked contracts remain part of acceptance.

| Plan step | Implemented behavior and limits | Evidence / remaining decision |
| --- | --- | --- |
| 1 — Build | src → lib build and assets preserve published paths; source Git installs require a build. | build and packed-artifact gates; JavaScript migration allowance removed in step 16. |
| 2 — Contracts | One capability catalogue; typed Outcome, error/retry, coverage and reference contracts. | kernel-types, kernel-errors and schema checks; Native text and PTC data remain distinct. |
| 3 — Native projection | Numbered reversible source text, bounded receipts and explicit incomplete output; 64 KiB escaped display cap. | native-projection, native-line-encoding, native-ranges; no universal percentage saving. |
| 4 — Worker | Workspace crates and v1 bounded one-shot requests, authority rechecked per call. | Cargo workspace and protocol regressions; persistent IPC remains deferred to a separate security review. |
| 5 — Reads, edits, search | Up to 32 independent read ranges; atomic multi-edit within one file; honest search gaps/continuations. | file-batching-worker and search regressions; no cross-file atomic edit or complete total after a scan gap. |
| 6 — References/budgets | 10 MiB/result, 100 MiB/session; two active/eight waiting calls and 30-second worker ceiling; audit data separate. | result-references/spill/lifecycle, call-budget, native-result; permission-limited cleanup can leave invalidated temp blobs. |
| 7 — PTC | 18 typed SDK APIs, three resident entries; allowed pools and next-step loading independent of Native. | ptc-outcome/schema/sdk and progressive-loop; current frozen SDK cannot call queued APIs. |
| 8 — Discovery | Native allowed pool, always-loaded subset and 1–5 selections; owning agent's next request only. | discovery/composition and real AgentLoop BM-04; no filesystem permission grant. |
| 9 — Resident surface | read_files plus discover_tools, with a usable Bash (pinned payload on Windows, host Bash on POSIX); advanced tools absent initially. | Exact provider inventory; approved BM-03 gates the file/discovery subtotal at ≤400 and separately reports the full Bash-inclusive total. |
| 10 — Re-read evidence | Exact successful body in the latest completed ordinary provider request plus fresh file checks. | context-read-dedup/many with real replacement/projection; missing evidence restores full output. |
| 11 — Bash | Host approvals/jobs/subprocess, absolute executor, 120/600-second timing, optional managed/Git Bash. | shells-host/execution/manager; Windows confinement remains partial and runtime compatibility is mandatory. |
| 12 — PowerShell | No bundled payload or executor overlay; explicit standard host upgrade plan and execution. | Host runtime manager/transport regressions; no real operator installation performed; restart/custom-path review required. |
| 13 — Replacement | Opt-in read/glob/grep with exact OPS definition identity and readiness; read maps to inspect_local_file. | Real scoped mount/readiness regressions; write/edit replacement is excluded because CAS contracts differ. |
| 14 — Migration/settings | Seven stable rows, saved overrides, fresh defaults and physical panel stop; validated built-in forms. | platform-defaults, settings-host/UI/client/carrier/runtime and panel-stop; custom pages need optional offline carrier; real TUI requires a separate host. |
| 15 — Documents | Discoverable CSV/TSV, DOCX and restricted classic-xref PDF readers with honest safe prefixes. | table/docx/pdf worker+host suites and BM-04; unsupported formats/layout/OCR remain excluded, as detailed above. |
| 16 — Acceptance/release | Strict TS/TSX, versioned candidate, paired docs and separate opt-in BM-01–05 evidence. | Functional CI and benchmark acceptance remain separate; rerun all five gates under the explicitly approved criteria before final review. |

## Stacked review and staging rollout

The review PRs currently use predecessor branch bases to keep each diff bounded; they do not all
target release/0.4.0 directly. For example, [1/16](https://github.com/T-Auto/dsh-ops/pull/264)
targets release/0.4.0, [2/16](https://github.com/T-Auto/dsh-ops/pull/265) targets its toolchain branch,
and [14b/16](https://github.com/T-Auto/dsh-ops/pull/283) targets the 14a settings branch. The 15a–d
and 16a reviews continue from their preceding slice. PR number alone is not dependency order: part 13
was opened earlier, while its current base is part 12.

Maintainers review and integrate prerequisites into release/0.4.0 in plan/dependency order: 1;
2→3 and 4a→4b; then 5a→5b, 6a→6b→6c→6d, 7–13, 14a→14b, 15a→15b→15c→15d and 16a→16b→16c.
When prerequisites are present in staging, retarget the next review to the appropriate current base,
verify that its diff contains only the intended slice, and rerun required CI after any integration
change. Do not merge a successor into an obsolete predecessor merely because it remains the review
base. Keep shared history intact; this work does not merge maintainers' PRs.

Only after all required functional gates and approved acceptance criteria pass should maintainers
review release/0.4.0 → main as the final release PR. The operator explicitly approved OPS 0.3.x as the
authoritative BM-01 comparator, with the official reader reported separately, and the file/discovery
≤400-token BM-03 scope while keeping Bash at startup. The fixed lossless workload, full default tool
inventory, schema contracts and authority checks remain unchanged. The earlier full-scope failure
is retained below; it is not silently reclassified. A version bump, a ready PR or passing functional
CI alone does not authorize a tag/publication.

## Acceptance evidence

Apply the approved criteria above to each final candidate and retain all five gate results. The
following Windows snapshot predates the scope approval and compact per-file receipt refinement; it
is historical evidence, not a verdict for the updated candidate. It uses the fixed issue workload
and pinned host, not a universal speedup or provider-billing measurement. [Benchmark gates](benchmark-gates.md)
define reproducible commands, evidence provenance and current rerun status.

| Gate | Historical result before the approved refinements |
| --- | --- |
| BM-01 | Fail: 5348 candidate bytes versus 8883 OPS 0.3.1 bytes (39.795% reduction); official read 5457 bytes (1.997%). Requested source alone is 4320 bytes. |
| BM-02 | Pass: five edits in one tool-bearing round and both stale-CAS controls rejected. |
| BM-03 | Prior full-scope failure: actual provider order 660 tokens/3219 bytes, including Windows Bash and real jobs, exceeded the then-full ≤400 target. The approved file/discovery subtotal was 241 tokens/1094 bytes; catalogue order 661 describes the full surface in a different order. |
| BM-04 | Pass: PDF absent initially, available on the owning provider request after discovery, absent for a sibling, then executed. |
| BM-05 | Pass: credential-fenced reads and outside writes rejected without denied-path/content leakage; an ordinary permitted outside read is an explicit allowed control. |

The approved scope changes which BM-03 subtotal is compared with 400; it does not remove Bash from
startup or from the exact readiness inventory. Report the file/discovery score, Bash cost and complete
provider total together. A missing optional Bash fixture still blocks the Windows measurement.
The compact receipt removes only a repeated per-file `Notice: ` prefix and terminal period; full
revisions, continuation offsets, EOF/completeness and the aggregate notice remain. Requested source,
workload and schema/authority contracts are unchanged. Fresh results after these refinements must be
reported explicitly; historical failures alone neither pass nor fail the revised candidate.

Use the [manual acceptance checklist](manual-validation.md). This candidate does not merge PRs,
publish binaries or enable a disabled release workflow.

## Approved-scope result

The integrated implementation passed all five Windows benchmarks under the approved criteria: BM-01 **5,321 / 8,883 bytes, 40.099% reduction** against OPS 0.3.1 (official reader: 5,457 bytes, 2.492% separately); BM-03 **241 file/discovery tokens**, with startup Bash retained and **660 full schema tokens** reported separately. BM-02, BM-04 and BM-05 also passed. The release PR records exact final-candidate provenance and functional CI; the historical table above remains unchanged. These figures are measurements of the candidate commit at that time; the current assembly is authoritative only through the latest verify output.
