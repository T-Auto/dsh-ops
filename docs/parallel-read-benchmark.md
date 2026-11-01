# ops-parallel-read 4.1.8 — source drop, measured

The reader ships as source under `engine/parallel-read/` (5 modules, 99 KiB) instead of a tarball.
`src/file/parallel-read.ts` is the typed door. It has no dependencies beyond the Node standard
library, so a clean `npm install` is enough.

## Native worker vs in-process, same request

Windows 11 / x64, Node 24.22.1, median of three. `native` = the shipped Rust worker, spawned once per
call; `inproc` = `engine/parallel-read` answering in the same process.

| Request | native | in-process | speed-up |
| --- | --- | --- | --- |
| 24 files × 30 lines (34 KiB) | 35.0 ms | 1.6 ms | 21× |
| 8 files × 800 lines (317 KiB) | 22.4 ms | 1.1 ms | 20× |
| 2 files × 8 000 lines (824 KiB) | 22.4 ms | 0.4 ms | 51× |
| 1 file × 20 000 lines (1 MiB) | 18.4 ms | 0.3 ms | 53× |

The gap is process creation, not I/O: at 1 MiB the worker spends ~18 ms before it touches a byte.

## Token parity

Both readers apply the schema default of 200 lines per file and both stop at the output budget, so
the same request returns the same bytes:

| Request | native | in-process |
| --- | --- | --- |
| 1 file × 20 000 lines | 10.7 KiB | **10.7 KiB** |
| 2 files × 8 000 lines | 21.3 KiB | **21.3 KiB** |
| 8 files × 800 lines | 34.1 KiB | 35.5 KiB (+4 %) |
| 24 files × 30 lines | 36.2 KiB | 37.9 KiB (+5 %) |

The remaining few per cent is receipt fields (`nextIndex`, `pending`), not content.

## Why the default stays `native`

The native read is what writes the host's read-before-edit table. `inproc` does not, so switching it
on by default would let a model edit a file it never really read. `fileReader: inproc` is therefore
opt-in — see `docs/file-reader.md`.
