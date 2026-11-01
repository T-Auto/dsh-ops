# `symbol_map` — what it costs and what it saves

Measured on Windows 11 / x64, Node 24.22.1, median of three, on a generated 400-line TypeScript
file (8 KiB) with the tree-sitter grammars installed.

| Path | Wall time | Rendered bytes | Estimated tokens |
| --- | --- | --- | --- |
| `symbol_map` (warm) | **0.13 ms** | 1 282 | **321** |
| full read of the same file | 0.84 ms | 5 039 | 1 260 |

**−74.6 % tokens, −83.7 % wall time** against the schema-default read (200 lines). Against a read
of the whole file the saving is 88 %; the 200-line default already clips, so 74.6 % is the honest
number for what a caller would otherwise have paid.

## Cold start

The first call on a file pays the parse: **14.7 ms**. Every later call hits the per-process map
cache and lands at 0.13 ms. In a session this is one cold call per file.

## Why the answer is small

The receipt carries one position line per symbol — `start-end kind name` — plus file identity
(`revision`, `fileHash`). It never carries a symbol body. That is not only a size decision: an
outline must not be able to stand in for a read, which is why `symbol_map` is absent from
`OBSERVED_READ_TOOLS` and an edit that follows an outline alone still fails its compare-and-swap.

## Degraded runs

| Missing | Behaviour |
| --- | --- |
| tree-sitter grammars | `EXECUTOR_UNAVAILABLE` naming the exact install command; never an empty outline |
| a worker binary | no effect — this tool never spawns one |

`test/symbol-map.test.mjs` pins all of it (47 checks), including that a file with a syntax error
still yields the symbols below the error and that a recovered range is never invented.
