# Scripted acceptance benchmarks

中文：[基准门禁](基准门禁.md).

`node bench/cli.mjs gates` runs the BM-01–05 scenarios through the pinned DSH `0.2.0-rc.2` AgentLoop, Session, tool dispatch and authority services. A deterministic provider selects the calls; no paid model or network model request is made. The suite measures tool behavior, text and round counts, not model quality or billing tokens. It is opt-in and is not part of the default functional gate.

```console
npm ci --ignore-scripts
npm run build
npm run build:ptc
node bench/gates/prepare-baseline.mjs baseline-031
cargo build --release --locked --manifest-path baseline-031/native/Cargo.toml
node bench/cli.mjs gates --baseline-source baseline-031 --baseline-worker baseline-031/native/target/release/dsh-ops-worker --output benchmark-gates.json
```

On Windows append `.exe` to the baseline worker. To measure the complete Bash surface, first install an optional fixture into a dedicated temporary `DSH_HOME` with `node bin/dsh-ops.mjs bash-runtime install`, then set `DSH_OPS_TEST_BASH` to its validated absolute executable (the release gate uses the same fixture API). The benchmark records this explicit selection; it changes no schema options. A fresh home without an installed Bash correctly blocks BM-03 instead of counting only the file schemas. The manual workflow acquires this fixture explicitly. Use a new output filename for each run. The command refuses to overwrite either JSON evidence or its `.md` summary. It retains its exclusively owned temporary fixture directory for inspection. `--task BM-02` selects one gate; selected success never means that all five passed. Any failed or unavailable selected gate exits 1; malformed arguments or missing build inputs exit 2.

The manual `Opt-in OPS acceptance benchmarks` workflow runs the same command on Windows x64, Linux x64 and Apple Silicon, independently builds the baseline, and uploads both artifacts even when a gate fails. The functional CI and release matrix also cover macOS Intel (`darwin-x64`), but the opt-in benchmark sweep does not include it yet. It changes no default CI requirement and uses no model credentials.

## Fixed workloads and comparisons

| Gate | Evidence and criterion |
| --- | --- |
| BM-01 | Three files with 70/80/90 TypeScript lines, each requesting its first 50 lines, as declared in the issue prose. Compare one `read_files` call with separately named OPS 0.3.1 and pinned official `read` results. Canonical and emitted text must retain exactly the requested lines before measuring bytes. Report sequential three-round and parallel one-round baseline controls separately; report total provider requests including the final answer. The 40% acceptance gate uses OPS 0.3.x, pinned here to 0.3.1. Official-reader savings remain separately visible and do not gate acceptance. |
| BM-02 | Five distinct edits in one file, one successful submission, then two externally changed stale-CAS cases. Verify exact resulting bytes, all conflicts rejected, and no full-file echo. |
| BM-03 | Measure actual first provider schemas for the full default Native surface. Windows includes the published Bash contract with the real jobs service; absence blocks the gate. Count compact `name/description/parameters` JSON with exact `js-tiktoken@1.0.21`, `cl100k_base`. Keep whole startup messages separately. The approved ≤400 gate counts only resident file/discovery schemas. Bash stays loaded at startup; its schema and the complete default total remain separately reported. |
| BM-04 | A real one-page Helvetica/Flate PDF. No PDF schema initially; discovery request one must expose `read_pdf` in provider request two, without sibling visibility; then verify extracted text. Missing integrated PDF capability is blocked. |
| BM-05 | Real credential-fenced outside reads and workspace-escaping writes must return rejected, preserve files, and reveal no denied parent path or secret body. An ordinary OS-readable outside read is a separately labelled allowed control: the pinned host does not implement a blanket workspace read jail. |

BM-01 also always reports offsets 13/31/51 with 8 lines, plus 1-line, 32-line, 600-character-line and escaped Unicode/JSON sensitivities. The frozen fixture definitions, file hashes and fixture-source hash appear in evidence. There is no automatic workload selection to obtain a favorable threshold.

The checkout must contain the pinned 0.3.1 Git history before running the functional provenance test or preparing the benchmark baseline. For a shallow clone, run `git fetch --unshallow` first. The CI full-gate jobs, optional benchmark smoke, release gate and manual benchmark workflow fetch full history; missing baseline objects are a failure, never a skip.

The 0.3.1 baseline is commit `4b51b6333213c376c8b7c173c12f35b408fdec2d`. The preparation script materializes exact Git blobs without checkout newline conversion; provenance rechecks every `lib/` and `native/` blob and records the worker version and SHA-256. Binary reproducibility is not attested. The official comparator uses the installed, pinned host reader separately. The test-only jobs package `@deepseek-ai/dsh-jobs-local@0.2.0-rc.2` was published on 2026-09-29, more than seven days before addition; it is needed to measure the complete Bash schema.

## Confirmed acceptance scopes (2026-10-19)

The user confirmed OPS 0.3.x as BM-01's authoritative comparison and retained the original DSH reader as a separate comparison. BM-03 keeps Bash loaded at startup and applies the unchanged 400-token threshold to file/discovery schemas only. The full default schema total and startup message JSON remain visible. Exact inventory checks still block a missing Bash on Windows, even when the file/discovery subset fits the budget. No tool contracts, defaults, source text, workload or numerical thresholds are removed or relaxed.

The actual file/discovery definitions measure 242 tokens / 1,101 bytes. The previously captured complete Windows provider surface measures 660 tokens / 3,219 bytes; the different fixture order is 661 tokens with identical bytes. The complete surface does not fit 400 and is not described as doing so. A fresh integrated run is required for current acceptance; historical artifacts below keep their original verdicts.

## Honest limits and retained results

The earlier worker/renderer-only 3×8 probe recorded 2,256 baseline and 1,949 candidate bytes (13.608% reduction), with `modelRounds: null` and `hostAuthorityExercised: false`. This remains limited historical evidence.

The subsequent real AgentLoop primary case recorded 8,883 OPS 0.3.1 bytes, 5,457 official-reader bytes and 6,239 candidate bytes. Replaying those unchanged canonical receipts through the compact renderer gives 5,348 bytes: 39.795% below 0.3.1, still below 40%. The reviewed host rerun confirms those same byte counts and still fails the primary target.

The primary source lines alone occupy 4,320 UTF-8 bytes. Forty percent below the 5,457-byte official result requires at most 3,274.2 bytes, so that comparison cannot pass without source omission or compression even before path/revision/coverage labels. The report includes this numerical lower bound and an illustrative absolute-path/range label size; shared-base layouts can reduce the latter. Long source lines likewise prevent universal percentage savings. Output paths, host contracts and formatter revisions affect measured bytes, so all exact receipts remain attached.

## Historical Windows result (2026-10-19)

Candidate `02577ed140c16e1739bf2588172ee38d9370ec52` had a clean worktree, host `0.2.0-rc.2`, Node `25.2.1`, and the source-built worker SHA-256 `b29b8f130e109ec507d808b8a488d9461b08f28353222b41b40631cd062702b8`. The local worker used Cargo `1.99.0`; the manual CI workflow pins `1.97.1` and has not yet supplied cross-platform results.

| Gate | Result |
| --- | --- |
| BM-01 | Failed: 5,348 candidate / 8,883 OPS 0.3.1 / 5,457 official bytes; 39.795% and 1.997% reductions. Exact source lines retained. |
| BM-02 | Passed: five edits in one tool-bearing round; both stale-CAS cases rejected with exact file bytes preserved. |
| BM-03 | Failed: actual published order 660 tokens / 3,219 bytes with explicit validated optional Bash and real host jobs. The separately ordered schema fixture counts 661 tokens; byte totals agree. |
| BM-04 | Passed: PDF absent initially, available in provider request two after discovery, absent for the sibling, text verified. |
| BM-05 | Passed: credential reads and outside writes rejected, files unchanged, no denied parent-path or secret-body disclosure. |

The candidate uses one tool-bearing round plus the final response. Sequential comparators use three plus final; parallel comparator controls also use one plus final. The 8-line/1-line/32-line/long-line/Unicode sensitivities save 47.843%/55.768%/40.990%/7.560%/40.358% against 0.3.1; no universal percentage claim follows. A prior fresh-home run without optional Bash reported BM-03 blocked, never passed at 241 tokens.

The retained raw local artifact is `040-benchmark-final-pinned-bash.json` with SHA-256 `cc94fcb4f444a39858795ef9003553de54735eff128191f3037a21666db1de98`; its companion Markdown summarizes all gates. That historical run remains failed under its original criteria; the later scope decisions above do not rewrite its evidence.


## Reviewed complete rerun

Clean candidate `2865936` includes reversible source escaping and the independent integrity controls. Its retained local evidence is `040-benchmark-reviewed-complete.json`, SHA-256 `380ac6fbd392dd0f7805c03c66aa6ba9d88f88bcf4eb5a60ba01868f152488bb`. BM-01 remains 5,348/8,883/5,457 bytes; BM-03 remains 660 tokens/3,219 bytes in actual provider order. BM-02, BM-04 and BM-05 pass; all-five acceptance remains false.

The corrected Unicode sensitivity is 2,616 candidate / 4,185 OPS 0.3.1 / 2,469 official bytes: 37.491% below OPS and 5.954% above official (a −5.954% reduction). The older 40.358% result above belongs to non-injective escaping and is historical only. Whole startup message JSON is separately 788 tokens/3,293 bytes; it is not the tool-schema gate. The final versioned release candidate still needs its own rebuilt-worker rerun.

## Integrity checks after review

BM-03 now requires the exact resident file catalogue plus discovery (and the full Bash contract on Windows) before a token score can pass. Missing, duplicate or unexpected tools block the gate with a named reason. BM-05 also requires its ordinary outside-read control to succeed with exact text, and checks `CREDENTIAL_DENIED` / `POLICY_DENIED` with `effectState: none` for the denied probes. Native line checks independently decode the documented escapes, including literal backslashes; they no longer mirror the renderer. These integrity checks change no workload, default or numerical threshold; only the explicitly approved acceptance scopes above determine current verdicts. The result snapshot above remains historical evidence for its named commit; it is not reclassified as passing.

## Approved-scope validation

The clean implementation at `112e34e` passed all five gates on Windows through the real pinned host. BM-01 returned 5,321 bytes versus 8,883 for OPS 0.3.1: **40.099% reduction**, with all requested source intact. The official reader returned 5,457 bytes (2.492% reduction), reported separately. BM-02 retained both stale-CAS rejections; BM-04 and BM-05 retained activation isolation and authority controls.

BM-03 passed at **241 file/discovery tokens / 1,094 bytes**, while Bash remained resident. The full startup schema remained **660 tokens / 3,219 bytes**, reported separately. Removing only the redundant per-file notice label and terminal period saved 27 bytes across the fixed three-file task; revisions, continuation/EOF facts and the aggregate notice remain. Historical results above keep their original verdicts. Final release PR validation records the final candidate revision and evidence artifact.
