# `read_files` is answered in-process

`read_files` no longer has a native worker arm: `native/crates/ops-files/src/file_many.rs` is gone
and `src/execution/files.ts` answers the tool from `engine/parallel-read/` in its own process. There
is no switch — one reader, one behaviour.

## Why the arm was removed

The worker's cost was process creation. At 1 MiB the worker spent ~18 ms before it touched a byte,
against 0.3 ms for the same read in-process; across 24 small files it was 35 ms against 1.6 ms. The
arm existed to read files, and reading files does not need a sandbox process.

## What the worker used to do that still has to happen

The native read had two side effects, both now done on the host side:

| Side effect | Where it lives now |
| --- | --- |
| Credential fence on every requested path | unchanged, `src/execution/files.ts` before the read |
| `fs/observed` recorded for read-before-edit | `emitObserved` after each successful read |

The observation half is not optional: without it a model could edit a file it never "read". The
in-process branch emits the same `fs/observed` event the worker's read used to produce.

## Cost

| Request | before (worker) | now (in-process) |
| --- | --- | --- |
| 24 files × 30 lines | 35.0 ms | 1.6 ms |
| 8 files × 800 lines | 22.4 ms | 1.1 ms |
| 1 file × 20 000 lines | 18.4 ms | 0.3 ms |

Bytes are unchanged: the schema default of 200 lines per file and the 96 KiB page budget both match
what the worker returned, so the same request returns the same text.
