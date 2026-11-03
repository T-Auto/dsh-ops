# ops-win-index dependency review

`native/crates/ops-win-index` is the Windows platform data source designed in #584. Its crate root
is `#![cfg(windows)]` and every dependency lives under
`[target.'cfg(windows)'.dependencies]`, so Linux and macOS builds compile an empty library and
resolve no Windows package at build time. The lockfile still records the Windows-target packages
because Cargo locks every target; the workspace's `--locked` checks therefore cover them too.

This page is the dependency record for the crate. Every direct dependency names an exact version and
its crates.io publication date (checked against the crates.io API on 2026-11-04 UTC+08); the
lockfile pins the transitive graph. Full licence texts are in
[`licenses/windows-index/THIRD-PARTY-NOTICES.txt`](../licenses/windows-index/THIRD-PARTY-NOTICES.txt).

## Direct dependency (3)

| Crate | Pin | Published (UTC) | License | Why |
| --- | --- | --- | --- | --- |
| `usn-journal-rs` | `=0.5.0` | 2026-10-13 | MIT | Safe wrappers over `FSCTL_ENUM_USN_DATA` for the cold MFT enumeration and over the USN change journal for the tail. It owns the slice's only Win32 code: this crate stays `#![forbid(unsafe_code)]` and names no raw Windows type. Runtime operation requires Administrator privileges, which is the documented fallback. MSRV 1.88, equal to this crate's floor. |
| `cap-std` | `3.4.6` | 2026-08-20 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | Opens the volume root and reads its directory metadata, so `Candidate.key.volume` is exactly the serial cap-fs-ext reports as `dev()`. The same crate the integration already uses for its candidate re-verification, so the two cannot drift. Ambient authority is used once, on the volume root, for metadata only. |
| `cap-fs-ext` | `3.4.6` | 2026-08-20 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | The `MetadataExt` implementation behind `dev()` and `ino()`: `Candidate.key.file` is the full 64-bit nFileIndex cap reports as `ino()`. Already resolved in `native/Cargo.lock` through the workspace root; this slice adds the direct edge only. |

All three are target-gated. `usn-journal-rs` itself contains
`#[cfg(not(windows))] compile_error!`, so it must never appear in `ops-index` or in any other
platform-agnostic crate. `cap-std`/`cap-fs-ext` are the same safe metadata layer the
integration uses: reading the volume serial and file index through it is what makes
`Candidate.key` compare equal to the integration's `(dev, ino)` instead of drifting into a
fallback. Both were already direct dependencies of the workspace root and remain locked at 3.4.6;
this slice adds no package, only the two edges and their licence texts.

## Transitive packages resolved for the Windows target

These packages are not written by this crate; they come from `usn-journal-rs` and its Windows
bindings. Versions were read from `native/Cargo.lock` and the licence fields from the extracted
crate sources, not guessed.

| Package | Version | Published (UTC) | License | Role |
| --- | --- | --- | --- | --- |
| `foldhash` | 0.2.0 | 2025-08-23 | Zlib | Hashing used by the hash table inside `lru` |
| `log` | 0.4.34 | 2026-08-22 | MIT OR Apache-2.0 | Logging facade called by `usn-journal-rs` |
| `lru` | 0.18.5 | 2026-09-23 | MIT | Directory cache in the live path resolver |
| `syn` | 2.0.119 | 2026-07-15 | MIT OR Apache-2.0 | Proc-macro parser for the derive macros below |
| `thiserror` | 2.0.21 | 2026-09-23 | MIT OR Apache-2.0 | Error derive used by `usn-journal-rs` |
| `thiserror-impl` | 2.0.21 | 2026-09-23 | MIT OR Apache-2.0 | Derive implementation of `thiserror` |
| `windows` | 0.62.2 | 2025-10-06 | MIT OR Apache-2.0 | Win32 bindings used by `usn-journal-rs` |
| `windows-collections` | 0.3.2 | 2025-10-06 | MIT OR Apache-2.0 | Collection types for the `windows` bindings |
| `windows-core` | 0.62.2 | 2025-10-06 | MIT OR Apache-2.0 | Core traits and handles for `windows` |
| `windows-future` | 0.3.2 | 2025-10-06 | MIT OR Apache-2.0 | Async plumbing for the `windows` bindings |
| `windows-implement` | 0.60.2 | 2025-10-06 | MIT OR Apache-2.0 | Derive support for `windows` |
| `windows-interface` | 0.59.3 | 2025-10-06 | MIT OR Apache-2.0 | Interface macros for `windows` |
| `windows-numerics` | 0.3.1 | 2025-10-06 | MIT OR Apache-2.0 | Numeric types for `windows` |
| `windows-result` | 0.4.1 | 2025-10-06 | MIT OR Apache-2.0 | Result and error types for `windows` |
| `windows-strings` | 0.5.1 | 2025-10-06 | MIT OR Apache-2.0 | String types for the `windows` bindings |
| `windows-threading` | 0.2.1 | 2025-10-06 | MIT OR Apache-2.0 | Threading helpers for `windows` |

`log` is deliberately held at 0.4.34 (2026-08-22): the newest resolution, 0.4.35 (2026-10-30),
was less than seven days old when this slice was prepared, so the lockfile keeps the older
version, the same discipline the documents dependency review applies. Every listed version is at
least seven days old on 2026-11-04 UTC+08 and none is yanked.

Packages already present in `native/Cargo.lock` before this slice (`proc-macro2`, `quote`,
`unicode-ident`, `windows-link`, `windows-targets`, `windows-sys` 0.61) are recorded by the crate
that introduced them; this slice adds no second version of them.

## MSRV, security and platform boundary

- `usn-journal-rs` 0.5.0 and every newly locked package declare `rust-version` at or below 1.88,
  the workspace floor. CI installs 1.97.1 and builds with `--locked`.
- The Win32 surface is confined to `usn-journal-rs`; `ops-win-index` uses only its safe API. No raw
  `windows` type appears in this crate's source, so the crate keeps `#![forbid(unsafe_code)]`.
- `windows` 0.62 coexists with the workspace's existing `windows-sys` 0.61. That only affects
  Windows compile time and lock size; Linux and macOS builds compile neither.
- W1 does not support ReFS: a 128-bit file id cannot become the 64-bit half of
  `ops_index::FileKey`, so an extended id makes the slice answer `Unsupported`.
- Runtime privilege: opening a volume handle requires Administrator. Without it the source reports
  `Unsupported` and callers fall back to their own traversal; no error is fabricated.
