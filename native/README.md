# dsh-ops native worker (dsh-ops-core)

Rust implementation of the dsh-ops native file worker (`dsh-ops-worker`).
Built with `cargo build --release`; the resulting binary speaks a
request/response JSON protocol on stdin/stdout (see `src/main.rs`).

## Platform notes

### OPENAT2_SIGSYS (openharmony)

On `aarch64-unknown-linux-ohos` the kernel terminates any process that
issues the `openat2` syscall (SIGSYS; observed as exit status 159). The
failure is not observable from userspace: `cap-primitives` only falls back
from `openat2` to plain `openat` when the kernel reports `ENOSYS`, which
never happens there.

The vendored `vendor/cap-primitives` copy therefore makes `open_beneath()`
report `ENOSYS` outright when compiled for `target_env = "ohos"`, which
routes every caller — including the direct `open_beneath` callers in
`stat_impl`, `canonicalize_impl` and `open_entry_impl` — through the
portable `manually::open` fallback that uses `openat` + path-walk
checks. All other targets keep the upstream `openat2` fast path
unchanged.

Two further OHOS-only differences are guarded in `native/src`:

1. `/` and `/storage` cannot be opened at all (`EACCES`/`EPERM`), so
   `src/file_path.rs` anchors at the deepest openable ancestor prefix
   instead of the filesystem root.
2. `fsync` on the `O_PATH` directory fds cap-std hands out fails with
   `EBADF`, so the rename-then-fsync sites in `src/file.rs` and
   `src/store.rs` reopen the enclosing directory by path on OHOS and
   flush that handle instead (best-effort; the rename itself is already
   atomic). Other unix targets flush the cap-std handle directly.
