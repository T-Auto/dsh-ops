# In-process `read_files`

`ops_read_files` used to be answered by `native/crates/ops-files/src/file_many.rs`. Every call paid
one spawn of the 3.8 MB worker before a byte was read: **~21 ms of floor** on this host, independent
of how many files were asked for. The read itself is `open` + `read` + decode — work that costs
microseconds once the page cache is warm.

The arm now runs in the host process:

| File | Role |
| --- | --- |
| `src/file/read-types.ts` | result shape, defaults, error type, pool, truncation helpers, LRU |
| `src/file/read-fence.ts` | lexical fence, real-path re-check, reparse-point refusal |
| `src/file/parallel-read.ts` | `readOne` (the seven gates) and `parallelRead` |
| `src/file/read-files-compat.ts` | folds results into the native item receipt |
| `src/file/worker.ts` | fence, policy, credential check, dispatch, host observations |
| `native/crates/ops-files/src/file.rs` | the `read_files` arm is **removed**, not duplicated |

## Where the fence runs

Nothing moved out of `worker.ts`. The order is unchanged, because it is the security boundary:

1. session identity and an absolute cwd;
2. one authoritative policy resolve, then a mode whitelist;
3. the credential fence over every caller-named path, **before** anchoring;
4. write-intent checks (not applicable to a read, but the same code path);
5. anchoring through `authority-paths` and the session temp root;
6. **here** the in-process reader takes over, instead of `subprocess.spawn`;
7. host observations are emitted for every item that came back `completed`;
8. the denial normaliser runs on the receipt.

The reader sees only anchored paths. It has no policy of its own — the same contract the native
worker had.

## The seven gates, in the order they fire

1. **Pool** — in-flight files never exceed `concurrency` (default 10), so descriptors peak there.
2. **Size** — `fstat` on the open descriptor, not `stat` on the path; a swapped path cannot lie.
3. **Deadline** — one timer covers open/fstat/read/close; a lost `open` closes its late handle.
4. **Binary** — NUL inside the decode window. The compat arm turns this off: the native worker
   returned `A\0B` as text, so refusing it would be a replacement regression.
5. **Decode** — UTF-8 BOM kept or stripped per caller; UTF-16LE decoded; UTF-16BE and invalid UTF-8
   refused with `ERR_INVALID_ENCODING` on the write path.
6. **Char cap** — stop decoding at the cap instead of reading 2 MB to discard it.
7. **Batch budget** — 128 KiB of JSON, settled in input order, whole lines dropped from the end.

## Differences from the native arm (both intentional)

| Behaviour | Native | Here | Why |
| --- | --- | --- | --- |
| default `limit` | 200 lines, `complete: false`, `nextOffset` | whole file | 200 lines silently cut a 270-line file while the receipt still looked healthy |
| receipt `path` | `K:\a\b.ts` | `K:/a/b.ts` | `symbol_map` and the `ptc_*` tools already returned POSIX; one path dialect, not two |

Everything else is byte-identical, including `revision` (SHA-256 over the raw bytes), `lineCount`,
`bytes`, `omitted`, `nextOffset`, the CRLF-stripped line text, the retained BOM, and every error
`code` / `phase` / `effectState`.

## Measured on this host

Native = shipped `runtime/win32-x64/dsh-ops-worker.exe`, best of five, same fixtures:

| Batch | Native | In-process | Ratio |
| --- | --- | --- | --- |
| 6 × 2 KB | 22.18 ms | 0.31 ms | **71.9x** |
| 12 × 1 KB | 24.05 ms | 0.35 ms | **68.2x** |
| 24 × 512 B | 27.87 ms | 0.85 ms | **32.8x** |

The ratio grows as files get smaller: the spawn floor dominates, and the in-process arm barely
moves. A second read of the same file hits the LRU (`dev:ino:size:mtime` plus every body switch).

## Verify

```bash
npm run build
node test/read-files-inproc.mjs   # 25 assertions, no worker involved
node test/read-files-parity.mjs   # native vs in-process, then the three timings
```

`read-files-parity.mjs` spawns the shipped worker for the comparison, so it needs a staged native
runtime. The first suite does not.
