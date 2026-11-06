# Linux index dependency review

Status: L1 (#606) and L2 (#607) of `ops-linux-index`, reviewed 2026-11-04. Re-run this review whenever
`native/Cargo.lock` changes.

## Scope

`ops-linux-index` is the Linux arm of `ops-index`'s `FsDataSource` boundary: it turns a live
directory tree into `Candidate` values for the index. L1 adds one direct dependency (`rayon`) and five transitive crates; L2 adds `notify`, a
pinned `log` and its closure. All of them live under
`[target.'cfg(target_os = "linux")'.dependencies]`, so macOS and Windows builds neither compile
nor link them.

`walkdir` is deliberately **not** used directly for enumeration (issue #606; `reports/deps.md`
§3.10): `std::fs::read_dir` recursion is about forty lines here and avoids a second path-string
traversal that would bypass the existing cap-std/rustix handle boundary. It arrives only as a
non-optional transitive dependency of L2's `notify` (disclosed below).

## Direct dependency

| crate | version | license | MSRV | published (UTC) | why |
| --- | --- | --- | --- | --- | --- |
| `rayon` | `=1.12.0` | MIT OR Apache-2.0 | 1.80 | 2026-04-14 | per-directory parallel cold enumeration; the walk is I/O bound, so reading and lstat'ing sibling directories concurrently is the point of this slice |

The exact pin follows #584's dependency whitelist. Rayon is used only inside the platform crate;
no `ops-index` type gains a `Send`/`Sync` bound.

## Transitive dependencies (fixed by `Cargo.lock`)

| crate | version | license | MSRV | published (UTC) | role |
| --- | --- | --- | --- | --- | --- |
| `rayon-core` | 1.13.0 | MIT OR Apache-2.0 | 1.80 | 2025-08-12 | rayon's thread pool and scoped-join machinery |
| `crossbeam-deque` | 0.8.8 | MIT OR Apache-2.0 | 1.61 | 2026-09-05 | work-stealing deque behind rayon |
| `crossbeam-epoch` | 0.9.21 | MIT OR Apache-2.0 | 1.61 | 2026-09-05 | epoch-based memory reclamation |
| `crossbeam-utils` | 0.8.23 | MIT OR Apache-2.0 | 1.60 | 2026-09-05 | atomics and scoped-thread helpers |
| `either` | 1.19.0 | MIT OR Apache-2.0 | 1.63.0 | 2026-10-06 | iterator choice helpers used by rayon |

`native/Cargo.lock` adds these six packages plus the new `ops-linux-index` workspace member, and
removes none.

## Seven-day publication check

Every added version was published more than seven days before this review (2026-11-04); the most
recent is `either` 1.19.0 from 2026-10-06, 29 days earlier. A version published inside the
seven-day window must not be added; if a lock update pulls one in, re-run this table and stop.

## Why rayon here when `reports/deps.md` §3.5 defers it

That report defers rayon for `ops-index` itself: the record-to-index transform is pure, has no
large fixture yet, and rayon would leak `Send`/`Sync` constraints into the index API. This crate
is the opposite shape: cold enumeration is syscall-bound, directory concurrency is the feature
being delivered, and the parallelism stays behind the platform crate's boundary. #584 already
whitelists `rayon 1.12.0` for this purpose.

## Safety and scope properties

- `ops-linux-index` is `#![forbid(unsafe_code)]`; none of the added crates has a build script,
  proc macro or native library.
- The dependency edge exists only on Linux; `cargo test --workspace` on macOS/Windows builds an
  empty crate for this member.
- No new security setting, no registry or patch override was introduced.
- No `walkdir`, no `notify`, no `inotify` crate in this slice.

## License obligations

L1's six crates are dual-licensed `MIT OR Apache-2.0`. L2 adds CC0-1.0 (`notify`), ISC
(`inotify`, `inotify-sys`), Unlicense/MIT (`walkdir`, `same-file`) and two more dual-licensed
crates (`notify-types`, `libc`), plus MIT `mio` and dual-licensed `log`. All permissive. Their
full license texts are reproduced in `licenses/linux-index/THIRD-PARTY-NOTICES.txt`; dsh-ops
itself remains MIT and needs no NOTICE change.


## L2 additions: notify 8.2.1 and its closure

L2 (#607) adds incremental watching. The direct dependency is `notify = "=8.2.1"`
(CC0-1.0, MSRV 1.85, published 2026-10-25), plus a constraint pin on `log`:

| crate | version | license | MSRV | published (UTC) | why |
| --- | --- | --- | --- | --- | --- |
| `notify` | 8.2.1 | CC0-1.0 | 1.85 | 2026-10-25 | `RecommendedWatcher` (inotify on Linux) plus `PollWatcher` for the degraded mode |
| `log` | 0.4.34 | MIT OR Apache-2.0 | 1.71 | 2026-08-22 | the crate logs watch degradation through the facade that notify already uses; the pin keeps the resolution outside the seven-day window (0.4.35 is from 2026-10-30) |

### Transitive closure built on Linux

| crate | version | license | MSRV | published (UTC) | role |
| --- | --- | --- | --- | --- | --- |
| `notify-types` | 2.2.0 | MIT OR Apache-2.0 | **1.88** | 2026-10-27 | event and error types |
| `inotify` | 0.11.5 | ISC | 1.70 | 2026-08-14 | Linux kernel event backend |
| `inotify-sys` | 0.1.8 | ISC | not declared | 2026-07-07 | raw inotify bindings |
| `mio` | 1.2.4 | MIT | 1.71 | 2026-10-03 | poll/event loop used by the backend |
| `libc` | 0.2.190 | MIT OR Apache-2.0 | 1.65 | 2026-10-02 | syscall constants |
| `walkdir` | 2.5.0 | Unlicense/MIT | not declared | 2024-03-01 | notify's own recursive watch registration (transitive only) |
| `same-file` | 1.0.6 | Unlicense/MIT | not declared | 2020-01-11 | walkdir helper |

`notify-types 2.2.0` declares exactly our MSRV floor (1.88); `Cargo.lock` is committed
and CI runs with `--locked`, so a lock update cannot silently move it. The seven-day rule
also applies to `notify-types` (2026-10-27, eight days before this review).

### The transitive `walkdir` (disclosed dependency-policy exception)

L1 deliberately does not use `walkdir` for enumeration (see above). L2's approved `notify`
version, however, lists `walkdir ^2.4` **non-optionally**; it is resolved (2.5.0) and built
on Linux. It is never imported by `ops-linux-index` and never participates in candidate
enumeration or in the cap-std authorization path: notify uses it internally to register
recursive watches. The alternative — hand-rolling inotify plus polling without notify —
would fork the Linux and macOS watcher implementations and lose notify's tested poll
fallback, so the documented exception is preferred. Revisit if notify ever makes `walkdir`
removable.

### Locked but never built on Linux

`Cargo.lock` also resolves notify's dependencies for other targets; none of them is
compiled into a Linux artifact: `kqueue 1.2.1` (MIT), `kqueue-sys 1.1.2` (MIT),
`objc2-core-foundation 0.3.2` and `objc2-core-services 0.3.2` (Zlib OR Apache-2.0 OR
MIT), `wasi 0.11.1` (wasm-only; upstream license is Apache-2.0 WITH LLVM-exception OR
Apache-2.0 OR MIT) and `winapi-util 0.1.11` (Unlicense OR MIT). They are recorded here so
the lock diff is fully accounted for.

L2 adds 14 lock entries (including `log`, `inotify*`, `mio`, `notify*`, `walkdir`,
`same-file` and the other-target crates above) and removes none.

### L2 safety notes

- `ops-linux-index` still has no `unsafe`; `notify`/inotify put their FFI behind their own
  crates and no new security setting or feature toggles an unsound mode.
- CC0-1.0 (`notify`) and ISC (`inotify`, `inotify-sys`) enter the repository's license set
  for the first time; both are permissive and require no notice, but their texts are
  reproduced in `licenses/linux-index/THIRD-PARTY-NOTICES.txt`.
- Event loss or a watch that can no longer be attributed sets a rescan flag; the session
  never treats a degraded watcher as caught up (see `src/watch.rs`).

## Advisory check

This repository has no `cargo-audit` or `cargo-deny` gate today, so this review is a version and
license audit against the exact locked set above. Re-run it whenever `native/Cargo.lock` changes;
if a gate is added later, the dual-license pair must be on its allow-list.