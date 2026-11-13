# File contract validation (#855, #865, #866)

[中文](文件契约验收.md)

Baseline: `77cd34f9`, Windows x64, Node 26.12.1, pinned DSH packages
0.2.2-rc.1. These are deterministic contract checks, not model benchmarks.

## Separate mode measurements

`test/mode-contract-audit.test.mjs` captures the host-prepared request, its SDK
section and admitted methods. The same fixture ran in an isolated baseline
checkout. Official methods use fixed fixture descriptions; Bash and batching
teaching are disabled to isolate the file surface. Loaded means glob, grep and
read_files were selected through a real `run_code`, then called on the next step.

| Mode / stage | Prompt bytes before → after | SDK bytes before → after | Direct schema bytes before → after |
| --- | ---: | ---: | ---: |
| Original PTC without OPS | 2406 → 2406 | 2191 → 2191 | 1810 → 1810 |
| Original PTC with OPS, initial | 9456 → 9445 | 8932 → 8921 | 1810 → 1810 |
| Original PTC with OPS, loaded | 31793 → 33993 | 31269 → 33469 | 1810 → 1810 |
| ops-ptc, initial | 9456 → 9445 | 8932 → 8921 | 1810 → 1810 |
| ops-ptc, loaded | 31793 → 33993 | 31269 → 33469 | 1810 → 1810 |
| Native standard | 656 → 656 | 0 → 0 | 5141 → 5326 |

The loaded SDK grows because it now describes actual result rows instead of
generic JSON. The Native argument schema adds directory selection. Initial PTC
cost stays within the existing `prompt-budget` gate. These numbers establish
representation cost only; they do not establish task, token, latency or success
rate improvements. Native output fixture reductions are in [Native output](native-output.md).

## Admission and ownership

- Native standard admits OPS read/glob/grep replacements and omits their official
  counterparts. `edit` and `read_image` remain. Existing replacement tests cover
  readiness, captured steps, restrictions, same-name registrations and unload.
- Both built-in PTC modes intentionally configure **no file replacement targets**.
  Their SDK retains official read/glob/grep/edit methods alongside selected OPS
  methods. The audit executes both official and OPS glob as nested calls; the
  direct provider request still contains only `run_code`. This is preset policy,
  not a recurrence of #787's visible-but-rejected Native tool bug.
- Unloading the row restores the original surface. OPS-free PTC receives no OPS
  prompt or SDK. Disabled batching delivers no lesson or reminder, as covered by
  the batching lifecycle suite. Runtime version appears only in explicit diagnostics.

## Remaining host dependencies

#865 remains open for shared model-visible Outcome/page/reference declarations
and argument-correlated return types. The pinned host renders each output schema
independently and exposes no shared declaration hook. See [SDK loading](ptc-sdk-loading.md).

#866 remains open for the host filesystem plugin's `tool:read` instruction. Its
callback uses registry visibility rather than captured step admission; the real
host regression reproduces the stale name. OPS-owned explicit routing is checked
against callable Native names. See [Native output](native-output.md).

No host/profile rewrite, deployment, release, upstream issue or paid benchmark is
part of this change.
