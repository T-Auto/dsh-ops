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
