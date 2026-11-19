# Four-account OPS-PTC cost ledger (#991)

## Why this ledger exists

The common accounting mistakes for OPS-PTC are structural: counting the
`tools:sdk` section twice by adding it on top of a system total that already
contains it, mixing the Native tool schemas into a PTC measurement, or
forgetting that the first teaching and the later reminders ride the message
history, not the system prompt. V1 (#990, `test/lib/ptc-entry.mjs`) already
guarantees the measured group truly entered OPS-PTC; this suite extends that
entry with the byte accounting and never lets the four answers blur together.

`test/ptc-cost-accounts.test.mjs` boots one isolated group through
`bootEntryGroup`, proves the routing with `enterPtc`, then walks one scripted
scenario — teaching, a thin program that earns a plan notice, a compliant
`ops_load_sdk` load of `glob`/`grep`/`read_files`, and a same-config repeat —
and reports each account as raw UTF-8 bytes with an item-name list.

## The four accounts

Readings below are one run at commit `205cb94`, plugin 0.5.5, host
0.2.2-rc.1, linux-x64, staged worker sha256 `2b5f988d…`, preset `ops-ptc`,
resident + dynamic + batching guidance on, official read/glob/grep mounted.
Absolute bytes are only comparable inside this configuration.

| Account | First request (resident only) | After the load | Repeat |
| --- | --- | --- | --- |
| system (delivered rendered prompt) | 12,782 B | 37,892 B | 37,892 B |
| — of which `tools:sdk` | 11,739 B | 36,849 B | 36,849 B |
| wire (outer tool schemas) | 2,500 B | 2,500 B | 2,500 B |
| history (dsh-ops guidance) | teaching 8,729 B | + notice:plan 284 B | unchanged |

- **system** is the delivered rendered prompt, byte-measured exactly as the
  provider request carries it; the suite asserts the request's system message
  equals the idle assembly rendering for every config point. Its item list at
  the first request: `harness:identity` 48, `tools:ptc-only` 159, `tool:read`
  130, `tool:write` 92, `tool:edit` 83, `tool:glob` 75, `tool:grep` 133,
  `dsh-ops:repository-tooling:mode-ptc` 307, `tools:sdk` 11,739.
- **sdk** is the single `tools:sdk` section inside system — a strict subset,
  never an extra line item. The normalization is pinned by assertion: system =
  per-section bytes joined by `\n\n`, i.e. 12,766 + 8 joins × 2 B = 12,782,
  reproducible by hand from the item list above.
- **wire** is `JSON.stringify` of the request's outer tools — always exactly
  `run_code` here, byte-identical on every request and equal to the idle
  assembly's wire.
- **history** is the dsh-ops guidance that entered session history as
  `dsh-ops:step-tail` user messages from contributor `batching-guidance`: the
  first teaching (the full batching-guidance text, once, 8,729 B) and the plan
  notice the thin program earned (once, 284 B). The suite asserts they never
  touch the system account — the post-notice system sha equals the baseline.

## The arithmetic that must hold

Loading `glob`/`grep`/`read_files` is the hand-computed example: between the
steady and loaded snapshots every other section is byte-identical and the
system delta equals the SDK-section delta exactly (+25,110 B), so the change
lands in system exactly once — the SDK subset is never counted twice. Two fresh
groups running the same fixture and code must agree on every byte (sha-equal),
and the same config repeated within a session must be byte-identical.

## SDK names against the real official schemas

The scenario mounts the host's own official file-tool plugins before the row
(the same `FsTools`/`SearchTools` pair the budget suite mounts), because SDK
names are only meaningful against the schemas they replace. The official
schemas measure 438 B (`read`), 750 B (`glob`) and 702 B (`grep`) as
name+description+parameters JSON.

On this baseline the shipped row does **not** remove those official bindings
from the PTC SDK — `read`, `glob`, `grep`, `write` and `edit` stay declared
next to `ops_inspect_local_file` and `ops_load_sdk` (the PTC hiding fix is the
open PR #961; the #978 contrast numbers were taken at its head, not here). The
suite pins this baseline on purpose: when #961 lands, its assertion turns red
and the accounts must be re-measured and re-documented. Without the official
provider the suite reports the comparison as **unmeasurable** with the missing
names, never as a quiet pass.

## What is deliberately not measured

- No real model request ever leaves the fixture: the provider is scripted and
  every printed record carries `provider: "scripted"`,
  `networkModelRequests: 0`.
- No tokens, no cache usage, no cost: bytes are not tokens, and bytes/4 is not
  a measured token count. Token accounting is a provider-output question (V5
  territory).
- A missing worker skips the whole suite visibly — a skip is not a pass.
- Absolute bytes never cross versions or groups; percentages are not claimed.

## Reproduce

```
npm run build
npm run build:ptc
DSH_OPS_WORKER_BIN=$PWD/runtime/linux-x64/dsh-ops-worker node test/run.mjs ptc-cost-accounts
```

The suite prints one JSON line per snapshot with the four accounts and the
scripted/0 marker; set `DSH_OPS_PTC_COST_REPORT=<file>` for the full itemized
evidence. `node test/run.mjs ptc-cost` runs this suite together with the
declaration-cost suite that shares its filter.
