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

## Prompt-cache hit rate against task length

A two-session A/B on the same task ("read the workspace structure to depth 3 and
report every folder and file") measured the stock PTC row against the `ops` preset.
The `ops` run reported 91.12% cache-read-of-input against 95.33% for the control: a
4.21 pp deficit. Breakdown of that deficit, per step and in tokens:

| Source | Tokens | Share |
| --- | ---: | ---: |
| host `TOOLS_SDK` grew after `ops_load_sdk` | 56,726 | 2.18 pp |
| the batching notice was injected mid-prompt | 29,787 | 1.15 pp |
| cold start (control had a warm prefix, `ops` had none) | 25,871 | 1.00 pp |
| an AGENTS.md reload notice appended at the end | -2,345 | -0.09 pp |
| **total** | **110,039** | **4.23 pp** |

All three real contributors are one-off costs paid in the first three steps; the
remaining 19 steps ran at **95.95%**, above the control's 95.58% over its steady
steps. The `ops` run also spent 24.4% fewer input tokens and 9 fewer steps overall.

### Position, not size, prices a prompt edit

The same session contained its own control for this. The AGENTS.md reload notice was
3,668 characters and cost **zero** cache reads, because it was appended at the end of
the conversation. The batching notice was 248 characters and cost 29,787, and the SDK
declaration grew by 12,625 characters and cost 56,726, because both are inserted near
the middle of the system prompt. Every character after an edit point is re-read; the
15x larger text was free and the smaller ones were not.

### The deficit washes out as tasks get longer

Fitting each side's steady per-step prompt growth (4,423 characters for the control,
4,255 for `ops`) and amortising the fixed cost gives:

| Steps | Control | `ops` | Gap |
| ---: | ---: | ---: | ---: |
| 22 (measured) | 92.88% | 89.54% | -3.34 pp |
| 50 | 96.49% | 95.60% | -0.90 pp |
| 100 | 98.14% | 97.87% | -0.27 pp |
| 200 | 99.04% | 98.96% | -0.07 pp |

### Decision

The prompt layout is deliberately left as it is. Moving the notice to the tail would
recover about 1.15 pp; the 2.18 pp from `TOOLS_SDK` belongs to the host and cannot be
moved by this plugin. Both are rejected against the cost of changing a frozen prompt
structure for a deficit that disappears on any task longer than roughly 50 steps.
Making `read_files`/`glob`/`stat` resident instead of load-on-demand was measured as a
net loss: the declaration would add ~3,500 tokens to every step (~77,000 over the
measured run) to avoid one 56,726-token repricing.

Reproduce from a session export with two `usage` records per step: cache-read tokens
are `cacheReadTokens`, uncached input is `inputTokens`, and hit rate is
`cacheReadTokens / (cacheReadTokens + inputTokens)`. Drop each side's first three steps
before comparing steady state, and treat the lead-in as the fixed cost it is.

## Default decision

The operator chose to keep PTC enhancement enabled, shell enabled on all targets,
and strict hiding opt-in. This is an explicit capability/default decision, **not**
a conclusion that enabling these tools guarantees token savings. Existing explicit
profile choices must not be overwritten.
