# ops-mac-index dependency review

`native/crates/ops-mac-index` is the macOS producer for the `ops-index` data-source boundary. It
reads directory trees and per-entry metadata; it never opens file content, never starts a process and
never authorizes a caller. Its dependencies are declared under
`[target.'cfg(target_os = "macos")'.dependencies]`, so a Linux or Windows workspace build does not
compile them, and the crate itself is `#![cfg(target_os = "macos")]` (an empty library elsewhere).
This page is the dependency record for the crate. Every addition names an exact version, its
crates.io publication date (checked against the crates.io API on 2026-11-04 UTC+08) and the reason it
is needed. Full license texts are in
[`licenses/mac-index/THIRD-PARTY-NOTICES.txt`](../licenses/mac-index/THIRD-PARTY-NOTICES.txt).

## Runtime dependencies (2, macOS-only)

| Crate | Pin | Published (UTC) | License | Why |
| --- | --- | --- | --- | --- |
| `walkdir` | `=2.5.0` | 2024-03-01 | Unlicense OR MIT | Bounded cold traversal of one root (M1). The walker is built with `follow_links(false)`, `min_depth(1)` and `max_depth(budget)`, so it never follows a descendant link and never walks past the depth budget. Pure Rust, no build script. |
| `rayon` | `=1.12.0` | 2026-04-14 | MIT OR Apache-2.0 | Parallel per-entry `stat` in the cold walk (M1). #423 measured `symlink_metadata` at 71–87 % of a walk, which is the part worth spreading over threads. `rayon` is used only in `src/walk.rs`; `ops-index` never depends on it. |

Both are exact pins. `walkdir` has released nothing newer than 2.5.0 since 2024, so a version range
could only deliver a silent edition bump; `rayon` 1.12.0 keeps its MSRV (1.80 for `rayon-core`,
1.88 is the workspace floor) inside the declared floor.

## Transitive packages currently locked (7)

The lockfile (committed in the same PR) resolves these packages in addition to the two direct
dependencies above. MIT is selected where a package offers a choice.

| Package | Version | Published (UTC) | License | Role |
| --- | --- | --- | --- | --- |
| `rayon-core` | 1.13.0 | 2025-08-12 | MIT OR Apache-2.0 | Thread pool and join primitives behind `rayon` |
| `either` | 1.19.0 | 2026-10-06 | MIT OR Apache-2.0 | Iterator helpers used by `rayon` and `walkdir` |
| `crossbeam-deque` | 0.8.8 | 2026-09-05 | MIT OR Apache-2.0 | Work-stealing queue behind `rayon-core` |
| `crossbeam-epoch` | 0.9.21 | 2026-09-05 | MIT OR Apache-2.0 | Epoch-based reclamation for `crossbeam-deque` |
| `crossbeam-utils` | 0.8.23 | 2026-09-05 | MIT OR Apache-2.0 | Atomics and cache-line helpers for the above |
| `same-file` | 1.0.6 | 2020-01-11 | Unlicense OR MIT | File identity comparison inside `walkdir` |
| `winapi-util` | 0.1.11 | 2025-09-07 | Unlicense OR MIT | Windows-only API helpers of `walkdir`; locked for the Windows target, not built on macOS or Linux |

## Why `walkdir` despite the earlier recommendation

`reports/deps.md` §3.10 recommended *not* introducing `walkdir` and using `std::fs::read_dir`
instead. Slice issue #609 ("walkdir + rayon cold start") explicitly requires it, and this crate is
the slice's implementation. The two reasons are compatible rather than contradictory:

- The report's objection was that a path-string walk bypasses the `cap-std` handle boundary the
  search path is built on. That concern applies to code that *authorizes* a result. This crate never
  authorizes anything: it produces `Candidate` hints, and #584's safety rule 1 requires `ops-search`
  to re-verify every candidate through its own no-follow handles, skip rules and identity check
  before it can reach an answer.
- The cold walk is internal to the index crate and is reachable only when a caller deliberately calls
  `enumerate` (M1's `state` is `Unsupported`, so today the shipped path does not).

Decision record: issue #609, comment "M1 dependency decision". If the platform layer is later
required to stay on `read_dir`, only the traversal in `src/walk.rs` changes; the two-phase shape,
budget semantics and the whole test suite stay as they are.

## Rules still in force

- `ops-index` stays dependency-free of platform crates and of `walkdir`/`rayon`: the trait owner is
  pure, the platform crate owns the OS work.
- No `unsafe` (the crate is `#![forbid(unsafe_code)]`), no `cfg(any(...))`, no Windows API, no
  `goz_core::` import, no copied goz source.
- Seven-day rule: every package above was published at least seven days before this PR.
- No security setting changed; the workspace still builds with `--locked`.
