# PTC enhancement declaration-cost check (#170)

## What was measured

`test/ptc-cost.test.mjs` assembles the real pinned DSH 0.2.0-rc.2 host prompt and wire
schemas under native and PTC-only presentation. It records host-only,
file+shell, and file+shell+PTC enhancement stages. File/shell are held constant for
the enhancement delta. No tool or model request is executed by this probe.

Windows x64 / Node 24 local observation after #160/#171 fixes:

| Presentation | Added enhancement prompt characters/UTF-8 bytes | Added direct wire bytes |
| --- | ---: | ---: |
| native | 0 | 0 |
| PTC-only | 4671 | 0 |

These are **characters/bytes, not tokens**. The exact number is diagnostic rather
than a frozen gate; the test asserts isolation and reports the current delta.
The PTC-only wire remains `run_code`; batch/result are described inside its SDK.
Empty registered sections are excluded, matching rendering rather than counting
invisible separators. The test does not prove overall plugin overhead is zero.

Reproduce after building the native worker:

```console
node test/run.mjs ptc-cost
```

Set `DSH_OPS_PTC_COST_REPORT` to an absolute JSON path to retain stage hashes,
per-section sizes, environment and deltas. The worker must resolve, but is never
spawned by this assembly-only probe.

## Comparison with #145 / #148

- #145 reports reluctance to use OPS and slow output; this probe does not measure
  model choice, latency, completion rate or total token usage.
- #148 reports a historical +9462-character snapshot: 1948 file-routing, 4022 Bash
  description and 3492 Bash SDK characters. Those additions include file/shell;
  they are not a controlled on/off experiment for only batch/result enhancement.
  This experiment isolates that component but does not reproduce or invalidate
  the historical session snapshots.
- In PTC, nested tool results are already processed locally. Replacing N nested
  calls with one batch does **not automatically save model-context tokens**.
  Safety/audit/recovery are concrete benefits; net usage savings still require
  equal-task, equal-success comparisons with official PTC, including generated
  program length, returned summaries, retries and actual model usage/cache data.

## Default decision

The operator chose to keep PTC enhancement enabled, shell enabled on all targets,
and strict hiding opt-in. This is an explicit capability/default decision, **not**
a conclusion that enabling these tools guarantees token savings. Existing explicit
profile choices must not be overwritten.
