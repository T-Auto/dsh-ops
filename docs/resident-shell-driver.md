# Resident shell driver substrate

[中文](常驻-shell-驱动.md)

Issue #872's C2 slice adds one Windows persistent-shell driver on the C1 process substrate. It is independently runnable through `native/examples/shell_driver.rs`; it does not publish a tool, schedule session queues, change the default shell, replace the pinned Niubash runtime, or establish POSIX ownership.

The host supplies the exact public sandbox argv, working directory and complete environment. The fixed `residentShellBootstrap()` template receives only kernel-created pipe names. Command text is delivered later through a bounded private duplex channel. An authenticated prefix selects the actual command reader; Niubash's empty metadata opens do not establish a reader or output EOF.

All four pipe instances arm `ConnectNamedPipe` before a channel name is returned. Otherwise a fast metadata open and close can precede connection registration and produce `ERROR_NO_DATA`. A deterministic test holds each reader before registration and checks that the constructor cannot publish the endpoint. Removing just the readiness wait in an external source copy makes that test fail. This addresses the ordering documented by [Microsoft's ConnectNamedPipe API](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-connectnamedpipe), without accepting unauthenticated bytes or inventing EOF.

Nonempty `NIU_ENV`, `BASH_ENV` and `ENV` entries are rejected case-insensitively before spawning, with names-only diagnostics. A startup script must not silently enroll a daemon into the bootstrap baseline. After both command and startup acknowledgements, the driver retains handles to every actually owned bootstrap process. The launch root and authenticated shell PID must be present and alive. Subsequent checks require the same live process identities and exact Job membership, rather than a fixed process count. A Windows console can itself contribute an owned bootstrap process. New descendants are never added to the baseline.

Each command receives distinct stdout, stderr and completion pipes. The driver strips their trusted prefixes before counting user bytes, retains a bounded prefix of each stream, and continues draining beyond that bound. Completion requires the private terminal receipt, no running or stopped shell jobs, physical EOF on all three actual writers, and restoration of the held process baseline. A receipt followed by retained descriptors or surviving descendants has a bounded settlement window; it resets the one shell range instead of waiting indefinitely or implicitly promoting a background job.

The fixed template evaluates commands at top level, outside a conditional, so `set -e` keeps its ordinary behavior. Cwd, exports, functions and shell options persist. Default stdin is EOF on every call; an explicit command redirection applies to that call. An explicit command cwd persists into following calls. User `set -x` traces stay in that request's stderr; the trusted wrapper's own tracing goes to its default null streams. Arbitrary descriptor-table persistence is not part of the contract. `exit`, replacing `exec`, closed control descriptors and retained duplicates produce an honest reset when the completion protocol cannot be proved.

`Driver::check_live()` checks private control state and the held baseline before reuse. Idle loss must be reported before a replacement shell is considered. On any launch or command error, callers must stop and observe the owned range empty, then join every request capture before settling. Per-command output failure remains explicit; absence of a verified EOF is not converted into a complete stream.

## Reproducing the vertical proof

Build the example and TypeScript template:

```powershell
cargo build --locked --manifest-path native/Cargo.toml --example shell_driver
npm run build
node bench/probes/probe-872-shell-driver-direct.mjs <example.exe> <reviewed-candidate-niu.exe> <stock-support-niu.exe>
```

The probe launches the example through the pinned public subprocess provider and supplies exact public confinement argv for read-only and workspace-write, plus an unrestricted case. The candidate executable stays separate from the verified stock support tree; no shipped payload, manifest or pin is modified. Named-pipe ACL tests need a normal host context, since an outer tool sandbox can deny creation of the owner/logon-SID ACL.

The local reviewed Niubash backport candidate with SHA-256 `7c4332044ac5fd1b789f30b29c155a62f12f07f8dd3495244bda3ce4e0e84664` passes 18 direct-driver checks: startup-environment refusal, state and cwd retention in all three modes, xtrace/nounset, stdin reset, ordinary-output receipt forgery, waited external background output, two 1 MiB streams with 1024-byte retention, exit/exec/control loss, genuine errexit, four asynchronous command forms, and a bounded timeout with an unaffected sibling. Observed processes are gone before final emergency cleanup. The process crate has 22 passing unit tests and two explicitly invoked child fixtures; the fixtures are not skipped acceptance checks.

CI runs the same probe with `<stock-niu.exe> <stock-niu.exe> --stock-contract`. This explicit mode passes 19 capability-boundary checks, including a named assertion that the known stock asynchronous-output defect causes an observed-diagnostics error and owned shell reset. It does not silently omit that case or claim full feature support.

Stock Niubash 1.5 still has the independently reproduced background stdout/stderr routing bug. The full candidate proof is not a claim that the stock runtime or standard CI already supports this behavior. Dependency provenance, release packaging, session queue integration, public tool publication, explicit persistent jobs and cross-platform ownership remain separate work.
