# ops-index dependency review

`native/crates/ops-index` is a platform-agnostic library: it never calls an OS API, never opens a
file and never starts a process. Its runtime dependencies are pure algorithms, and its property
tests are dev-only. This page is the dependency record for the crate. Every addition names an exact
version, its crates.io publication date (checked against the crates.io API on 2026-11-04 UTC+08) and
the reason it is needed. Full license texts are in
[`licenses/index/THIRD-PARTY-NOTICES.txt`](../licenses/index/THIRD-PARTY-NOTICES.txt).

## Runtime dependencies (3)

| Crate | Pin | Published (UTC) | License | Why |
| --- | --- | --- | --- | --- |
| `unicode-normalization` | `=0.1.26` | 2026-10-16 | MIT OR Apache-2.0 AND Unicode-3.0 | Canonical NFC/NFD normalization for the case-fold key (P1). APFS/HFS+ deliver NFD names and NTFS/ext4 deliver NFC; without normalization the same name would index as two. Pure Rust, no build script, no OS call. |
| `fs2` | `=0.4.3` | 2018-01-06 | MIT OR Apache-2.0 | Advisory file lock for the snapshot writer (PS2, #600). Already in the workspace lock through `ops-files`; exact pin, MIT text in `licenses/index/THIRD-PARTY-NOTICES.txt`. This is the one explicit exception to the #584 whitelist, required by #586 for locked publication and GC serialisation. |

The license needs the `Unicode-3.0` identifier in addition to MIT/Apache-2.0 because the crate
embeds Unicode data files. MIT is the selected alternative where a choice exists.

## Dev-only dependency (1)

| Crate | Pin | Published (UTC) | License | Why |
| --- | --- | --- | --- | --- |
| `proptest` | `=1.12.0` | 2026-10-10 | MIT OR Apache-2.0 | Property tests for the WTF-8 round trip over arbitrary `u16` sequences and for the decoder's totality over arbitrary bytes (P1). The `fork` and `timeout` features are disabled (`default-features = false, features = ["std"]`) so Windows CI spawns no subprocess. |

## Registered for later slices (not in `Cargo.toml` or `Cargo.lock` yet)

Design #584 allows these crates, but a slice adds one only when it uses it. The versions and
publication dates are recorded now so a later slice does not have to re-litigate the seven-day
rule; each slice still commits `native/Cargo.lock` and extends
`licenses/index/THIRD-PARTY-NOTICES.txt` with the packages the lock actually resolves.

| Crate | Pin | Published (UTC) | License | Planned use |
| --- | --- | --- | --- | --- |
| `hashbrown` | `=0.17.1` | 2026-05-09 | MIT OR Apache-2.0 | Name intern table that stores only a 4-byte id (P5). It is already in the workspace lock through `indexmap`. |
| `rustc-hash` | `=2.1.3` | 2026-07-02 | Apache-2.0 OR MIT | `FxHashMap` for the sparse record map (P5). |
| `memchr` | `=2.8.3` | 2026-07-08 | Unlicense OR MIT | SIMD substring search for query patterns (P7). Already in the workspace lock through other crates. |
| `rayon` | `=1.12.0` | 2026-04-14 | MIT OR Apache-2.0 | Deterministic parallel name scan behind the query API (P7). Results are merged in chunk order, never in completion order. |

The whitelist is closed: `zerocopy` (its derive emits `unsafe impl`, which collides with the
crate-level `#![forbid(unsafe_code)]`), `thiserror`, `smallvec`, `regex` and `mimalloc` are not
used. Platform sources (`usn-journal-rs`, `notify`) belong to the platform crates, never here.

## Transitive packages currently locked

The lockfile (committed in the same PRs) resolves these packages in addition to the two direct
dependencies above. MIT is selected where a package offers a choice; the Unicode-3.0 text is
retained for `unicode-normalization` because its data files require it.

| Package | Version | License | Role |
| --- | --- | --- | --- |
| `autocfg` | 1.5.1 | Apache-2.0 OR MIT | Build script of `num-traits` |
| `chacha20` | 0.10.2 | MIT OR Apache-2.0 | RNG used by `rand` |
| `core_detect` | 1.0.0 | MIT OR Apache-2.0 | CPU feature detection for `cpufeatures` |
| `cpufeatures` | 0.3.1 | MIT OR Apache-2.0 | Runtime feature detection |
| `num-traits` | 0.2.19 | MIT OR Apache-2.0 | Numeric traits for `rand` |
| `rand` | 0.10.3 | MIT OR Apache-2.0 | RNG for `proptest` |
| `rand_core` | 0.10.1 | MIT OR Apache-2.0 | Core RNG traits |
| `rand_xorshift` | 0.5.0 | MIT OR Apache-2.0 | Deterministic generator for `proptest` |
| `tinyvec` | 1.13.3 | MIT OR Apache-2.0 OR Zlib | Small-vector storage inside `unicode-normalization` |
| `unarray` | 0.1.4 | MIT OR Apache-2.0 | Array helper for `proptest` |
| `unicode-normalization` | 0.1.26 | MIT OR Apache-2.0 AND Unicode-3.0 | Direct dependency (above) |
| `proptest` | 1.12.0 | MIT OR Apache-2.0 | Dev-only (above) |

## MSRV and resolution

`native/Cargo.toml` declares `rust-version = "1.88"` and CI builds with the pinned `1.97.1`
toolchain. Every listed version declares a `rust-version` at or below 1.88, and the lockfile is
committed and used with `--locked`, so a silent `cargo update` cannot raise the floor. Cargo's
MSRV-aware resolver also refuses to pick a version above the workspace floor.