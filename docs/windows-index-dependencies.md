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

## Direct dependency (2)

| Crate | Pin | Published (UTC) | License | Why |
| --- | --- | --- | --- | --- |
| `usn-journal-rs` | `=0.5.0` | 2026-10-13 | MIT | Safe wrappers over `FSCTL_ENUM_USN_DATA` for W1's cold MFT enumeration and, from W2, over the USN change journal. It keeps its own Win32 unsafe inside its crate. Runtime operation requires Administrator privileges, which is the documented fallback. MSRV 1.88, equal to this crate's floor. |
| `windows-sys` | `=0.61.2` | 2025-10-06 | MIT OR Apache-2.0 | W4's hard-link enumeration: `FindFirstFileNameW`, `FindNextFileNameW`, `FindClose` and `GetLastError`, with features `Win32_Foundation` + `Win32_Storage_FileSystem`. The package was already resolved in `native/Cargo.lock` through the workspace's other Windows crate, so this slice adds no new package; the direct edge is new. MSRV 1.71. |

Both dependencies are target-gated. `usn-journal-rs` itself contains
`#[cfg(not(windows))] compile_error!`, and `windows-sys` must stay at the workspace's single
0.61 line. Neither may appear in `ops-index` or in any other platform-agnostic crate.

### The crate's one unsafe boundary (W4)

Before W4 this crate was `#![forbid(unsafe_code)]`. `FindFirstFileNameW`/`FindNextFileNameW`
have no safe wrapper in any already-locked crate, so W4 opens exactly one boundary:

- the crate root denies `unsafe_code` globally and `unsafe_op_in_unsafe_fn` too;
- `#[allow(unsafe_code)]` is applied to the `winfs` module only;
- every unsafe block in `src/winfs/links.rs` carries a `SAFETY:` note and every search handle
  is closed exactly once by a drop guard.

That keeps the Windows FFI surface reviewable in one file without relaxing the rest of the crate.

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