# Concurrent channel-arming evidence

Baseline: #952, `968352644d9fec756d44a5a4e216af73ff0070f6`. Both drivers use
Rust 1.97.1 release builds and the same frozen stock Niubash. The candidate
dispatches a channel's four readers before waiting for their acknowledgments;
all connects still must be armed before the endpoint can be published.

- `paired.json`: unchanged `record-driver.mjs`, 300/100/30/20 alternating
  empty/printf/4 KiB/16 KiB pairs, 30/10/3/3 warmups, nearest-rank percentiles.
  Every exit status, exact output, cap, error state, reset and EOF is checked.
- `behavioral-red.log`: both new controlled-barrier regressions fail against
  serial dispatch, observing only reader 0 while it is held before connection.
- `process-green.log`: 53 tests pass, 6 explicitly ignored child fixtures.
  Both new regressions pass; the publication barrier and next pooled generation
  are checked after every held reader is released and joined.
- `provenance.json`: source, binary-report and normalization-aware log hashes.

| Case | Before p50/p95 ms | After p50/p95 ms |
| --- | --- | --- |
| Empty | 4.41 / 6.69 | 3.85 / 5.77 |
| Printf | 5.10 / 5.73 | 4.71 / 5.25 |
| 4 KiB record | 25.01 / 32.07 | 24.06 / 29.69 |
| 16 KiB record | 92.83 / 104.80 | 87.01 / 102.63 |

The approximately 13% empty-median gain still misses the 1 ms p50 and 3 ms
p95 targets. Measurements are from the same Ryzen 7 Windows host, not the
audit author's i9. No local build/test workload overlapped the paired run.
Instrumented profiling results are attribution only and excluded. This is a
production-driver boundary, not full host orchestration or cold-start acceptance.
No runtime pin or installed payload changed.

Reproduce from a built checkout with the same runtime and separate release
executables for the two revisions:

```powershell
node bench/probes/872/record-driver.mjs BEFORE_DRIVER AFTER_DRIVER NIU REPORT
node bench/probes/872/scenario-driver.mjs BEFORE_DRIVER AFTER_DRIVER NIU REPORT
```

The unchanged 106-operation scenario adaptation measured plain-ls totals
14.539 → 14.664 s, ls-la 52.652 → 54.386 s, and plain ls plus two modeled
30-second builds 74.539 → 74.664 s. Three samples per operation do not establish
a material overall improvement; every acceptance budget remains explicit.
The original fixture was absent from the supplied ZIP; this shared fixture
fixes 2,000 grep files, 100 copy files and a 65,536-byte read. Both listing
variants and both build formulas are reported separately in `scenario.json`.
The final scenario ran before the full gate, without concurrent builds/tests
or the archive inventory that overlapped an excluded earlier trial.
