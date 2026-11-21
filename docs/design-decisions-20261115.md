# Design decision: hide official file tools under PTC presets

Date: 2026-11-15
Status: accepted
Scope: `src/publication/ptc.ts`, `src/publication/replacements.ts`, `src/consumer/mount.ts`, `src/presets/builtin.ts`, `src/integration/index.ts`

## Context

`hideOfficialTools` is documented as hiding the official file tools a mode replaces. In practice it is inert for every PTC-based preset (`ptc`, `ops-ptc`, custom PTC presets): `MODE_PLANS` declares `nativeFiles: false` for them, and `replacementTargets` gates file targets behind `config.hideOfficialTools && plan.nativeFiles`, so the target map only ever contains the Windows shell names. `mountReplacements` is mounted (Windows targets are non-empty) but never sees `read`/`glob`/`grep`.

The PTC projection keeps the official SDK bindings (`tools.grep`, `tools.read`, ...) while `ops_*` bindings load on demand, so the model can choose the weaker official API even when the switch is on.

This is treated as a defect, not a policy: the acceptance record in `docs/file-contract-validation.md` described the then-current configuration, and the switch's user-visible promise is coverage of the file tools it replaces.

## Decision

1. Fix the existing `hideOfficialTools`; add no new switch; defaults unchanged.
2. Apply by runtime PTC presentation, not by preset id: `ptc`, `ops-ptc`, custom PTC presets. `minimal` stays out.
3. Hidden set = keys of `RAW_OFFICIAL_REPLACEMENTS` (currently `read`, `glob`, `grep`), so it follows the table.
4. `write`, `edit`, `read_image` stay visible.
5. Carrier: extend the shadow `when` in `mountReplacements` (option B), not `ctx.tools.restrict`.
6. `replacementTargets` gate becomes `plan.nativeFiles || plan.ptc`; the integration path covers both presentations.
7. Reachability signal comes from the PTC publisher: `permitted ∧ (resident ∨ allowedApis)`, plus an existence check that the publisher registered the counterpart (`tools.get` + `publicationAdmission !== undefined`). `selected` is excluded and the admission is never evaluated, so loading the SDK cannot change the decision.
8. `mountPtc` returns a `PtcServability` accessor; `apply` stays `void`; unattached agents yield `undefined` (fail-open).
9. A state-change line is emitted once per agent, official name and state; a publisher probe failure is caught, keeps the official tool (fail-open) and reports one warning. Host behaviour was verified: a rejected `when` fails the whole step resolve (`cannot resolve availability of tool`), so catching is required, not optional.
10. Both built-in and integration paths change.
11. Tests: full matrix (flip existing assertions, add mixed-tree and configuration matrix).

## Evidence

A real-host probe (real `mode-ptc` component + NodePtc + official `read/glob/grep` registered at the root + `mountPtc` shared-file publication) showed:

| stage | admitted | `grep:` in `tools:sdk` | SDK bytes |
|---|---|---|---|
| before | `read, glob, grep, ops_inspect_local_file, ops_load_sdk` | yes | 8749 |
| after agent-scope shadow with `when:false` | `read, glob, ops_inspect_local_file, ops_load_sdk` | no | 8676 |
| restored (dispose) | full | yes | 8749 |

A same-name shadow removes the official tool from both `definitions` and the SDK section, reversibly.

## Implementation

- `mountPtc` returns `PtcServability { servable(agent), isPtc(activation) }`; `servable` is `undefined` until the publisher is attached, otherwise the set of raw APIs satisfying `permits(agent, api) && (resident.has(api) || allowedApis(agent).includes(api))`.
- `ReplacementPublication` gains an optional `ptc` field. Inside `when`, after the `keepOfficial`/gate checks and before the host-counterpart check, a PTC branch hides the official name when the raw API is in the servable set and the activation is PTC.
- The PTC branch applies only to keys of `RAW_OFFICIAL_REPLACEMENTS` (never `pwsh`).
- Native consumers pass no `ptc` field and keep the old path byte-for-byte.
- `replacementTargets` gates on `nativeFiles || ptc` in both `applyResolvedMode` and the integration path.

## Consequences

- Behaviour change: after upgrade, a PTC session with `hideOfficialTools: true` (the default) no longer sees official `read/glob/grep`; the model must load `ops_*` through `ops_load_sdk`. Documented in CHANGELOG; the existing switch turns it off.
- `write`, `edit`, `read_image` are unaffected.
- Unattached or narrowed PTC projections keep the official tools (fail-open).

## Consequences: first-resolve timing

The publisher attaches asynchronously, and `servable` answers `undefined` until then, so the first resolve of a PTC session may still show the official tools. The next resolve hides them. This is the fail-open contract, not a regression; `notePtc` records `unattached` so the window is observable.

## Open risk

Resolved by probe: a rejected `when` fails the step resolve (`cannot resolve availability of tool "read"`) instead of failing open or hidden. `replacements.ts` therefore catches probe failures and keeps the official tool. Known accepted risk: reachability comes from the publisher pool (`permitted ∧ (resident ∨ allowedApis)`), not from `publicationAdmission`; a host-level publication rejection after that point is a PTC publisher failure covered by the PTC lifecycle suites, not by the hiding decision.
