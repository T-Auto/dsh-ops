# ops-mac-index dependency review

`native/crates/ops-mac-index` is the macOS producer for the `ops-index` data-source boundary. It
reads directory trees and per-entry metadata; it never opens file content, never starts a process and
never authorizes a caller. It has three third-party dependencies, all declared under
`[target.'cfg(target_os = "macos")'.dependencies]`: `rayon` for the cold walk (M1) and the two
`objc2` binding crates for the FSEvents stream (M2). The crate itself is
`#![cfg(target_os = "macos")]` (an empty library elsewhere), so Linux and Windows workspace builds
compile neither the crate body nor those dependencies. The traversal is `std::fs::read_dir`
recursion, with `rayon` fanning out sibling directories and the per-entry `stat`. This page is the
dependency record for the crate. Every addition names an exact version, its crates.io publication
date (checked against the crates.io index on 2026-11-04 UTC+08) and the reason it is needed. Full
license texts are in
[`licenses/mac-index/THIRD-PARTY-NOTICES.txt`](../licenses/mac-index/THIRD-PARTY-NOTICES.txt).

## Runtime dependencies (3, macOS-only)

| Crate | Pin | Published (UTC) | License | Why |
| --- | --- | --- | --- | --- |
| `rayon` | `=1.12.0` | 2026-04-14 | MIT OR Apache-2.0 | Work-sharing for the cold walk (M1): sibling directories are scanned in parallel and each collected entry's `stat` is mapped in parallel. #423 measured `symlink_metadata` at 71–87 % of a walk, which is the part worth spreading over threads. Used only in `src/walk.rs`; `ops-index` never depends on it. |
| `objc2-core-services` | `=0.3.2` | 2025-10-04 15:47:08 | Zlib OR Apache-2.0 OR MIT | Generated bindings for the FSEvents C API (M2): `FSEventStreamCreate`/`Start`/`Stop`/`Invalidate`/`Release`, the callback and context types, event ids and both flag sets. Only the `FSEvents` framework feature is enabled, not the crate's default "every framework" set. |
| `objc2-core-foundation` | `=0.3.2` | 2025-10-04 15:46:51 | Zlib OR Apache-2.0 OR MIT | CoreFoundation types that API takes and returns: `CFArray`/`CFString` for the watched paths and run-loop mode, `CFDictionary`/`CFNumber` for the extended per-event data. Features are limited to `std`, `CFString`, `CFDictionary` and `CFNumber`; `CFArray`, `CFDate`, `CFRunLoop` and `CFUUID` arrive through the `FSEvents` feature above. |

All three are exact pins. `rayon-core` 1.13.0 declares MSRV 1.80 and the workspace floor is 1.88, so
the `rayon` pin cannot silently raise it. The `objc2` 0.3 line is the newest published series for
these bindings and declares MSRV 1.71, so a version range could only pull a future 0.4 that renames
Apple framework bindings.

## M2 lock delta (2 packages)

The `FSEvents` feature of `objc2-core-services` depends only on `objc2-core-foundation`, and the
selected CoreFoundation features depend on nothing beyond `bitflags`, which was already locked
(`bitflags 2.13.2`, through `rustix`/`nix`). So the M2 lockfile grows by exactly two packages:

| Package | Version | Published (UTC) | License |
| --- | --- | --- | --- |
| `objc2-core-services` | 0.3.2 | 2025-10-04 15:47:08 | Zlib OR Apache-2.0 OR MIT |
| `objc2-core-foundation` | 0.3.2 | 2025-10-04 15:46:51 | Zlib OR Apache-2.0 OR MIT |

No `dispatch2`, `block2`, `objc2`, async runtime or build script enters the tree.

## Why the FSEvents bindings are `objc2` (M2)

- **Hand-written `extern` declarations would duplicate a maintained ABI surface.** FSEvents is a C
  API over CoreFoundation objects: the callback signature, the packed `FSEventStreamContext` and the
  extended-data dictionary keys all have to match the SDK headers exactly, and a silent mismatch
  shows up as memory corruption rather than a compile error.
- **`fsevent-stream` stays rejected.** `reports/deps.md` §4.2 declined it as async-only (a tokio
  `Stream`), unmaintained since 2022 and two generations behind CoreFoundation. This crate needs a
  synchronous, bounded batch inside one worker call, which is exactly the shape the framework C API
  offers.
- **The wiring stays target-gated.** The crate only compiles on macOS and the dependencies only
  resolve for that target, so the Linux and Windows workspace builds are unchanged.
- **The unsafe surface is one audited module.** `src/ffi.rs` owns every pointer and every framework
  call; the crate root denies `unsafe_code` and re-allows it there, `unsafe_op_in_unsafe_fn` is
  denied so each block opts in, and every block carries a SAFETY comment. `src/fsevents.rs` is safe
  Rust with a safe API (`EventStream`, `Event`, `Batch`).
- **Scheduling uses the deprecated run-loop entry point on purpose.**
  `FSEventStreamScheduleWithRunLoop` is marked deprecated in favour of dispatch queues, but this
  crate drives one bounded batch from the caller's own run loop and is deliberately not `Send`; the
  dispatch-queue replacement would pull `dispatch2` (and `block2`/`objc2`) into the lockfile for
  the same single-threaded delivery. The call site is annotated with `#[allow(deprecated)]` and a
  comment, so the deprecation is a recorded decision rather than a warning everyone ignores.

## Transitive packages currently locked (5)

The lockfile resolves these packages in addition to the three direct dependencies above. M2 adds no
further package. MIT is selected where a package offers a choice.

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

- `ops-index` stays dependency-free of platform crates and of `rayon`/`objc2`: the trait owner is
  pure, the platform crate owns the OS work.
- The crate is not "no unsafe"; it is one audited island. `unsafe` is denied everywhere except
  `src/ffi.rs`, which has no public API and is not reachable without a SAFETY comment per block.
- No `cfg(any(...))`, no Windows API, no `goz_core::` import, no copied goz source. The only
  `cfg` is the crate-level `target_os = "macos"` gate.
- Seven-day rule: every package above was published at least seven days before this PR (the `objc2`
  0.3.2 pair on 2025-10-04, over a year earlier).
- No security setting changed; the workspace still builds with `--locked`.
