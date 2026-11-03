# ops-mac-index dependency review

`native/crates/ops-mac-index` is the macOS producer for the `ops-index` data-source boundary. It
reads directory trees and per-entry metadata; it never opens file content, never starts a process and
never authorizes a caller. It has exactly one third-party dependency, `rayon`, declared under
`[target.'cfg(target_os = "macos")'.dependencies]`; the crate itself is `#![cfg(target_os = "macos")]`
(an empty library elsewhere), so Linux and Windows workspace builds compile neither the crate body
nor `rayon`. The traversal is `std::fs::read_dir` recursion, with `rayon` fanning out sibling
directories and the per-entry `stat`. This page is the dependency record for the crate. Every
addition names an exact version, its crates.io publication date (checked against the crates.io API on
2026-11-04 UTC+08) and the reason it is needed. Full license texts are in
[`licenses/mac-index/THIRD-PARTY-NOTICES.txt`](../licenses/mac-index/THIRD-PARTY-NOTICES.txt).

## Runtime dependency (1, macOS-only)

| Crate | Pin | Published (UTC) | License | Why |
| --- | --- | --- | --- | --- |
| `rayon` | `=1.12.0` | 2026-04-14 | MIT OR Apache-2.0 | Work-sharing for the cold walk (M1): sibling directories are scanned in parallel and each collected entry's `stat` is mapped in parallel. #423 measured `symlink_metadata` at 71–87 % of a walk, which is the part worth spreading over threads. Used only in `src/walk.rs`; `ops-index` never depends on it. |

The pin is exact. `rayon-core` 1.13.0 declares MSRV 1.80 and the workspace floor is 1.88, so the pin
cannot silently raise it.

## Transitive packages currently locked (5)

The lockfile (committed in the same PR) resolves these packages in addition to `rayon` above. MIT is
selected where a package offers a choice.

| Package | Version | Published (UTC) | License | Role |
| --- | --- | --- | --- | --- |
| `rayon-core` | 1.13.0 | 2025-08-12 | MIT OR Apache-2.0 | Thread pool and join primitives behind `rayon` |
| `either` | 1.19.0 | 2026-10-06 | MIT OR Apache-2.0 | Iterator helpers used by `rayon` |
| `crossbeam-deque` | 0.8.8 | 2026-09-05 | MIT OR Apache-2.0 | Work-stealing queue behind `rayon-core` |
| `crossbeam-epoch` | 0.9.21 | 2026-09-05 | MIT OR Apache-2.0 | Epoch-based reclamation for `crossbeam-deque` |
| `crossbeam-utils` | 0.8.23 | 2026-09-05 | MIT OR Apache-2.0 | Atomics and cache-line helpers for the above |

## Why the traversal is `std::fs::read_dir`, not `walkdir`

`reports/deps.md` §3.10 recommended *not* introducing `walkdir` and using `std::fs::read_dir`
instead: a path-string walk adds a dependency whose traversal semantics would need the same handle
boundary review the search path already has. This crate follows that recommendation. The first
revision of M1 (#609) named `walkdir`; the slice was updated, and PR #619 now implements the cold
walk as a recursive `read_dir` with `rayon` across sibling directories and per-directory entries.
Only `rayon` remains, and it is on the #584 whitelist.

No traversal crate is needed for the semantics the source must keep: recursion is bounded by
`max_depth`, symlinks are never followed `(read_dir` entries report their own file type and
`symlink_metadata` supplies size/mtime), the root's own symlink is followed like any path-based
open, and an unreadable directory fails the enumeration instead of silently truncating it.

## Rules still in force

- `ops-index` stays dependency-free of platform crates and of `rayon`: the trait owner is pure, the
  platform crate owns the OS work.
- No `unsafe` (the crate is `#![forbid(unsafe_code)]`), no `cfg(any(...))`, no Windows API, no
  `goz_core::` import, no copied goz source.
- Seven-day rule: both `rayon` and every transitive package above were published at least seven days
  before this PR.
- No security setting changed; the workspace still builds with `--locked`.
