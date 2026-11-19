# OPS-PTC legacy configuration: the five-input truth table

[中文](设计决策-20261119.md)

Decision date: 2026-11-19. Baseline: `main` at 58f6e28. Card:
[#985](https://github.com/T-Auto/dsh-ops/issues/985) (D1), workflow
[#979](https://github.com/T-Auto/dsh-ops/issues/979), overall plan
[#978](https://github.com/T-Auto/dsh-ops/issues/978).

This document locks **current** publication behaviour; it implements nothing. Every
row is asserted letter by letter by `node test/run.mjs ptc-config-truth`
(`test/ptc-config-truth.test.mjs`). Byte budgets are deliberately out of scope here —
the V slices measure them.

## How one input reaches the tool set

| Stage | Where | What it does |
| --- | --- | --- |
| Row/global keys | `src/settings/merged.ts` `resolveMergedConfig` | Validates the row; defaults `dynamicTools` and `residentTools` to true (`global` has no resident key) |
| AND gate | `effectiveMode` (`src/settings/merged.ts`), `dynamicForMode` | Row `dynamicTools` AND `global.dynamicTools`; the global switch "keeps the operator's intent and simply stops applying" |
| Consumer plan | `src/presets/builtin.ts` `applyResolvedMode` | `gate.resident = config.residentTools`, `gate.dynamic = config.dynamicTools` (the gated value), `plan.ptc = { allowedTools, alwaysLoaded }` |
| Publication | `src/publication/ptc.ts` `mountPtc` | `resident` = `PTC_RESIDENT_TOOLS` + `alwaysLoaded`, empty when `gate.resident === false`; `selectable` = `allowedTools` + `result`, empty when `gate.dynamic === false`; a tool is callable when resident **or** previously selected; `ops_load_sdk` is published only while `gate.dynamic !== false` |

## The truth table

Mode `ops-ptc` (the `ptc` row publishes the same first-round set; only
`batchingGuidance` differs). Measured on Linux, `danger-full-access`, native worker
present, real PTC presentation, the host's official `read`/`glob`/`grep` left visible;
`ops_bash` is absent because POSIX rows keep the host shell.

| # | Input (one line of `dsh-ops` row config) | Callable this step | Loadable, not loaded | Loader | run_code first-program view |
| --- | --- | --- | --- | --- | --- |
| 1 | defaults (no keys) | `ops_inspect_local_file`, `ops_load_sdk` | the sixteen-API pool below | yes | `tools.ops_inspect_local_file` and `tools.ops_load_sdk` work; a `ops_load_sdk({tools:['grep']})` receipt completes but `ops_grep` is callable only in the **next** program |
| 2 | `global: {dynamicTools: false}` | `ops_inspect_local_file` | none | no | `tools.ops_inspect_local_file` works; there is no `tools.ops_load_sdk` |
| 3 | `ops-ptc: {dynamicTools: false}` | `ops_inspect_local_file` | none | no | same set as row 2 (one AND gate, two sides); only the scope differs — see note |
| 4 | row 3 plus `ops-ptc: {alwaysLoaded: [stat]}` | `ops_inspect_local_file`, `ops_stat` | none | no | both bindings work in the first program |
| 5 | `ops-ptc: {residentTools: false}` | `ops_load_sdk` | the sixteen-API pool below | yes | the loader is the only binding; `ops_inspect_local_file` is unreachable — `ops_load_sdk({tools:['inspect_local_file']})` answers `INVALID_ARGUMENT` |
| T | **implemented — see the D3 addendum**: an explicit full selection with `allowedTools: [grep, stat]` | `ops_grep`, `ops_stat` (per #979 §2) | — | no (per #979 §2) | every allowed API callable in the first program; read-only sessions still exclude write APIs |

The default loadable pool (rows 1 and 5) is exactly:
`ops_grep`, `ops_glob`, `ops_replace`, `ops_write_file`, `ops_edit_file`, `ops_diff`,
`ops_stat`, `ops_copy`, `ops_move`, `ops_remove`, `ops_read_files`, `ops_read_table`,
`ops_read_docx`, `ops_read_pdf`, `ops_batch`, `ops_result` — the sixteen non-resident
raw APIs (`PTC_LOADABLE_TOOLS`). Row T's pool is `ops_grep`, `ops_stat` **plus
`ops_result`** (see sign-off item 1).

**Row notes.**

- Rows 2 and 3 publish the same OPS set because both feed one AND gate. Their inputs are
  still different: the global switch also gates the Native discovery entry of
  `standard`/`cordis`/`minimal` (`dynamicForMode`), the row switch only its own mode.
- Row 4 shows `dynamicTools:false` does **not** suppress `alwaysLoaded`: the startup list
  rides the resident set, with no loader to select the rest of the cap.
- Row 5 shows `residentTools:false` drops the whole resident set, including
  `ops_inspect_local_file`, which is not loadable either (it is not in
  `PTC_LOADABLE_TOOLS`).
- **Old off is a different input from a full selection** (#985 counterexample): with
  `allowedTools: [grep, stat]` and `dynamicTools: false` the first round is
  `ops_inspect_local_file` alone — neither `ops_grep` nor `ops_stat` nor the loader.
  Reading `dynamicTools:false` as "publish everything allowed" would put `ops_grep` and
  `ops_stat` in that first round, changing old users' cost and permission expectations;
  #907 implicitly flipped exactly that and #910 reverted it (#979 §4).

**Read-only and writable instances.** Read-only members of the default pool:
`ops_grep`, `ops_stat`, `ops_glob`, `ops_diff`, `ops_read_files`, `ops_read_table`,
`ops_read_docx`, `ops_read_pdf`. Writable members: `ops_replace`, `ops_write_file`,
`ops_edit_file`, `ops_copy`, `ops_move`, `ops_remove`, `ops_batch`. In a read-only
session `permitted` (`src/publication/ptc.ts`) removes every mutating API from the
loadable pool and a load request for one answers `INVALID_ARGUMENT`;
`ops_result` and `ops_load_sdk` are exempt from the mutation check. No suite here
changes the sandbox mode; D3 covers read-only.

A program you can read letter by letter:

```js
// plan: row 1 — load grep now, use it in the next program
const picked = await tools.ops_load_sdk({ tools: ['grep'] })
return { picked } // picked.status === 'completed'; ops_grep is NOT callable in this program
```

```js
// plan: row 4 — stat is resident here, callable in the first program
const r = await tools.ops_stat({ path: 'a' })
return r.status
```

## Maintainer sign-off items — recorded, deliberately not implemented

1. **The implicit `ops_result` exception.** Today `loadable = [...allowedTools, 'result']`
   unconditionally, and `permitted` exempts `result` from the read-only mutation check, so
   `ops_result` stays loadable even when the cap omits it (covered today by
   `test/resident-switch.test.mjs`, "result exception remains loadable"). With
   `dynamicTools:false` (rows 2–4) `ops_result` is **not published at all**. Decision
   needed for the full tier: must its first round publish `ops_result` so spilled refs stay
   consumable (#979 §3)? Current behaviour is locked; nothing here changes it.
   *(Resolved by the D3 addendum: the full tier's first round publishes `ops_result`.)*
2. **The global switch versus an explicit full selection.** Today `global.dynamicTools`
   AND-gates every row's loader, including the PTC one. #979 §4 requires that upgrades,
   settings saves and the `global.dynamicTools` switch never pick full **for** the user.
   Decision needed: does `global.dynamicTools:false` also suppress an explicitly selected
   full row, or does the explicit opt-in win over the bundle switch?
3. **Explicit resident versus the cap.** Today `alwaysLoaded` is validated against the
   loadable pool only (`src/ptc/config.ts`), never against `allowedTools`:
   `{ allowedTools: [grep], alwaysLoaded: [stat] }` publishes `stat` as resident with no
   diagnostic, and `residentTools:false` silently drops the whole resident set including
   `alwaysLoaded`. Decision needed: which of these conflicts get a readable diagnostic in
   D2, and whether `alwaysLoaded` must be inside `allowedTools`.
   Supplementary contrast fact (append-only audit, same day): the **custom
   integration path** is stricter — `src/consumer/options.ts:100` rejects a custom PTC
   config whose `alwaysLoaded` escapes `allowedTools` with
   `alwaysLoaded must be in allowedTools`, while the built-in rows accept the same
   shape silently (locked above by the suite's "escapes the allowedTools cap" check).
   The diagnostic inconsistency is owned by the D4 card (#988); D1 records the current
   state only.
4. **`ops_result` misdiagnosed as unpublished on a legal custom PTC integration.**
   `src/integration/diagnostics.ts` lists `'result'` among the first-round expected
   visible names of every PTC integration scope, but `result` is selectable, not
   resident (`PTC_RESIDENT_TOOLS` is `inspect_local_file` alone), so it becomes
   visible only after a loader call selects it. A perfectly legal custom
   `profile: 'ptc'` integration is therefore diagnosed `degraded` with
   `PUBLICATION_UNAVAILABLE: ops_result` while its only gap is an API the loader has
   not selected yet — verified by booting such an integration; the suite's
   "misdiagnosed PUBLICATION_UNAVAILABLE" check locks it. Built-in mode rows never
   mount diagnostics at all (`mountDiagnostics` runs only from `mountIntegration`),
   so the misreport is reachable only through the custom-integration path. The fix is
   owned by the D4 card (#988); D1 records the current state only.

## Settings-page copy — recorded verbatim

The settings page and its row switch describe the dynamic-tools switch as a
"discovery entry". The shipped strings, recorded verbatim from
`src/client/locales.ts`:

| Key | English | 中文 |
| --- | --- | --- |
| `dynamicToolsHint` | "When off, no preset offers the discovery entry." | "关闭后没有任何预设提供发现入口。" |
| `swDynamicToolsHint` | "Offers the discovery entry to this preset. Applies only while the bundle switch is on." | "为该预设提供发现入口。仅在总开关开启时生效。" |

What the PTC row actually publishes for that entry is the typed loader
`ops_load_sdk` (truth-table rows 1 and 5), not a discovery-style tool: the wording
and the artifact differ. Unifying the wording is the D5 slice of #979; this card
records the gap only.

## Loader batching — recorded current behaviour

One `ops_load_sdk` call accepts 1–5 exact raw API names (`requestedApis` in
`src/projections/ptc/loader.ts` — `tools must contain 1-5 exact raw API names`), so
filling the sixteen-name default pool takes at least four calls. `alwaysLoaded` and
the rest of the resident set carry no count cap: `parsePtcConfig`
(`src/ptc/config.ts`) validates each name against the loadable pool, never the
list's length, and resident APIs publish without any loader call. Locked by the
suite's "loader batches 1-5 names" check.

## Scope

No publication default, no diagnostic and no third user mode is introduced here. Per
#985, disagreements on the sign-off items go to the maintainers on the card before D2/D3
implement anything. Pure legacy configurations keep the tool sets above before and after
this slice — that is what the suite asserts.

## Verification

- `npm run build`, then `node test/run.mjs ptc-config-truth` — 11 passed / 0 skipped / 0
  failed on the baseline (first run matched the code-read prediction on every row).
- Red proof that the assertions bind behaviour, not each other: changing only the row-5
  expected constant in the suite makes exactly that row's check fail
  ("1 of 11 check(s) failed"); restoring the constant returns the suite to green.
- `node test/run.mjs resident-switch` — unchanged neighbour suite, see the PR.
- Supplementary audit (append-only, same day): two checks were added — the loader's
  1–5-per-call cap with the count-cap-free resident startup list, and the legal
  custom PTC integration misdiagnosed `PUBLICATION_UNAVAILABLE: ops_result`. The
  suite now reports 13 passed / 0 skipped / 0 failed on the baseline.

## D2 addendum — the explicit disclosure policy key, parsed (2026-11-19)

Card [#986](https://github.com/T-Auto/dsh-ops/issues/986), on top of this table's
branch. This addendum records what D2 locked and resolves sign-off item 2's
precedence question conservatively; publication of the full tier remains D3.

**The key.** The `ptc` and `ops-ptc` rows accept a YAML-only
`disclosurePolicy: 'on-demand' | 'full'` (default `'on-demand'` = the legacy path
of this table, letter for letter). Illegal values are errors naming the key and
the received value or type; non-PTC rows (`minimal`, `standard`, `cordis`)
reject the key with `disclosurePolicy applies to the ptc and ops-ptc rows only`.
The builtin consumer plan slice and custom integrations keep the legacy default
until D3/D4 teach them the tier.

**Sign-off item 2, resolved conservatively per #979 §4.** An explicit full
selection is a *distinct opt-in* and never overrides the bundle switch: while
`global.dynamicTools` is off, the full tier is not applied — the row keeps its
legacy resident/alwaysLoaded surface (row 2 of this table) — and the saved
choice stays untouched in the row config, re-applying when the switch returns
on. This keeps every §4 guarantee in one direction: upgrades, settings saves
and switch flips never write or erase the key, and the operator's off stays
absolute for every disclosure shape. The row-level `dynamicTools` keeps its
loader-only meaning: the full tier publishes no loader (#979 §2), so a row that
also turns the loader off keeps its explicit tier. `effectiveMode` encodes this
gate; the saved intent is preserved exactly like the existing dynamicTools AND
gate preserves it.

**Serialization.** `hostConfig` (the save-path serializer) preserves an explicit
choice verbatim and never auto-writes the key: reading → saving an unrelated
setting → reading again keeps `'full'`, and every legacy input — the five rows
of this table included — resolves with the key absent at both the raw and
serialized layers.

**Still not implemented.** Truth-table row T stays a target: nothing publishes
the full tier yet (D3 owns `src/publication/ptc.ts` and the builtin plan slice),
there is no settings-page entry (D5), and sign-off items 1, 3 and 4 remain open
as recorded above.

**Verification.** `npm run build`, then `node test/run.mjs ptc-disclosure-policy`
— 8 checks, red first (8 of 8 failed on the unimplemented baseline, the key
rejected as unknown), green after. `node test/run.mjs ptc-config-truth` 13/0/0,
`node test/run.mjs resident-switch` 24/0/0 and `node test/run.mjs settings-rows`
14/0/0 unchanged on the new parsing path, worker
`DSH_OPS_WORKER_BIN=runtime/linux-x64/dsh-ops-worker` (sha256 2b5f988d).


## D3 addendum — the explicit full tier is published (2026-11-19)

Card [#987](https://github.com/T-Auto/dsh-ops/issues/987), on top of the D2 addendum's
branch. This slice turns the parsed key into publication behaviour; nothing above
rewrites the five legacy rows, which stay asserted letter by letter.

**Row T, implemented.** With `{ disclosurePolicy: 'full', allowedTools: [grep, stat] }`
the first round publishes `ops_grep`, `ops_stat`, `ops_inspect_local_file` (resident)
and `ops_result`, with no `ops_load_sdk` (#979 §2). The first program can call the
permitted pool directly (dual verification: the settled declaration set plus a real
`run_code` binding call through the worker); pool-outside business APIs stay
unavailable. The builtin plan slice now carries the parsed tier
(`src/presets/builtin.ts`), and the publication consumes it in
`src/publication/ptc.ts`.

**Sign-off item 1, resolved conservatively per #979 §3.** The full tier's first round
publishes `ops_result`: a ref spilled this step must stay consumable, and the unified
acceptance rule forces the same conclusion — on-demand can always load `result`
(`loadable = [...allowedTools, 'result']`), so the loaded business set equals the full
first-round set only if full publishes it. The comparison is pinned by one check.

**Edges, as shipped and asserted.** An empty cap keeps the tier at resident +
`result` (still no loader). Read-only still removes every mutating API from the
first round — switching tiers never widens permissions. `residentTools:false` drops
the resident surface (row 5) but not the explicit tier. Duplicated names collapse to
one registration. The bundle switch keeps its D2 veto end to end: while
`global.dynamicTools` is off an explicit full row publishes row 2 letter for letter;
the row-level `dynamicTools` keeps its loader-only meaning, so a full row that also
turns the loader off keeps its tier.

**Not done here (by design).** Custom integrations keep the legacy default until D4,
and `PtcConfig.disclosurePolicy` stays optional for exactly that reason (making it
required would force touching the custom-integration plan slice this card does not
own; the builtin plan carries the value, an absent value means on-demand). The
settings-page entry is D5.

**Verification.** `npm run build`, red first: `node test/run.mjs ptc-declaration-surface`
4 of 5 failed (every new row T assertion; the legacy loader-less check stayed green)
and `node test/run.mjs ptc-full-disclosure` failed row T, the comparison, read-only
and the empty pool before the suite's 120 s deadline. Green after:
ptc-declaration-surface 5/0/0, ptc-full-disclosure 8/0/0, and the regression locks
unchanged — ptc-config-truth 13/0/0, resident-switch 24/0/0, ptc-disclosure-policy
8/0/0, settings-rows 14/0/0; worker
`DSH_OPS_WORKER_BIN=runtime/linux-x64/dsh-ops-worker` (sha256 2b5f988d). Environment
note, not a regression: `ptc.test.mjs`'s installed-runtime check asserts precedence
over `DSH_OPS_WORKER_BIN`, so it runs without that env override (it fails identically
on the base commit with the override set).
