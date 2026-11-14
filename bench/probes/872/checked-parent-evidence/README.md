# Checked parent lookup evidence

This is a supplemental native-file measurement for #872, stacked on #948.
See the paired [English](../../../../docs/session-shell-performance.md) and
[Chinese](../../../../docs/会话Shell性能.md) explanations. It is not the supplied
shell scenario and does not establish session, orchestration or scenario acceptance.

- `profile.json`: unmodified final 20-pair report from `bench/search-profile.mjs`.
  Each query retains first-touch and two warmup pairs. Before/after order alternates,
  every canonical result agrees, and the shared corpus is unchanged.
- `provenance.json`: source, harness, corpus and measured worker identities;
  environment, nearest-rank p50/p95 summaries and measurement limits.
- `reparse-red.log`: removing only `OBJ_DONT_REPARSE` makes the real junction
  assertion fail because lookup follows the junction. Restoring it passes.
- `validation.json`: the full release-gate receipt and separate pinned Rust 1.97.1
  workspace/lint results. The gate's root Cargo default was 1.99.0, while runtime
  staging used 1.97.1. The final benchmarks explicitly use 1.97.1 in both arms;
  earlier mixed-compiler measurements are excluded.

Reproduce with release workers and the identified corpus:

```powershell
node bench/probes/872/checked-parent-evidence/make-corpus.mjs NEW_CORPUS_DIRECTORY
$env:DSH_OPS_PROFILE_SAMPLES = '20'
node bench/search-profile.mjs BEFORE_WORKER AFTER_WORKER CORPUS_ROOT
```

The corpus has 2,000 TypeScript files and 62,890 total bytes; its canonical content
hash is `de2bfa98c7e58d8203154462ef513fb88cf27fbab13d2b517d178ee10a31a3c3`.
The benchmark preserves each query's completeness fields. A bounded query is
deliberately partial and must not replace the full-scan target. The full exact
query still costs 1,779.48 ms p50; the 60 ms target remains open.

`shell-before.json`, `shell-after.json` and `scenario.json` retain the independent
shell recheck, with both drivers built using Rust 1.97.1 and unchanged shell
implementation sources. The 300-sample latency and modeled 106-op scenario remain
above their budgets. The unmodified comparison harness retains historical labels
in its limitations; artifact hashes, source provenance and the accompanying docs
identify these actual builds and the native Niubash engine.
