# Building and running dsh-ops on Linux x64 and arm64

Linux x64 and Linux arm64 (aarch64) are supported targets for the **file**,
**ptc** and **shell** components. On Linux the shell component's `ops_bash` runs
the distribution's own bash (see [Configuring the shell lane](#configuring-the-shell-lane));
the bundled PowerShell 7 and the bash IPC proxies remain Windows x64 only.

Nothing on Linux is downloaded with the package: the native workers are staged
locally from source, which is why this page exists. The npm package still
carries the Windows x64 payloads (`@dsh-ops/*-win32-x64`); Linux has no payload
packages to fetch. `linux-arm64` is a **locally staged** target: the published
release matrix (`RELEASE_TARGETS`) still ships only `win32-x64`, `linux-x64`,
`darwin-arm64` and `darwin-x64`; an arm64 host builds the worker from source and
stages it under `runtime/linux-arm64` with its own provenance receipt.

| Component | Linux x64 / arm64 | Notes |
| --- | --- | --- |
| `dsh-ops/mode-standard` | yes | resident OPS file tools and `ops_bash` over the host bash; no official tool is replaced on Linux |
| `dsh-ops/mode-cordis` | yes | same surface as Standard, with its own routing section |
| `dsh-ops/mode-minimal` | yes | dynamic-loading entry and `ops_bash` |
| `dsh-ops/mode-ptc` | yes | PTC SDK: `ops_batch`, `ops_result` and the typed catalogue |

## Prerequisites

| Requirement | Version | Why |
| --- | --- | --- |
| Node.js | `^22.19 \|\| >=24` | `package.json` `engines` |
| Rust | `1.88` or newer (`cargo`) | `native/Cargo.toml` `rust-version` |
| pnpm | any recent | `dsh plugin` forwards to it |
| DSH | `0.2.0-rc.2` | the host this release targets |

## 1. Get the source

```console
$ git clone https://github.com/T-Auto/dsh-ops.git
$ cd dsh-ops
```

## 2. Install dependencies

```console
$ npm install
added 45 packages in 499ms
```

The root package declares `"os": ["win32", "linux"]`, so npm applies no platform
veto here. On a tree whose `os` list is still Windows-only — the published 0.3.0
tarball, for instance — the same command stops at `EBADPLATFORM`, and the
published `npx dsh-ops@latest install` entry point is unusable on Linux for that
reason. See [Installing into a profile](#5-install-into-a-profile) for the path
that works regardless of how the tarball was published.

If you do need to force a Windows-only tree to install on Linux, `npm install
--force` does it; note that this also skips npm's script gate. Three
dependencies ship install scripts (`node-pty`, `koffi`,
`@deepseek-ai/dsh-subprocess-local`); the suites that need them will say so
rather than pass silently.

## 3. Build the native worker

```console
$ npm run build:ptc
toolchain: cargo 1.98.1
    Finished `release` profile [optimized] target(s) in 3.05s
linux-x64: 3665672 bytes, sha256 327420ad9660…f9c8b0efc9445c0c
Validated 1 native runtime(s); no install-time scripts or permission changes.
```

This compiles `native/` and stages the result into the install-relative layout
the runtime resolver reads:

```text
runtime/linux-x64/dsh-ops-worker
runtime/linux-x64/provenance.json
```

`provenance.json` carries the target, the package version, the executable name
and the SHA-256 of the binary. `resolveWorker()` re-derives that digest on every
resolution and refuses a staged worker whose receipt does not match, so a
half-copied or hand-edited `runtime/` fails closed instead of running.

Verify it is wired up:

```console
$ node bin/dsh-ops.mjs ladder
```

The first section of the report, `Native worker (file tools)`, names the staged
worker and where it was resolved from.

## 4. Verify on this machine

The gate has three outcomes — passed, failed, skipped — and a skip is never
counted as a pass. `DSH_OPS_REQUIRE_RUNTIME=1` turns a skip into a failure (for
example a native-worker suite run before `npm run build:ptc`), so this is the
strictest form:

```console
$ DSH_OPS_REQUIRE_RUNTIME=1 npm run verify
```

Suites whose subject is another platform (Windows ACLs, for instance) skip
themselves and say so in the summary line.

The Rust worker's own barrier test:

```console
$ cargo test --release --locked --manifest-path native/Cargo.toml
test result: ok. 1 passed; 0 failed
```

### Linux boundary suites

Six suites drive the shipped worker directly, on edges the host bridge would
otherwise normalise away. They live in `test/linux-*.test.mjs` and share
`test/lib/boundary.mjs`:

| Suite | Subject |
| --- | --- |
| `linux-paths` | awkward and CJK names, name/NUL length limits, depth, symlink refusal |
| `linux-args` | `offset`/`limit` edges, glob patterns, regex safety, context cap, honest paging |
| `linux-sandbox` | `read_only`, `write_roots` containment, symlink refusal, special objects |
| `linux-protocol` | malformed frames, oversized requests, repetition, concurrent atomicity |
| `linux-attributes` | content/mtime/no-debris, hardlink inode swap, `0444`, sparse files |
| `linux-scope` | platform gate, provenance tamper/forgery, three-layer scope, staged digest |

They are written so that a Windows run never reports a Linux-only check as
passed: `linux-attributes` skips as a whole, `linux-paths` and `linux-sandbox`
guard their POSIX-only cases in place, and the other three are platform-neutral.
Known open defects are deliberately **not** asserted, so that fixing one does not
turn the gate red; each suite header names the finding it leaves untested. A
cross-platform fix brings its own suite rather than borrowing a Linux-named one —
`inspect-hex` covers the hex row semantics of report L2, `output-budget` the
96 KiB response ceiling of L4, `replace-concurrency` the update lock of L14, `file-metadata` the metadata
preservation of L1/L9 and `grep-multiline` the cross-line matching of L6.
What still needs a
Windows host is listed in
[Windows verification](windows-verification.md).

### Closing the release question on Linux

`npm run verify:release` adds the release closure on top of the gate above. It
derives the declared scope from `package.json`, asserts it equals the resolver's
`PLATFORMS`, then validates the targets this package actually stages. On a
Linux-only build that is `linux-x64`, and the Windows IPC closure is reported as
skipped rather than silently implied:

```console
$ npm run verify:release
…
dsh-ops test: 30 suite(s) passed in 15s
linux-x64: 3665672 bytes, sha256 327420ad…
Release closure OK: dsh-ops@0.3.1, linux-x64 worker (Bash IPC closure skipped: win32-x64 is not staged; DSH_OPS_REQUIRE_ALL_TARGETS=1 demands it).
```

`npm run check:ptc-runtime` answers the narrower question — are the staged
runtimes intact? — which is why it too passes on a one-host build:

```console
$ npm run check:ptc-runtime
linux-x64: 3665672 bytes, sha256 327420ad…
Validated 1 native runtime(s); no install-time scripts or permission changes.
```

A bare `node bin/native-runtime.mjs check` still demands **every** declared
platform, because that is the question the release packager asks before it
publishes. Set `DSH_OPS_REQUIRE_ALL_TARGETS=1` when you are assembling a
cross-platform release and a missing platform must be a failure.

## 5. Install into a profile

`npx dsh-ops@latest install` is the documented Windows path and requires a
Windows-only npm tarball. On Linux, install from the checkout through DSH's own
plugin manager, which forwards to pnpm:

```console
$ dsh plugin --profile <profile> add /absolute/path/to/dsh-ops
```

To install a build you already made elsewhere, pack it first (the `files` list
ships `runtime/`, so the staged worker travels with the tarball):

```console
$ npm pack
$ dsh plugin --profile <profile> add ./dsh-ops-0.3.1.tgz
```

Confirm what the host composed:

```console
$ dsh --profile <profile> --dump-config
```

## Configuring the shell lane

`ops_bash` works on Linux out of the box: every enabled mode row resolves the
distribution's own bash (`config.bashPath` → `PATH` → `/bin/bash`,
`/usr/bin/bash`, `/usr/local/bin/bash`) instead of shipping one, and a confined
mode must be confined by a host sandbox — if none can confine the call it is
refused, never run unrestricted.

To use a different bash, name it explicitly on a mode row:

```yaml
- id: dsh-ops-mode-standard
  config:
    bashPath: /usr/bin/bash
```

> `allowSystemShellFallback` has no effect on Linux: the host bash is already
> the rung. A configured `bashPath` is authoritative: it wins over PATH and the
> well-known locations.

## Troubleshooting

| Symptom | Cause | Remedy |
| --- | --- | --- |
| `Unsupported runtime target linux-x64` | a build whose `PLATFORMS` list predates Linux support | use a version that lists `linux-x64`, or build from a checkout that does |
| `Error: Unsupported target` from `build:ptc`, after a successful compile | the stage step rejected the target | same as above; the compile itself is fine |
| `npm error code EBADPLATFORM` | the published tarball declares `os: ["win32"]` | install from a checkout/`npm pack` through `dsh plugin` |
| file tools silently missing, no error | `resolveWorker()` threw and the component degraded: `required` defaults to `false` | set `required: true` on the `dsh-ops/mode-standard` row to make it loud |
| `Bad file descriptor (os error 9)` in `preflight` | the audit store or atomic replace synced a directory handle that cap-std opened `O_PATH` on Linux, where `fsync` is refused | fixed in `native/src/lib.rs`; rebuild with `npm run build:ptc` |
| a denied command reports a generic failure instead of `POLICY_DENIED` | the host's English denial signatures were matched against a localized libc message | the bash lane pins `LC_MESSAGES=C`; a non-English host on an older build shows this |

## Why a local build

The npm package ships Windows x64 payloads only. A Linux deployment therefore
has no downloaded worker to fall back on, and the plugin's runtime resolution is
installation-relative by design: it will not silently pick up a binary from an
unrelated location. Building from the checkout is the supported path, and every
artefact it produces is digest-checked before it runs.
