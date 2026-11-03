# Index integration (G3)

This page records how the index data sources reach the search path after slices P0–P7, M1, L1,
W1, G1 and G2. It is written for operators and reviewers: it says what is wired, what it costs,
and what still falls back.

## What is wired

- **A private cache directory.** When the operator sets `indexCache: true` in the plugin row, the
  host resolves `<DSH_HOME>/dsh-ops/index-cache`, creates it when missing and, on POSIX, forces
  mode `0700`. On Windows Node cannot set an ACL, so the directory inherits the `%USERPROFILE%`
  ACL and only its read-only attribute is controlled; privacy there is the profile ACL, not a mode
  bit. A symlinked `dsh-ops` or `index-cache` entry, or a path that resolves outside the home, is
  refused and no `cache_dir` is sent. `DSH_HOME` is the same home the plugin already uses (default
  `~/.dsh`); preparation happens once per worker call at most and never exposes the path to the
  model.
- **An envelope hint.** The prepared path travels to the worker as `cache_dir` in the request
  envelope. It is host metadata, not a tool argument: no `ops_glob`/`ops_grep` argument can set or
  override it, and the worker only treats it as a hint.
- **Per-request source selection.** With `cache_dir` present, `ops-search` constructs the platform
  source for the build target and asks the revalidating traversal (`Scan::walk_indexed`) for an
  answer. Only `glob` requests take this path (G3 boundary); `grep` reads file content and keeps
  the live traversal until its own integration slice. The platform crates are target-gated
  dependencies: Windows builds link `ops-win-index`, Linux builds `ops-linux-index`, macOS builds
  `ops-mac-index`; only one is ever compiled, and the pure `ops-index` crate keeps no platform
  dependency.
- **A source-kind cursor.** A continuation token names the traversal that produced its snapshot
  (`s1:` for the walk, `s2:` for the index path). Page two is bound to that kind; if the traversal
  that serves it differs, the page is rejected as `SEARCH_STALE` instead of mixing snapshot
  domains.

## What it costs, and what it never costs

Index caching is off by default. With it off, the host prepares no directory, sends no
`cache_dir`, and every search takes exactly the traversal it took before this slice.

With it on, the host has one bounded preparation attempt per call. Any failure — a home that does
not exist, `EACCES`, a full disk, a path that is not a directory, a mode that cannot be enforced, a
symlinked cache path — is swallowed: no `cache_dir` is sent and the worker walks. An indexing
failure is never a search failure.

## What still falls back (and why)

The platform sources delivered by M1, L1 and W1 answer a cold enumeration but cannot prove a
snapshot is caught up: no FSEvents stream, inotify watcher or USN replay exists yet. Their
`state` therefore answers `Unsupported`/`Unavailable`, never `Ready`, and
`Scan::walk_indexed` falls back to the live walk on every request. Output, counters and
`scanComplete` are therefore identical to the previous release — the wiring exists so the watcher
slices can turn it on, not to change results today.

Window and Apple watcher slices (M2/M3, L2/L3, W2/W3/W4) and snapshot persistence (PS1–PS3) are
what will make a page come from the index. Until then a saved `cache_dir` alone never changes an
answer, and a `cache_dir` the worker cannot use never breaks one.

## Verification

- Rust: per-request selection, the `glob`-only gate and fallback are covered by `ops-search` tests
  with a fake `Ready` source (`cfg(test)` only; no test bypass exists in `native/src`): the indexed
  glob output is byte-identical to the walk, `grep` never consults a source even with a cache
  hint, a cache directory without a ready source falls back, page two of an indexed query
  resumes, and an indexed continuation replayed through the walk is `SEARCH_STALE`.
- Host: `test/index-cache.test.mjs` covers the disabled default, directory creation with mode
  `0700` on POSIX, narrowing an existing wider directory, refusing symlinked cache paths, and
  `EACCES`/`ENOSPC`/unenforceable-mode fallbacks (no `cache_dir`, no thrown error).
- Three-platform CI: each leg compiles the matching platform crate and runs the fallback tests.
