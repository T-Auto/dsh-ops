# Schema measurement

Manual measurement only; not a tokenizer, CI, or proof of whole-task savings.
Metric: compact UTF-8 JSON `{name,description,parameters}` bytes, tokens ≈ ceil(bytes/4).
Runtime is FastCtx 0.2.6; only plugin publication/presentation changes.
This file is a point-in-time snapshot of the numbers it quotes; the authoritative current
values live in `docs/schema-current.json`. Reproduce with
`node scripts/measure-schemas.mjs docs/schema-current.json`.

## 0.2.4 component surface

| Enabled components | Tools | Schema bytes | Approximate tokens |
| --- | ---: | ---: | ---: |
| File only | 4 | 6,880 | 1,720 |
| Shell + file (default, full access) | 5 | 8,357 | 2,090 |
| Shell + file + background (full access) | 9 | 10,602 | 2,651 |
| 0.2.3 full surface (historical) | 10 | 10,700 | 2,675 |

Default reduces plugin schema bytes by 21.9% versus 0.2.3. Background contributes
2,245 bytes only when enabled; duplicate ops_run (751 bytes) is no longer published.
The host tool declarations remain additive and are not included in this table.
Restricted sessions have no ops_bash or background command tools.

Prompt sections are component-owned and independently removed: file 498 bytes,
shell 698 bytes, background 269 bytes. These sum when multiple components are on;
`toolingPrompt` in the snapshot is the legacy combined CLI renderer, not the actual
sum of separately registered sections. Minimal's complete persona can exclude them.
No raw server instructions or old host-shell policy segment is published.

## Historical comparison

The unchanged baseline is dee3c57 before description compression: nine FastCtx
schemas 18,889 bytes; four file schemas 12,807. File descriptions remain 6,880 bytes
(46.3% reduction). ops_grep: 3,766 → 2,058; inspect: 4,375 → 2,007. These are plugin
old/new comparisons, NOT official-host versus plugin comparisons.

Reproduce with `node scripts/measure-schemas.mjs docs/schema-current.json`.
It initializes and lists schemas without tool execution. Preserve baseline JSON.
Actual request count, cache pricing, tool output and repeated history can outweigh
fixed schema savings; no percentage here predicts task-total provider tokens.
