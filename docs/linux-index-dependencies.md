# Linux index dependency review

Status: L1 of `ops-linux-index` (#606), reviewed 2026-11-04. Re-run this review whenever
`native/Cargo.lock` changes.

## Scope

`ops-linux-index` is the Linux arm of `ops-index`'s `FsDataSource` boundary: it turns a live
directory tree into `Candidate` values for the index. It adds exactly one direct dependency,
`rayon`, and five transitive crates. All of them live under
`[target.'cfg(target_os = "linux")'.dependencies]`, so macOS and Windows builds neither compile
nor link them.

`walkdir` is deliberately **not** used (issue #606; `reports/deps.md` §3.10): `std::fs::read_dir`
recursion is about forty lines here and avoids a second path-string traversal that would bypass
the existing cap-std/rustix handle boundary. `notify` is L2's dependency, not this slice's.

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

All six crates are dual-licensed `MIT OR Apache-2.0`. Their full license texts are reproduced in
`licenses/linux-index/THIRD-PARTY-NOTICES`; dsh-ops itself remains MIT and needs no NOTICE change.

## Advisory check

This repository has no `cargo-audit` or `cargo-deny` gate today, so this review is a version and
license audit against the exact locked set above. Re-run it whenever `native/Cargo.lock` changes;
if a gate is added later, the dual-license pair must be on its allow-list.
