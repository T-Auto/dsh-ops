# Bound shell-endpoint evidence

Baseline: #951, `e0947b28db6fb5e65e45a8552379a3fc7fd5f1d3`. Both release
drivers use Rust 1.97.1 and the same frozen Niubash runtime. This change binds
the session's three fixed private output/receipt names in bootstrap metadata,
removing their repeated transmission and byte-at-a-time reads from each call.
Each new command carries three records; generation-local capture, receipt,
actual writer EOF, Job, cancellation and spill handling retain their existing paths.

Evidence:

- `paired.json`: alternating-order empty/printf/4 KiB/16 KiB comparisons, with
  every call's exit, exact output, readiness and EOF checked. Samples:
  300/100/30/20; preceding warmup pairs: 30/10/3/3; nearest-rank percentiles.
- `shell-before.json`, `shell-after.json`: the unchanged established comparison
  harness, 300 empty samples / 30 warmups, 100 printf samples and 256 MiB bulk I/O.
- `scenario.json`: the unchanged production-driver adaptation of the supplied
  106-operation model, a shared 2,000-file fixture, exactly 100 copied files and
  65,536 read bytes; three validated samples per operation, both listing forms
  and both build formulas reported separately.
- `behavioral-red.log`: against the unchanged #951 build, the new malformed
  endpoint and startup injection assertions fail, as does refusal of legacy
  bootstrap before user evaluation (three checks in two suites).
- `resident-green.log`: all 58 checks pass across transport (17), admission (34)
  and real-resident integrity (7), including endpoint restoration, private
  session ownership, Unicode, receipt forgery, surviving jobs and unregistered
  output. The legacy-bootstrap mismatch resets and cleans up before user code.
- `provenance.json`: source/binary identities, source and normalized evidence
  hashes, environment and report summaries. `validation.json` records the
  completed release gate and lint results.

| Paired case | Before p50/p95 ms | After p50/p95 ms |
| --- | --- | --- |
| Empty | 4.39 / 5.47 | 3.51 / 4.38 |
| Printf | 4.78 / 6.31 | 3.82 / 5.06 |
| 4 KiB argument | 22.98 / 27.76 | 22.04 / 23.52 |
| 16 KiB argument | 79.15 / 87.05 | 77.44 / 87.24 |

The established harness independently measured empty p50/p95 4.30/5.32 →
3.52/4.43 ms, and printf 4.40/5.45 → 3.58/4.23 ms. Empty calls improve by
about 20% in the paired run but still miss p50 ≤1 ms / p95 ≤3 ms. The scenario
is 13.566 → 13.298 s with plain ls and 46.405 → 45.910 s with ls -la;
plain ls plus two modeled 30 s builds is 73.566 → 73.298 s. These remain above
acceptance budgets. Three samples per operation do not establish a material
overall improvement. File-operation p50/p95 (ms) remain above budget: grep
847.76/892.63, plain ls 79.84/86.61, copy100 287.22/303.22 and 64 KiB
read-and-count 43.58/53.40.

Reproduction from a built checkout:

```powershell
node bench/probes/872/record-driver.mjs BEFORE_DRIVER AFTER_DRIVER NIU REPORT
node bench/probes/872/scenario-driver.mjs BEFORE_DRIVER AFTER_DRIVER NIU REPORT
```

For `channel-wakeup-evidence/compare.mjs`, set `OPS_ROOT`, `OPS_DRIVER`,
`OPS_NIU`, `REPORT`, `ONLY_NIU=1`, `SAMPLES=300`, `WARMUP=30` and `BULK_MB=256`,
then run once per arm. The final paired and established runs were sequential,
before clippy and the full gate. Earlier exploratory reports with overlapping
checks are excluded. No profiling or runtime-source edits are present.

The existing comparison reports retain stale MSYS/receipt-file descriptions:
Niubash is a native Rust runtime, and production uses private named pipes. The
`bash --version` probe does not identify `niu.exe`. The original ZIP workspace
is missing; the supplied prose/raw scenario totals disagree, its first read
fixture is invalid, and the 0.48 ms prototype does not prove all production
guarantees. No full-host, cold-start or same-machine Linux acceptance follows
from these Windows driver measurements. Runtime pins and publication status
remain unchanged.
