# Flash small-scale comparison (V5)

English | [中文](Flash对照-V5.md)

Issue [#994](https://github.com/T-Auto/dsh-ops/issues/994), parent [#980](https://github.com/T-Auto/dsh-ops/issues/980). This is a
measurement card: the only repository additions are the measurement driver, the collector, this report pair and the
changelog entry. No product code, teaching copy or release logic changed.

## The preregistered question

The V5 card asks whether the **shorter first-round prompt** of the on-demand PTC disclosure tier trades for **more
calls or more failures**. The two arms therefore differ in exactly one preregistered factor — the `dsh-ops` row's
`disclosurePolicy` (`on-demand` vs `full`, implemented by #986/#987) — while the route, the reasoning effort, the
sandbox mode, the preset, the worker and the task fixtures stay frozen:

- route: `opencode-go` / `deepseek-v4.1-flash`, `reasoningEffort: high`
- preset: `ops-ptc` (the composed group proves it; a Standard fallback would be invalid per #980)
- sandbox: `danger-full-access`; platform: `linux-x64`
- tasks: `ptc-catalog-recover` (catalog search, needs the loadable `ops_grep`) and `ptc-wait-dispatch`
  (multi-layer config edit, needs `ops_read_files`/`ops_edit_file`) — the two V4 tracks whose working set is
  most sensitive to the tier
- plan: 2 tasks × 3 repeats × 2 arms, AB/BA interleaved per (task, repeat), 12 sessions; plus a same-condition
  A/A sweep (12 sessions, on-demand config twice) for the noise floor; every session ran in a fresh seeded
  workspace with a fresh composed group

## Why a driver instead of `bench ab`

The host's one-shot headless runner composes the host realm only and **refuses preset sessions by design** (its
adoption check: *"session … runs under agent preset …, which the one-shot runner does not compose"*). The plugin
treats a registry-less host realm as Standard, so an `ab` sweep would measure Standard and be invalid per #980.
`bench/v5-run.mjs` reuses the V1 isolated-entry composition (real AgentLoop, real PTC executor, real staged worker,
the shipped `dsh-ops` row) and replaces the scripted provider with the real `llm-pi-ai` adapter. One resolution
detail: `@deepseek-ai/dsh-llm-pi-ai` (and `@deepseek-ai/dsh-credentials`, plus a symlink for `@earendil-works/pi-ai`)
is copied into `node_modules` at run time so every import resolves through this checkout's tree and one `cordis`
instance serves the whole composition; `node_modules` is gitignored and no manifest changes. The driver archives
per session: raw events (`*.events.ndjson`), the judge-ready trajectory (`*.trajectory.json`), folded metrics
(`*.metrics.json`), the verified answer, and per arm `arms/<arm>/dump-config.txt`.

## Environment facts (recorded, not claimed)

| fact | value |
| --- | --- |
| plugin commit | `28c0cf7` on `card/v5-flash-comparison` = `main@58f6e28` + merged approved prerequisites (V1 entry + V4 tracks `card/v4-bench-tasks` @`ec4d25c`, the tested D2/D3 disclosure implementation `card/v3-two-tier-matrix` @`c68fe3d`) |
| host version | 0.2.2-rc.1 |
| platform | linux-x64, node v24.21.0 |
| worker | staged `runtime/linux-x64/dsh-ops-worker`, sha256 `2b5f988d9115…` |
| preset / route | `ops-ptc`; `{provider: opencode-go, model: deepseek-v4.1-flash, reasoningEffort: high}` |
| sandbox | danger-full-access, approval never (the composed group pins the mode; no approval service is mounted, tool failures are returned values) |

Per-arm evidence: `bench/runs/v5-comparison/arms/{ondemand,full}/dump-config.txt` and
`bench/runs/v5-aa/arms/{aa-one,aa-two}/dump-config.txt` — identical rows except the one
`disclosurePolicy` line.

## The complete denominator

| sweep | planned | completed | timed out | missing usage | verify pass |
| --- | --- | --- | --- | --- | --- |
| comparison (on-demand vs full) | 12 | 12 | 0 | 0 | 11 |
| A/A (on-demand twice) | 12 | 12 | 0 | 0 | 12 |
| **total** | **24** | **24** | **0** | **0** | **23** |

One comparison session failed the workspace verifier: `ptc-wait-dispatch` r2 on the on-demand arm wrote
`config/development.json` (it picked the wrong config layer); the session completed normally, so it stays in
both the completion and the pass denominator. No session timed out; every step of every session reported usage, so
no metric below is a lower bound. A pre-sweep smoke (2 sessions, `bench/runs/v5-smoke`) confirmed routing and
usage collection first and is not part of the preregistered denominator.

## Per-task results

Prompt sizes are tokens per model request (input + cacheRead + cacheWrite); totals are the sum over all steps of
one session, medians over the arm's three sessions.

### ptc-catalog-recover

| metric | on-demand | full | A/A band (same config twice) |
| --- | --- | --- | --- |
| verify pass | 3/3 | 3/3 | 3/3 – 3/3 |
| correct next steps | 26 | 17 | 23 – 24 |
| correction opportunities | 3 | 0 | 0 – 1 |
| no-progress retries | 5 | 4 | 5 – 7 |
| waits | 0 | 0 | 0 |
| first-round prompt (median) | 5,271 | 29,946 | 5,271 – 5,271 |
| prompt total (median) | 86,136 | 185,465 | 66,881 – 88,078 |
| input tokens (3 sessions) | 65,035 | 68,051 | 55,814 – 57,644 |
| cacheRead tokens (3 sessions) | 182,656 | 430,848 | 144,896 – 198,016 |

### ptc-wait-dispatch

| metric | on-demand | full | A/A band |
| --- | --- | --- | --- |
| verify pass | 2/3 | 3/3 | 3/3 – 3/3 |
| correct next steps | 8 | 8 | 14 – 27 |
| correction opportunities | 1 | 2 | 4 – 6 |
| no-progress retries | 7 | 6 | 7 – 9 |
| waits | 0 | 0 | 0 |
| first-round prompt (median) | 5,306 | 29,981 | 5,306 – 5,306 |
| prompt total (median) | 137,419 | 236,416 | 85,813 – 103,238 |
| input tokens (3 sessions) | 117,307 | 106,664 | 65,094 – 125,645 |
| cacheRead tokens (3 sessions) | 278,784 | 597,248 | 203,776 – 244,736 |

### First round vs after loading

`#994` step 3 asks for the first-round vs post-load delta. On the on-demand arm every session completed one
`ops_load_sdk` in its first program, and the next request grew by the loaded SDK declarations plus history:

| task | first round (median) | first request after the completed load (median) |
| --- | --- | --- |
| ptc-catalog-recover | 5,271 | 12,820 |
| ptc-wait-dispatch | 5,306 | 15,574 |

The full arm has no load step by design; its first round already carries the whole permitted pool (29,946 /
29,981 tokens). The A/A arms reproduce the on-demand numbers (12,733–12,786 / 15,437–15,568), which is also a
consistency check on the capture path.

### Cache usage

Every step reported a usage object; `cacheReadTokens` was present on every step and `cacheWriteTokens` was
reported as 0 throughout (the provider served the repeated prompt prefix from cache). Missing-usage rows: 0.
`reasoningTokens` was 0 on every step despite `reasoningEffort: high` — recorded as-is, not reinterpreted.

## Noise verdict

- **Not distinguished (within A/A noise):** the verify-pass difference on `ptc-wait-dispatch` (2/3 vs 3/3 with a
  3/3–3/3 A/A band is a single failure at n=3; the failure was a reasoning mistake — the wrong config layer —
  not a tier interaction); no-progress retries on both tasks (5 vs 4 and 7 vs 6 against bands of 5–7 and 7–9);
  correction opportunities on `ptc-wait-dispatch` (1 vs 2 against a band of 4–6, i.e. both arms sit below the
  A/A spread); bare input tokens on both tasks (the A/A band on `ptc-wait-dispatch` alone spans 65k–126k).
- **Outside the A/A band, but mechanical, not a model-quality claim:** the first-round prompt (5.3k vs 30.0k,
  band 5.3k–5.3k) and the prompt totals (86k vs 185k and 137k vs 236k against bands of 67k–88k and 86k–103k) —
  this is the disclosure tier's own declaration cost, an input-side fact, not a behavior difference; cacheRead
  follows it (2.4× on both tasks). The catalog task's correction opportunities (3 vs 0, band 0–1) are the
  on-demand loader inviting exactly one recoverable input error per session (an invalid first
  `ops_load_sdk` name) — all three sessions recovered and passed, so the recovery rate is 3/3, not
  distinguishable from the full arm which never had the opportunity. The catalog correct-next-step count
  (26 vs 17, band 23–24) includes the loader step and the recovery steps that only exist on the on-demand arm,
  so it is reported, not attributed.
- **No claim of a success-rate improvement from the tier.** At n=3 per arm per task, nothing behavioral separates
  the tiers beyond what the A/A band already covers.

## Reproduction

```console
npm run build && npm run build:ptc
# comparison sweep: 2 tasks x 3 repeats x 2 arms, AB/BA interleaved
node bench/v5-run.mjs --task ptc-catalog-recover --task ptc-wait-dispatch --repeat 3 \
  --out bench/runs/v5-comparison --dsh-home <a home whose .credentials.yaml carries OPENCODE_GO_API_KEY>
# A/A noise sweep: the same plan with the on-demand config in both arms
node bench/v5-run.mjs --task ptc-catalog-recover --task ptc-wait-dispatch --repeat 3 --aa \
  --out bench/runs/v5-aa --dsh-home <same home>
# judge and tables
node bench/v5-collect.mjs --run bench/runs/v5-comparison --run bench/runs/v5-aa
```

The artifacts of this report's run live under `bench/runs/v5-comparison` and `bench/runs/v5-aa`
(`summary.json`, per-session `results/*`, per-arm `dump-config.txt`), plus the smoke at `bench/runs/v5-smoke`.
The judge reuses the V4 shared rules verbatim (`scanReissues`, `countOpportunities` in `bench/lib/tracks.mjs`)
and the two task verifiers that generalize (the paged-cursor and wait-dispatch rules). The two scripted-only
story rules — the catalog track's mandatory wrong call and the load-order track's mandatory not-loaded rejection —
are deliberately not required of a real run: a model that never errs must not be judged as failing the story.

## Limitations

- n=3 per arm per task: the pilot size #994 prescribes. The A/A bands show how wide the floor is at this n;
  nothing here powers a success-rate claim.
- The composed group is the V1 isolated entry, which is leaner than the full web-profile `ops-ptc` preset (no
  persona, time-context or Bash row). Both arms share the lean composition, so the tier comparison is internally
  valid; absolute token counts describe the isolated composition, not the web profile.
- One machine, one day, one model: drift is mitigated by AB/BA interleaving, not eliminated.
- The judge's catalog "correct next steps" definition counts a completed `ops_load_sdk` as a correct step for the
  on-demand arm; cross-arm comparisons of that column are partly structural (documented above).
- The driver vendors `dsh-llm-pi-ai` into `node_modules` at run time because the repository manifest deliberately
  does not depend on any LLM adapter; the copy is gitignored and recorded here.
