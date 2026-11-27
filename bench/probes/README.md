# Issue probes

One-off measurement scripts for a specific reported performance issue. They are
not part of the default gate, they are not shipped, and each one answers a single
question that a shipped assertion cannot: "how much does this cost at N sessions".

Run them from a dsh-ops checkout after `npm run build && npm run build:ptc`, with
`DSH_HOME` pointed at a temporary directory (the same rule the test suites have):

```console
export DSH_HOME="$(mktemp -d)/dsh-home"   # bash
node bench/probes/probe-490-curve.mjs
```

## #490 — new-session latency grows with the open session count

`probe-490-curve.mjs` measures the number the fix is about: how many full prompt
assemblies one event costs as a function of live sessions, plus the wall clock.
It runs the real composition (real Cordis context, the published registry and
system-prompt assembly, the real native worker, the shipped `lib/`), so the curve
is what a host would see rather than a model of it.

Knobs: `PROBE_LIVE` (default `0,8,32,64,128,198`), `PROBE_TOOLS` (default 150),
`PROBE_REPEAT` (default 2), `PROBE_SCENARIO` (default `change,create-native,create-ptc`).

Scenarios:

| Scenario | What happens |
| --- | --- |
| `change` | one unattributed `tools/change` over the live set |
| `create-native` | register a tool, create a Native session, one unattributed change — the host's "new session" flow |
| `create-ptc` | the same, but the new session presents PTC |
| `create-only` | create the session and announce nothing else — the control that separates creation cost from change cost |

`probe-490-epoch.mjs` answers a narrower question that decides whether the PTC
deferral reaches the reported symptom at all: which host action emits
`system-prompt/change`? Its output shows that tool registration and session
creation emit only `tools/change`, and that a real `presentAs(mode)` flip is the
only thing that advances the re-derivation epoch.

`probe-490-surface.mjs` is the ruled-out half of a later measurement. It was
written to test the suspicion that `surfaceOf()` dominates the remaining
per-session cost, because rc's `schemas()` copies every visible `parameters`
through `snapshotJsonValue`. Running it disproves that: the surface read is about
0.03ms regardless of the live set, so the remainder sits in the publish loop.
Keep it as the record of that dead end, not as a live benchmark.

`probe-490-reentry.mjs` measures the fix for the first Native-to-PTC switch
directly. It wraps `prompt.assemble` to record every assembly's nesting depth and
whether it was one of this package's presentation probes, wraps `tools.sdkSection`
to count how often the resident SDK declarations are rendered, and prints one line
per transition:

| Label | What it measures |
| --- | --- |
| `native->native` | a steady Native request — the floor |
| `native->ptc` | the switch the issue reports: three probes and the request |
| `ptc->ptc` | a steady PTC request after the switch settled |

Before the fix the switch took seven assemblies with a nesting depth of four and
rendered the SDK declarations seven times; it now takes four at depth three and
renders them four times, and the final assembly carries
`harness:identity`, `tools:ptc-only`, `dsh-ops:repository-tooling:mode-ptc` and
`tools:sdk` with `run_code` as its only tool.

## #982 — one session scope, and examples that are not copyable twice

`probe-scope-guidance.mjs` runs every fenced `ts` example of one guidance file twice
inside one persistent REPL and reports which ones die on a redeclared top-level name.
The harness is Node's REPL with a retained context, the shape PTC evaluates in, so the
second run answers the only question the text controls: is a trajectory safe to copy
twice.

```console
node bench/probes/probe-scope-guidance.mjs prompts/batching-guidance.md
```

On the revision-10 text (0.5.7 plus the shared-scope section) it reports five examples
and **five** that are not copyable twice (`load`, `dirs`, `hits`, `stat`, `rows`). The
five examples are the same in both texts — 0.5.7 rewrote only their report call — and the
verified-edit trajectory now counts too, because it no longer needs top-level `await`
that this plain REPL cannot evaluate. The number is descriptive: any example with a
top-level `const` collides on its second run, and it documents the problem rather than
the effect of the section. It is never a gate.

`probe-scope-run.mjs` measures the effect the section is supposed to have. It drives one
model through one audit task with the same tool contract and one retained REPL per run,
varying only the guidance file, and scores every program the model writes:

```console
node bench/probes/probe-scope-run.mjs --guidance prompts/batching-guidance.md --steps 14 --json
```

The file is rendered for this probe's contract first (`__DSH_OUTPUT__(` becomes
`console.log(`), the way the host renders it, so the marker never reaches the model and a
missing marker cannot be scored as a failure. Measured 2026-11-27, `deepseek-v4.1-flash`
through the local gateway, eight runs per arm at fourteen steps, arms interleaved:

| arm | runs | programs | discarded by a redeclaration | rate |
| --- | --- | --- | --- | --- |
| 0.5.7 text (revision 9, no section) | 8 | 88 | 14 | 15.9% |
| revision 10 (with the section) | 8 | 111 | 6 | 5.4% |

Per run the baseline discarded 0, 1, 2, 3, 3, 2, 2 and 1 programs, the treatment
1, 0, 1, 0, 1, 1, 1 and 1; the discarded names were `body`, `files`, `load`, `mods`,
`out`, `paths`, `reads`, `srcDir`, `st`, `top` against `body`, `coreHits`, `first`,
`res`, `top`. Fisher's exact test puts the two-sided p at 0.018.

Three limits travel with that table. Neither arm finished the audit inside fourteen
steps (no run of either arm wrote `report.md`), so the numbers describe the first
fourteen programs, not a completed task. Two runs stopped early for reasons the probe
does not control — one baseline run replied at step one without a tool call (0 programs)
and another stopped after four — and they are counted as they fell rather than dropped.
And the unit is one model on one task: the rates are evidence that the rule changes what
the model does, not a percentage a user should expect.
