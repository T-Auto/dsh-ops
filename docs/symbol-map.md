# `ops_symbol_map` — outline a file without paying for it

`ops_symbol_map` answers "what is in this file" as a list of symbol positions. It is the only file
tool that never spawns the native worker: a symbol map is a Tree-sitter query over bytes the plugin
already has, so a subprocess would cost more than the work itself.

```jsonc
{ "path": "src/file/symbol-map.ts", "name": "invokeSymbolMap", "limit": 50 }
```

| Field | Meaning |
| --- | --- |
| `path` | Required. Relative to the session cwd. |
| `name` | Case-sensitive exact symbol-name filter. |
| `scope` | Outer-first scope filter, e.g. `Foo.bar`. |
| `lang` | Grammar override for an ambiguous extension. |
| `extended` | Also report non-declaration symbols. |
| `offset` / `limit` | Paging over **symbols**, not lines. |

## Output

One position line per symbol in the native projection:

```text
=== SYMBOLS: good.ts (typescript, 5 symbols) ===
1-3 f alpha
5-13 c Widget
```

The receipt carries positions and identity (`revision`, `fileHash`) but never the code body: an
outline must not be able to stand in for a read. `symbol_map` is therefore absent from
`OBSERVED_READ_TOOLS`, and an edit that follows an outline alone still fails its compare-and-swap.

A file with a syntax error still yields the symbols below the error, and the header says
`recovered best-effort` so a best-effort outline is never mistaken for a clean one.

## Grammars

The grammars are optional dependencies (`tree-sitter`, `tree-sitter-typescript`,
`tree-sitter-javascript`). When they are absent the tool refuses with `EXECUTOR_UNAVAILABLE` and
names the exact install command; it never returns an empty outline that looks like an empty file.
Point `DSH_OPS_SYMBOL_MAP_ROOT` at a project root when the plugin is copied out of `node_modules`
and its own directory no longer sits under the project that installed the grammars.

## Cost

On a 400-line TypeScript file: outline 321 estimated tokens vs 2 740 for a full read (−88 %), and
0.13 ms warm vs 0.84 ms. The first call on a file pays the parse (14.7 ms); later calls hit the map
cache.
