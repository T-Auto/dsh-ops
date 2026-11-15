# Concurrent metadata evidence

## Concurrent metadata and checked opens — 2026-11-15

Complete native scans now perform each existing directory-relative no-follow metadata query and eligible checked open together in the bounded eight-worker, 32-entry window. Results return in entry order. Content reads, hashing, byte/file accounting, exclusions and path checks remain unchanged; early-result queries remain serial. Failed metadata queries remain explicit scan gaps.

The unchanged search harness measured 20 alternating pairs after three retained first-touch/warmup pairs on the same 2,000-file, 62,890-byte corpus. Every canonical result matched and the corpus remained unchanged. Rust 1.97.1 release results on the Ryzen 7 6800HS Windows host (milliseconds):

| Query | Before p50 / p95 | After p50 / p95 |
| --- | --- | --- |
| exact | 747.93 / 947.96 | 585.66 / 656.57 |
| bounded | 30.26 / 33.37 | 30.03 / 33.04 |
| miss | 720.41 / 849.17 | 554.78 / 757.74 |
| glob | 227.45 / 256.54 | 228.24 / 261.10 |

The exact-scan median is about 22% lower; it still misses the 60 ms target. The partial bounded query cannot replace complete-scan acceptance. A deterministic barrier fails against serial metadata lookup (one held query instead of eight); the implementation passes, along with metadata-error and expired-scan regressions. The focused search suite passes 86 tests with one existing UNC helper ignored.

Shell controls use the **same frozen #955 driver in both arms**, so their differences are not attributed to this native-file change. Empty-command p50/p95: 3.34/4.22 and 3.32/4.47 ms. Plain-ls 106-op model: 14.777 and 13.791 s; ls-la: 48.084 and 48.084 s. Adding two modeled 30-second builds: 74.777 and 73.791 s. The original fixture is absent from the supplied ZIP; the shared fixture and three-sample scenario limitations remain explicit in the raw report. All shell, full-host/cold-start and Linux acceptance remains open.

[Raw samples, provenance and reproduction](./) preserve the evidence. No runtime pin, permissions or tool contracts changed.

Reproduce using Rust 1.97.1 release before/after workers and the unchanged harness:

```powershell
node bench/probes/872/checked-parent-evidence/make-corpus.mjs NEW_CORPUS
$env:DSH_OPS_PROFILE_SAMPLES = '20'
node bench/search-profile.mjs BEFORE_WORKER AFTER_WORKER CORPUS_ROOT
```

The separate reusable-worker-pool pilot did not improve the baseline and was discarded before this implementation. Full gate and CI receipts are recorded in the PR and issue #932.
