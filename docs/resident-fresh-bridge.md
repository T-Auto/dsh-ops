# Resident fresh Bash bridge

[中文](./常驻-fresh-桥接.md)

This #872 slice connects the existing `ops_bash` wrapper to the internal native task adapter.
Production selection requires **both `task-v1` and `task-spill-v1`**. The Windows worker now provides
[recoverable task spill and settled-file retention](resident-task-spill.md), so normal root activation
uses the shared native task adapter for fresh calls. Workers without both capabilities retain their
existing executor. There is no user or configuration bypass. Persistent session mode remains pending.

The main row mounts one `residentFreshTasks()` provider after its `residentKernel()` provider.
Standalone integrations can mount the same pair once in their common owning activation:

```ts
import { integration, residentKernel, residentFreshTasks } from 'dsh-ops/integration'

export async function apply(ctx) {
  await ctx.plugin(residentKernel())
  await ctx.plugin(residentFreshTasks())
  await ctx.plugin(integration({ preset: 'my-preset', profile: 'native' }))
}
```

The authority service is owned by the dependency fiber, never by the first tool caller or a global
singleton. Complete-capability publication waits for that service. Once a consumer selects it,
provider loss withdraws its Bash layer and retained callbacks refuse further work; it does not
switch back to a per-call runner. Sibling Agents share the provider but retain distinct native
owners. An exact publishing Agent is required when invoking a retained definition.

Argument validation, cwd resolution, approval, Native rendering, PTC schema and JSON digest stay
in the existing wrapper. Initial approval finishes before a public Jobs record is registered.
At each native queue head the bridge reads the current exact Agent/Session, policy and managed
environment, prepares the selected runtime, and passes the **exact public-confined argv** and
complete scrubbed environment to native execution. It checks authority again after asynchronous
runtime/confinement work. A queued ordinary call uses current standing policy; a one-call wider
grant is refused if its standing authority changed. Active calls are cancelled after authority
changes, while queued calls remain eligible for fresh admission.

`command` still uses `-c`; `script_path` remains one unchanged argv operand opened by Bash under
confinement and the resolved cwd. It is neither read nor inlined by the host. Existing timeout
caps, fractional positive timers, closed-pipe stdin and environment precedence are preserved.
Jobs producers omit the native hard deadline: foreground waiting may promote the existing native
task and existing public job, while explicit background publication owns its lifetime independently
of the starter's signal. A refused public Jobs preflight may use one native foreground attempt only
when the producer was never invoked. Accepted native work is never replayed through another runner.

Native error code/effect facts survive diagnostic classification. Observed sandbox denial signatures
and partial enforcement remain visible. Truncated stderr produces an explicit incomplete-observation
marker rather than claiming no denial occurred. Output keeps its bounded display tail and a complete
raw spill up to 64 MiB. Live paths cover reported bytes; only sealed, joined streams enter the existing
ledger under the actual kernel PID and Session. Spill failure withdraws the path and preserves honest
truncation. Existing file tools recover retained output under their normal authority and paging rules.

## Validation

The two new suites cover 19 checks with actual Context/Agent/Session/Jobs lifecycles and a scripted
native transport. They include current-head admission, stale grants, asynchronous authority changes,
registration/cancellation races, exact script arguments, environment tombstones/locale normalization,
native error precedence, pending publication, shared ownership and withdrawal without fallback.
Existing wrapper/environment/Electron tests add 33 checks. Build emits the unchanged 120,684-byte
PTC declarations. Initial tests found and corrected locale normalization, service-fiber ownership,
native failure precedence and a retained-definition caller gate; failures were not retried away.
An additional six affected suites pass 29 checks, including real root/standalone file composition,
legacy Bash stdin/session behavior and the unchanged prompt budget. The first invocation supplied
Niubash to a harness input that explicitly requires the pinned legacy MSYS fixture; the pin guard
rejected it before any suite ran. The corrected invocation used that verified legacy fixture and
repository-built IPC proxies, with no pin change or skipped check.

The earlier repository-only fresh bridge probe passed **6/6**
on Windows with actual public policy, sandbox, subprocess, directory, managed shell environment,
Native/PTC execution and official Jobs controls. It injects the internal authority service explicitly;
it does not alter capability advertisement or configure a production bypass. Restricted launches
reported `workspace-write` with **partial** enforcement. It observed one public kernel spawn and one
PTC process spawn, four native task requests, no public per-call Bash spawn, and confirmed kernel
PID 38792 gone after joined cleanup. These are functional/lifecycle observations, not performance
or full #872 acceptance.

- Worker SHA-256: `2fcf7f1d608b71fe53d121c892465bd58bf0bb04765d7ee260c441c1c58c3b2e`.
- Stock fresh Niubash SHA-256: `7ec3ec04ce91bae64c23d7150e6b16574e9d91df8fcf0df997006e2b37bf2f1e`.
- Retained raw report `fresh-bridge-first.json` SHA-256:
  `f6cfbfa75850e0c7715f67e086480fb95f5ebe927fb76ea25918f18e39605fbb`.

The updated [probe](../bench/probes/probe-872-fresh-bridge.mjs) passed **7/7** through the actual package
root with both capabilities, without an internal authority factory or replacement transport. It adds
Native and PTC full-spill recovery, exact sealed ledger ownership and explicit paged-file continuation.
It observes six native task requests, one public kernel spawn, five public PTC runners and no public
per-call Bash spawn. Kernel PID 24844 was gone after cleanup. The first updated invocation used an
invalid fixture capability name and failed before starting a kernel; the second passed six checks but
incorrectly expected `completed` for a one-line file page. The final assertion requires `partial` and
its continuation. Both failed reports remain retained; no production behavior was changed to pass them.

- Worker SHA-256: `51ec139dc8e7dbb9fe7881ee71aa25c691e070bfeb122f50e7520a6bfe7383e6`.
- Retained report `fresh-bridge-production-third.json` SHA-256:
  `5a529dbc9032fd422c65c69ff8c9d74ec057e7e49355b9b6f1d1b3edd4634993`.

The root publication fixtures now explicitly provide their Agent/Session/environment authority and
wait for readiness. Their shell contract remains unchanged: measured default request bytes are
minimal 7,943, standard/cordis 12,367 and PTC 18,924, within the existing budgets. Functional checks
do not claim every remaining PTC or WSL operation avoids a separate runner.

After stacking the task-spill implementation, **263 distinct checks across 25 suites pass**, with no
skipped suite. The ledger/retention suites retain two explicit POSIX-only fixture notices on Windows.
Initial affected-suite runs retained failures for an omitted worker path, absent complete Niubash
payload, and publication fixtures missing the new authority/readiness contract. The file-only fake
kernel now explicitly advertises no task capability. The unchanged pinned archive was staged through
the repository script after the npm shim rejected forwarded flags; the final checks use no pin change.

Run after building TypeScript, with explicit complete runtime and official controller/environment
module paths: `node bench/probes/probe-872-fresh-bridge.mjs --worker <worker> --controller <jobs-module>
--shell-env <shell-env-module> --bash <niu.exe> --report <report.json>`. No model API is used.
