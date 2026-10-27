# macOS (arm64 and Intel x64)

Supported on **macOS 13 or later**, natively on Apple Silicon (`darwin-arm64`) and Intel
(`darwin-x64`). Exact native targets are `win32-x64`, `linux-x64`, `darwin-arm64` and
`darwin-x64`; the npm `os`/`cpu` projection is not a promise that every combination works.

Intel macOS 12.7.6 has a **manually tested, best-effort** APFS fallback; it is not an extension
of the general platform guarantee. It requires an ACL-free source and destination directory,
a compatible host and Node 22. macOS 12 on Apple Silicon is unverified. See [macOS 12](#macos-12).

## Native worker and source build

Published runtime-bearing packages use `runtime/darwin-arm64/dsh-ops-worker` or
`runtime/darwin-x64/dsh-ops-worker`, each with a version/target/executable/SHA256 receipt. A Git
checkout does not contain generated workers.

```console
npm ci --ignore-scripts
cargo build --release --locked --manifest-path native/Cargo.toml

# Apple Silicon
node bin/native-runtime.mjs stage --platform darwin-arm64 --input native/target/release
node bin/native-runtime.mjs check --platform darwin-arm64

# Intel
node bin/native-runtime.mjs stage --platform darwin-x64 --input native/target/release
node bin/native-runtime.mjs check --platform darwin-x64
```

`npm run build:ptc` builds and stages the host target, so it selects `darwin-arm64` on Apple
Silicon and `darwin-x64` on Intel. A custom `CARGO_TARGET_DIR` or `cargo --target` requires the
matching explicit stage `--input`; never stage an old default-directory build by accident. The
resolver refuses missing/corrupt receipts and targets outside the matrix.

## macOS 12

`replace`, `copy` and writes that overwrite an existing file stage a copy-on-write sibling. On
macOS 13, 14 and 15 (`xnu-8792`, `xnu-10002`, `xnu-11215`) the worker uses
`fclonefileat(..., CLONE_ACL)`. macOS 12 (`xnu-8020`) returns `EINVAL` for that flag, so the
worker retries without it only when the destination directory has no extended ACL.
Ordinary clone inherits directory ACLs, and `chmod 0600` does not remove them. The retry checks
both the source and the clone before writing; an extended ACL or failed probe rejects the operation
with `METADATA_UNSUPPORTED`. A source with an extended ACL remains unsupported on every macOS.
Failed rechecks remove the sibling. If removal fails, `CLEANUP_FAILED` with `effectState=unknown`
reports that unpublished bytes may remain; inspect the named sibling before retrying. New files and
read-only operations do not clone; this fallback does not change their behavior.

This is transitional compatibility, verified manually on Intel macOS 12.7.6 with Node 22.23.4.
The earlier host check used DSH 0.2.1-rc.2; only the versions declared by `engines.dsh` are eligible.
It does not establish compatibility with a newer host requiring Node 24. Official
[Node 24 macOS binaries require macOS 13.5+](https://nodejs.org/en/blog/migrations/v22-to-v24).
There is no macOS 12 CI leg, no macOS 12 arm64 verification and no claim that a CI-built release
binary has been run on macOS 12. A low Mach-O load minimum alone is not runtime verification.

## Shells

Bash is a **Windows-only optional npm payload** of the main package; PowerShell stays with the host.
npm installs no payload on a Mac and there is no postinstall downloader. macOS `ops_bash` is enabled
by default and resolves an explicit `bashPath`, then PATH and Homebrew/system locations:

- Apple Silicon Homebrew: `/opt/homebrew/bin/bash`
- Intel Homebrew: `/usr/local/bin/bash`
- System Bash: `/bin/bash`

```yaml
- id: dsh-ops-mode-standard
  name: dsh-ops/mode-standard
  config:
    bashPath: /opt/homebrew/bin/bash   # Intel Homebrew: /usr/local/bin/bash
```

`/bin/bash` is usable when Homebrew Bash is not installed. Restricted calls still require DSH
confinement; unavailable confinement is an executor failure, never permission to run unconfined.
The host disables its pwsh tool on macOS, so provisioning a pwsh executable does not create that
tool.

## PTC and filesystem boundaries

- file and opt-in PTC use the independent Rust worker.
- PTC tools publish only in pure PTC presentation. `batch.root` must be absolute when supplied;
  result paging of a batch audit must use the same root when it differs from the session root.
- macOS `/tmp` and `/var` are system aliases. The file bridge canonicalizes the **parent chain**,
  preserving the final entry for no-follow checks. Descendants of those aliases work; directly
  naming a symlink still fails closed. Canonical write-root checks remain in force.
- `replace` and overwrite operations on macOS require APFS clone support. macOS 13+ uses
  `CLONE_ACL`; the macOS 12 fallback requires an ACL-free source and destination directory
  and rechecks the source and clone. Unsupported clone operations fail before publication rather
  than dropping a deny entry. Ordinary mode/owner/xattrs
  are restored before the final fsync and rename.
- Hidden `.dsh-ops-update-*.lock` sidecars are cooperative path locks, removed by the writer that
  holds one. A sidecar left by a killed writer is reused and removed by the next write of that name;
  it is never a stuck lock.

## Verification evidence

- CI runs the full gate on `macos-latest` (arm64, blocking) and `macos-15-intel` (x64,
  non-blocking because the leg measured 318 s > 300 s; see [CI](ci.md)).
- The Intel leg builds and stages `darwin-x64`, runs all suites, checks the Mach-O x86_64 worker
  and its receipt, and packs/unpacks the artifact.
- After the ACL-inheritance repair, the rebased 0.5.0 checkout was tested manually on Intel
  macOS 12.7.6 with Node 22.23.4 and Rust 1.99.1, outside the agent sandbox:
  workspace Rust tests 54 passed / 0 failed; the full gate collected 150 JS suites,
  with 147 passed, 1 failed and 2 skipped (`tui-host` and `tui-native` need external checkouts).
  The failure is `review-snapshot`: Apple Git 2.37.1 lacks `git merge-tree --write-tree`.
  Build/stage, manifest (140 checks), pack/unpack and runtime receipts passed; the full gate
  is not green because of the Git-dependent failure.
- [The earlier contributor PR-event run](https://github.com/OldLigant/dsh-ops/actions/runs/39772711519)
  passed the full Intel macOS 15 gate. Its receipt-verified x86_64 Mach-O has a 10.12 load minimum;
  the macOS 12 result is manual, and CI verifies macOS 15. macOS 13/14 have not been exercised by
  that CI run. Apple's [xnu-8792 implementation](https://github.com/apple-oss-distributions/xnu/blob/xnu-8792.61.2/bsd/vfs/vfs_syscalls.c)
  accepts `CLONE_ACL` and copies the source ACL. Filesystem support is still required.
  That run predates this ACL-inheritance repair; the repaired branch still needs fresh PR-event CI.
- The fallback regression tests directly exercise the plain-clone body even on newer macOS,
  including directory/clone ACL refusal, source ACL changes, no-follow checks and cleanup failure.
  These tests do not simulate all concurrent metadata changes or replace macOS 12 artifact testing.
- 0.3.1 shipped Apple Silicon only; current support adds Intel on macOS 13+, with macOS 15 as the
  CI-verified path and Intel macOS 12.7.6 as manual best-effort compatibility. Desktop GUI sessions
  still require a normal app restart after replacing the package.
