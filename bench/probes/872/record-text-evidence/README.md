# UTF-8 shell-record evidence

Baseline: #949, `755c83cb61bd7eeb27886cfabc5f5ead75182d22`. Both release
drivers use Rust 1.97.1; source/binary identities and the actual Windows host are
recorded in `provenance.json`. No profiling, single-line protocol, dynamic-fd or
runtime-source experiments are included in this implementation.

- `unicode-cwd-red.log`: the new real-resident cwd regression fails against the baseline.
- `resident-green.log`: all six final integrity checks pass with the new encoder,
  including combining/private-use Unicode, controls, quoting, binary output and
  the existing ownership/receipt checks.
- `validation.json`: full 13-step gate (753 Rust tests, 9 ignored child fixtures,
  265 JavaScript suites, 4 permitted skips, 92 manifest checks, packed closure),
  pinned formatting/clippy and final focused rerun. Full local gate log SHA-256:
  `558ef247c0c708abc614454a7acb082d9158a7725e8475fa3df84a9cf108f200`.
- `paired.json`: alternating-order empty/printf/4 KiB/16 KiB comparisons, with
  every call's exit, exact output, readiness and EOF checked. Samples: 300/100/30/20;
  preceding warmup pairs: 30/10/3/3. Nearest-rank percentiles.
- `shell-before.json`, `shell-after.json`: unchanged existing comparison harness,
  300 empty samples / 30 warmups, 100 printf samples, 256 MiB bulk arm retained.
- `scenario.json`: unchanged production-driver adaptation of the supplied
  106-operation model, one shared fixture, three samples per operation, both
  listing forms and both build formulas. All calls validated.

Reproduction from a built checkout:

```powershell
node bench/probes/872/record-driver.mjs BEFORE_DRIVER AFTER_DRIVER NIU REPORT
node bench/probes/872/scenario-driver.mjs BEFORE_DRIVER AFTER_DRIVER NIU REPORT
```

For the established `channel-wakeup-evidence/compare.mjs`, set `OPS_ROOT`,
`OPS_DRIVER`, `OPS_NIU`, `REPORT`, `ONLY_NIU=1`, `SAMPLES=300`, `WARMUP=30`,
and `BULK_MB=256`, then run once per arm. These reports retain the older harness's
stale MSYS/receipt-file prose: Niubash is a native Rust runtime; production uses
private named pipes. Its `bash --version` probe does not identify `niu.exe`.

The strong gain is for larger command records: 4 KiB p50 103.05 → 23.74 ms;
16 KiB 381.34 → 79.25 ms. The paired empty call remains 4.54 ms p50 / 5.80 ms
p95; the established harness independently measured 4.44/5.66 ms. Neither meets
the session budget. The plain-ls scenario is 13.713 → 13.366 s; ls-la is
45.880 → 45.103 s. Plain-ls plus two modeled 30 s builds is 73.713 → 73.366 s.
These remain above acceptance budgets. Large-payload results cannot replace the
scenario, full-host overhead, cold-start or same-machine Linux comparison.

The fixture differs from the missing original ZIP workspace. The supplied prose
and raw scenario totals disagree, and its missing-file read is invalid; the
existing scenario report keeps those limitations explicit. No WSL or end-to-end
acceptance is inferred from these Windows driver measurements.
