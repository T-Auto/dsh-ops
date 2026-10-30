# AST engine

[中文](ast-engine.zh.md)

`src/ast/` is the in-process AST engine contributed in PR #443: enumerate candidate files,
locate a symbol, rewrite the matched subtree, audit the result, then commit the bytes. It is
repository source — not a separate npm package — and its only runtime dependency is
`@ast-grep/napi` 0.51.0, pinned in the root manifest and lockfile.

It is **not** the PTC execution kernel. `src/ptc/` stays the PTC projection (typed SDK,
Outcome contracts, worker invocation); this engine is a tool provider that a host may register
on top of either projection. Nothing in this repository registers it yet — see *Boundary*.

## Layout

| Path | Contents |
| --- | --- |
| `src/ast/inproc.cts` | AST location and rewrite; the in-process engine entry |
| `src/ast/enumerate.cts` | Bounded walk / Everything `es.exe` enumeration and its cache |
| `src/ast/astdiff.cts` | In-process syntax audit (the zero-fork difftastic substitute) |
| `src/ast/stages.cts` | The five-stage pipeline used for large trees and non-TS languages |
| `src/ast/pipeline.cts` | Orchestration, circuit breaking, rollback |
| `src/ast/safe-write.cts` | Snapshot check, cooperative lock, exclusive temp file, atomic rename |
| `src/ast/proc.cts` | The only `spawn` exit: argv arrays, CRLF/BOM/EOL handling, `es.exe` candidate chain |
| `src/ast/reparse.cts` | Refuses symlinks, junctions and other reparse points |
| `src/ast/engine-load.cts` | Lazy `@ast-grep/napi` resolution with a second anchor |
| `src/ast/tools.cts` | `tools_addition` metadata and the five tool handlers |
| `src/ast/adapter.cts` | Host Outcome envelope (completed / partial / rejected / error / unknown) |
| `src/ast/cli.cts` | The `ops-ast` command line (locate / refactor); there is no MCP stdio exit — see *Boundary* |
| `src/ast/schema.json` | The five `inputSchema` blocks, shipped as plain data |
| `src/ast/agentbox.worker.cts` | The only process that writes; stdin JSON to atomic rename |

## Build

`npm run build` compiles the `.cts` sources, including the AgentBox worker, to
`lib/ast/*.cjs` with `.d.cts` declarations, and copies `schema.json` through the normal asset
step. CommonJS keeps the worker's `__dirname` spawn and the engine's existing `require`
consumers working; the rest of the plugin stays ESM.

```console
npm ci --ignore-scripts
npm run build
node test/run.mjs ast-            # the engine's suites only
node lib/ast/cli.cjs --help
```

The package exports `dsh-ops/ast`, `dsh-ops/ast/inproc` and `dsh-ops/ast/tools`; the `ops-ast`
executable points at the same compiled CLI.

## Tests and benchmarks

Eleven suites live in `test/ast-*.test.mjs` and run in the normal gate, one process each,
with temporary fixture trees. `@ast-grep/cli` 0.51.0 is a locked development dependency for the
subprocess comparisons; the suites resolve its native payload even under `--ignore-scripts`.
Benchmarks live in `bench/ast/`, outside the default gate, and write under a fresh temporary
directory or `PTC_BENCH_OUT`; several need real external tools and a read-only corpus via
`PTC_TREE`.

## External tools

`es.exe` (Everything CLI) is optional and only consulted by the `everything` strategy; the
`walk` strategy is self-contained. `sg` is needed for `strict` cross-checks and for the
comparison benchmarks. `difftastic` is optional: without it the audit falls back to an
in-process line alignment rather than inventing numbers. A missing tool is reported as such —
never silently counted as a pass.

## Boundary

This source is not registered with the running host, so it adds no tools to any session. The
adapter needs a trusted host bridge for path policy, credentials and cancellation; keeping that
boundary explicit is what stops the engine from bypassing the host's permission and subprocess
policies.

There is deliberately no MCP stdio server. The prototype exposed one, but an independent
stdio endpoint serves handlers with no sandbox policy, no credential fence and no host
authority — exactly the bypass dsh-ops removed when it dropped FastCtx and its MCP client in
0.3.2. A model-visible surface belongs behind `createHostTools`/`registerHostTools` and a
trusted bridge, never behind a socket the host did not open.
