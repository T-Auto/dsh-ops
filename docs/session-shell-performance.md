# Session shell performance work

中文：[会话Shell性能](会话Shell性能.md). Tracking: #872; baseline: PR #933,
`06c22a65b93e89d3a452724dc0a2e813f6b80af9`.

## Windows channel wake measurements — 2026-11-14

The acceptance target remains p50 ≤1 ms / p95 ≤3 ms. It is **not met**.
The first change signals pending connects when a channel is sealed. The second
also waits for reader thread handles instead of sleeping between join checks.
Both retain physical output drain, authenticated EOF, checked spill settlement,
and joining cancelled overlapped operations before releasing their buffers.

| Paired iteration | Baseline empty p50 / p95 | Candidate empty p50 / p95 | Baseline printf p50 / p95 | Candidate printf p50 / p95 |
| --- | --- | --- | --- | --- |
| Connect wake | 46.48 / 48.77 ms | 16.05 / 17.22 ms | 46.61 / 49.45 ms | 16.54 / 28.25 ms |
| Connect wake + reader handle wait | 46.33 / 51.10 ms | 9.04 / 10.30 ms | 46.64 / 117.02 ms | 9.48 / 13.10 ms |

Each baseline precedes its candidate sequentially on the same Windows x64 host:
Ryzen 7 6800HS, 15.2 GiB RAM, Node 26.12.1, Rust 1.97.1 release build. This is a
different host from the maintainer's i9-13900H. Empty calls use 300 samples after
30 warmups; printf uses 100 samples. Each complete run also includes the original
256 MiB bulk, pipeline and naive-payload workloads. No build or test ran alongside
the timing processes. Single paired runs do not establish tail stability; the
second baseline's printf tail is reported without filtering.

[Raw reports and runnable harness](../bench/probes/872/channel-wakeup-evidence/)
retain the source evidence. `compare.mjs` differs from the supplied harness only
by configurable executable paths and recording `OPS_DRIVER_SOURCE`. Set
`OPS_ROOT`, `OPS_NIU`, `OPS_DRIVER`, `OPS_DRIVER_SOURCE`, `REPORT`, `ONLY_NIU=1`,
`SAMPLES=300`, `WARMUP=30`, `BULK_MB=256`; run with Node. Build both drivers in
separate Cargo target directories. Shared target reuse initially produced an
identical baseline binary; that invalid candidate was discarded before measuring.

Exact executable SHA-256:

- Stock Niubash: `7ec3ec04ce91bae64c23d7150e6b16574e9d91df8fcf0df997006e2b37bf2f1e`.
- Baseline driver: `d311330e52aaec8eb9e352762be3304bfa3cc79638abd0e49fa7a82aaa0a3920`.
- Connect wake: `66aaa96ce4067d8409d7a6d336ff1296d2c11dec3ae9d6e7105ff1beb4f01bdd`.
- Connect wake + reader wait: `13e554dc3ac5cef0ea7f16ac94a1acd1b850abd211a2458a01997e5b158db4c2`.

The reports' `head` identifies the unchanged host checkout; `driverSource` and
`driverSha256` identify the native candidate. The inherited harness limitation
text is not authoritative architecture documentation: production uses private
named pipes, and equal host overhead across comparison arms has not been proven.
These timings exclude host orchestration and do not measure the 106-operation
scenario, cold startup, Linux, or full feature acceptance. Scenario totals for
these iterations remain **unmeasured**. Channel pooling and the driver completion
poll, prompt assembly and native-file duplicate I/O remain outstanding.

The attached audit's `scenario.out` totals (17.1923 / 120.6023 / 0.7497 s) disagree
with its prose (7.38 / 73.14 / 0.69 s). Its `suite.out` read test measures a missing
file; a corrective script is supplied without corrected results. Those numbers
must be reconciled before an end-to-end comparison can support acceptance.

## Directory metadata reuse — 2026-11-14

C1 removes the second, absolute metadata query for every visited entry. The held
directory's no-follow metadata already supplies symlink type and Windows reparse
attributes. Content opens and child-directory opens keep their existing checks.

The unchanged `bench/search-profile.mjs` alternated before/after order on one
2,000-file corpus: `file0.ts` through `file1999.ts`, each containing
`export const valueN = 'hit';` plus a newline. Total 62,890 bytes; corpus SHA-256
`de2bfa98c7e58d8203154462ef513fb88cf27fbab13d2b517d178ee10a31a3c3`.
There are three retained first-touch/warmup pairs and 20 measured pairs per query.
This supplemental native-worker benchmark includes one-shot startup and opt-in
profiling; it is not the attached shell scenario or its acceptance workload.

| Query | Before p50 / p95 | After p50 / p95 |
| --- | --- | --- |
| Exact grep | 2913.57 / 3076.74 ms | 2795.38 / 2961.94 ms |
| Bounded grep (5 files) | 32.11 / 39.47 ms | 32.28 / 38.86 ms |
| Missing pattern | 2858.60 / 3001.79 ms | 2750.02 / 2978.18 ms |
| Glob | 367.09 / 404.41 ms | 234.57 / 252.51 ms |

Every paired canonical result matched; the corpus remained unchanged. Complete
scans still perform 2,000 relative metadata queries, but no longer perform the
2,000 duplicate absolute queries. Bounded scans retain their original semantics;
they are not substituted for full-scan acceptance. Glob improves about 36%, while
exact grep improves only about 4%; per-file checked opens remain the next target.

[Raw report](../bench/probes/872/scan-metadata-evidence.json). Before worker SHA-256:
`1bb7a20ba597c45b6d761df8bc7dbc12fc255dc866ff2f84556d012a65f0d15c` (PR #944).
After: `35519ab12c0557325b4658756472edb79e35f0f1ed2032513295495c8188701a`.
Both are Rust 1.97.1 release builds on the Windows host above. Reproduce with
`DSH_OPS_PROFILE_SAMPLES=20 node bench/search-profile.mjs BEFORE AFTER CORPUS`.

The metadata-count regression fails on the before worker and passes on the after
worker. Directory-link/junction exclusion, coverage, early-exit, pagination,
multiline and definitions suites pass (30 checks). No full scenario, shell or
file-operation acceptance is claimed from these figures.

## Public presentation reuse — 2026-11-14

B1 reuses the final public presentation verdict already obtained during step
preparation. The cache is keyed by prompt service and exact agent identity;
public `system-prompt/change` and `tools/change` notifications invalidate it.
Execution still checks the admitted definition, owning scope and live grants.
An invalidated asynchronous probe cannot authorize execution or overwrite a new
verdict. Unobserved deployments fall back to a fresh public assembly. No private
executor API is used, and each new resolve still obtains its normal probe.

The supplemental `bench/probes/872/presentation.mjs` uses real Cordis, tool and
prompt services, a scoped PTC executor, step preparation and ten admitted SDK
loader callbacks per step. Its resident fixture refuses worker execution.
300 measured steps follow 30 retained warmups in each arm (before, then after),
on the Windows host above. All 3,000 callbacks per arm returned the same result;
both arms refused a retained callback after an executor change.

| Measurement | Before p50 / p95 | After p50 / p95 |
| --- | --- | --- |
| One loader callback | 13.39 / 18.12 ms | 0.42 / 0.80 ms |
| Step preparation | 15.49 / 22.28 ms | 15.61 / 20.24 ms |
| Preparation + ten callbacks | 153.17 / 181.22 ms | 20.31 / 25.79 ms |
| Assemblies per step, including probes | 12 | 2 |

[Raw samples and source hashes](../bench/probes/872/presentation-evidence/).
The before arm is PR #944; PR #945 has identical host source. The after arm is
the uncommitted presentation change over #945; `provenance.json` records exact
source hashes. Copy the same harness into each checkout's
`bench/probes/872/presentation.mjs`, build that checkout, then run
`node bench/probes/872/presentation.mjs ABSOLUTE_CHECKOUT_ROOT`. Each process must
start from that copy so host dependencies resolve from the measured checkout.

The integration regression fails on the before arm (11 probes instead of 1)
and passes after the change. It also checks same-step executor invalidation.
Unit cases cover scope separation, abort, observer disposal, public changes and
an old asynchronous probe finishing after a new verdict.

These figures exclude worker execution, `run_code` compilation, model work and
the shell. They do not prove the full orchestration SLO or shell acceptance.
The 106-operation scenario total for this iteration remains **unmeasured**.
