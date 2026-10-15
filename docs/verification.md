# Verification: worker acceptance, platform probe, boundary diagnostics

Three tools, three questions:

| Tool | Question | Where it runs |
| --- | --- | --- |
| `test/worker-acceptance.test.mjs` | Does the worker and the bridge policy behave as documented? | every platform, part of `npm test` |
| `tools/syscall-probe/` | What does this kernel actually allow? | one process per operation, any Linux-like host |
| `tools/boundary-probe.mjs` | What do the open boundary reports do today? | observations, never a gate |

## 1. Worker acceptance (`npm test`)

The suite drives the native worker two ways — one JSON request per process, and
through the real host bridges (`lib/file/worker.js`, `lib/ptc/worker.js`) with
simulated policy/provider services. It never opens a real sandbox: the
confinement provider is a pass-through fixture, so a green run says nothing
about kernel enforcement on any platform.

Build the worker first, then run it directly or through the gate runner:

```sh
npm run build:rust            # or: cargo build --release --manifest-path native/Cargo.toml
npm run test:worker           # node test/run.mjs worker-acceptance
npm test                      # every suite, one child process each
```

Run it through `test/run.mjs` (as above) rather than invoking the file directly:
`test/lib/harness.mjs` refuses to start unless `DSH_HOME` points inside the
temporary directory, which is the runner's job — it gives every suite a throwaway
home so a suite that provisions a runtime cannot see another's leftovers. A bare
`node test/worker-acceptance.test.mjs` therefore exits 2 with that explanation
(and it is also how the suite behaves in this repository's own gate).

The suite **skips** (exit 77, counted as skipped rather than passed) when no
worker binary is available, and it prints a `note:` line instead of asserting
when a check cannot be meaningful on the host:

- the escape-denial check needs a fixture outside the platform temp directory,
  because `write_roots` legitimately includes it (see the report on
  `os.tmpdir()` in the write roots);
- the no-follow checks need an account that can create symlinks.

## 2. Platform probe (`tools/syscall-probe`)

One operation per process, so a `SIGSYS` kill cannot hide the operations that
follow it. Each line is `OP <name> <verdict> <detail>`; a kernel that terminates
a call reports `SIGSYS syscall=<nr>`, which is how the OpenHarmony denials were
identified rather than guessed.

```sh
sh tools/syscall-probe/run.sh
```

On an OpenHarmony host the host triple *is* the target, so a native build needs
no `--target` — only the linker and the SDK library path:

```sh
export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_OHOS_LINKER=aarch64-linux-ohos-gcc
export RUSTFLAGS="-L native=<sdk>/llvm/lib/aarch64-linux-ohos"
sh tools/syscall-probe/run.sh
```

Cross-building from another host additionally needs
`DSH_OPS_PROBE_TARGET=aarch64-unknown-linux-ohos`. `DSH_OPS_PROBE_DIR` moves the
probe's own scratch directory when `HOME` is not writable.

Reading the result:

- **absolute `std`/`cap-std` operations succeed, directory-relative ones die**
  (`openat2`, `SIGSYS`): the platform terminates the call, so no userspace
  fallback can observe it. The worker has to avoid that path on such kernels.
- **`/` and `/storage` unopenable while `stat` works**: this is the "fake root"
  shape. Absolute-path resolution cannot start at `/`, so it has to anchor at
  the deepest openable prefix — which is a property of the platform, not a
  policy.

## 3. Boundary diagnostics (`tools/boundary-probe.mjs`)

Reproduces the four open boundary reports against a real worker and prints what
the code does today. It asserts nothing and always exits 0, so it is safe to run
in CI-adjacent contexts and to re-run after a fix.

```sh
node tools/boundary-probe.mjs
```

It covers: reads outside the session workspace, write roots derived from
`os.tmpdir()`, a rewritten job manifest being executed by `resume`, and
audit-store growth per run (generations, and what can be reclaimed in band).


## 4. Environment assumptions (check these before trusting a green run)

Every tool below was written on one host and has to survive another. The column
that matters is the last one: what a *stranger's* environment does to it.

| Assumption | Acceptance suite | Syscall probe | Boundary probe |
| --- | --- | --- | --- |
| Host packages (`@deepseek-ai/*`) | **none** — the bridges only need three services, so the fixture is a plain object | none | none |
| `DSH_HOME` inside the temporary directory | required, and the gate runner supplies it | not used | not used |
| Writable temporary directory | required (`withTempDir`) | required (`DSH_OPS_PROBE_DIR` overrides) | required |
| Built worker binary | absent ⇒ suite exits 77 (skipped), never a green pass | n/a | refuses with exit 2 |
| Symlink creation | skipped with a `note:` when the account cannot create them | n/a | n/a |
| `/proc` mounted | not needed | used for `/proc/self/fd` reporting only | not needed |
| Hard links | not needed (an atomic publish is not used to create fixtures) | n/a | n/a |

Two rules follow, and both have already caught real defects here:

1. **Run a suite the way a stranger's CI would, before publishing it.** For this
   repository that means the gate runner with `DSH_HOME` unset:

   ```sh
   env -u DSH_HOME TMPDIR=<writable> node test/run.mjs worker-acceptance   # passes
   env -u DSH_HOME TMPDIR=<writable> DSH_OPS_WORKER_BIN=/nonexistent/worker \
     node test/run.mjs worker-acceptance                                  # skipped (77)
   ```

   A suite developed where `tmpdir()` happens to equal `$HOME` and `DSH_HOME` is
   already set will not notice that it depends on both.

2. **Verify the artifact that actually runs.** When a script or suite is copied
   to a remote host (or served over HTTP), print its digest next to the local one
   and compare. A cached or stale copy is otherwise indistinguishable from a fix
   that did not work.
