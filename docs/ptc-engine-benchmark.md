# PTC engine 2.1.1 — source drop, measured

The engine ships as source under `engine/ptc/` (26 files, 194 KiB with declarations) instead of a
tarball. `src/ptc/engine.ts` is the typed door; `@ast-grep/napi` was already a dependency of this
package, so nothing else is needed.

## What was measured

Run on Windows 11 / x64, Node 24.22.1, `dsh-ops-worker.exe` built from this tree
(`cargo build --release --locked`, 22.5 s).

| Path | Wall time | Notes |
| --- | --- | --- |
| in-process locate on a 400-line TS file | **0.13 ms warm** | first call pays the parse (14.7 ms) |
| same request through the native worker | 18–24 ms | worker spawn dominates, not parsing |
| in-process refactor, small tree | sub-millisecond | no process, no temp files |

The 18–24 ms figure is the worker's process creation plus one JSON round trip; the engine's own work
is microseconds at these sizes. That gap is the entire reason the tool answers in-process.

## Degraded runs (no optional tooling installed)

| Missing | Behaviour |
| --- | --- |
| `@ast-grep/napi` | the five `ops_ptc_*` tools answer `EXECUTOR_UNAVAILABLE`; nothing is written |
| `es.exe` (Everything) | enumeration falls back to the recursive walk; `esCandidates()` returns a list, never throws |
| `ast-grep` CLI | `sgCrossCheck` reports `agree: false` instead of throwing |

`test/ptc-engine.test.mjs` pins all four properties (4 checks).

## Why source and not a bundle

The published 2.1.1 artifact and the TypeScript prototype had drifted (`tools.ts` was still 2.0.5).
Shipping the artifact *as* the source removes the second copy of the truth: there is nothing left to
drift from.
