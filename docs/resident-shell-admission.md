# Resident shell host admission

中文：[常驻 shell 宿主准入](常驻-shell-宿主准入.md).

This internal adapter connects current public host authority to the
[native shell queue](resident-shell-queues.md) for [#872](https://github.com/T-Auto/dsh-ops/issues/872).
It does not publish a tool or enable session execution for the shipped shell runtime.
The complete feature still requires eligible runtime distribution, shared recoverable output,
Native/PTC publication, kernel-owned fresh/background tasks and full acceptance evidence.

## One owner, current authority

The adapter attaches to the already-ready activation-owned kernel's `shell-v1` channel. It never
starts another kernel or schedules commands in the host. Native queue-head admission triggers
policy, approval, environment, directory, runtime and confinement preparation.

Ownership uses the exact live Agent and Session objects. Each owner receives a private random
native key; a reused public session ID cannot acquire an old owner's shell. Agent disposal awaits
native close. Removing or replacing an injected authority provider disposes the admission service
and waits for owner cleanup. Kernel loss withdraws the transport, reports its confirmed cleanup
outcome and settles pending calls without replay or restart.

Every asynchronous preparation boundary rechecks the original standing authority and caller
lifetime. A late approval cannot authorize a cancelled, timed-out, retired or disposed request.
An allowed-once grant belongs only to the same unstarted queue head, including retirement needed
to replace a narrower shell. The wider range uses `closeAfter`, so its state is gone before the
result is published. Queued followers receive independent current admission.

Policy changes observed through session events retire the active shell while preserving queued
followers. Head-time rechecks remain authoritative when no change event is available. Host
environment changes also retire the live shell. The adapter snapshots its configured Bash
identity; configuration replacement must dispose that owning adapter instead of relabelling it.

## Launch facts and working directory

The environment comes from the running host's public subprocess scrub and current shell-env
service. Windows merges are case-insensitive and honor deleted entries. The outer private-control
marker is removed. Nonempty `NIU_ENV`, `BASH_ENV` and `ENV` entries are rejected by name without
printing their values, both before runtime preparation and after the final environment merge.

The host resolves and validates the first directory. An omitted later `workdir` preserves the
shell's current directory. An explicit relative directory resolves against the current host
session directory and is sent as a persistent directory change for that command. Restricted
launches use the exact argv returned by the public sandbox provider; native code does not replace
the wrapper. Missing or invalid confinement fails before command bytes enter the shell.

## Bounded correlation and honest output

The transport tracks at most 32 retained requests, 32 owners and 64 controls, with one outstanding
read per stream per request. Cancellation is coalesced. Ordinary capacity refusal occurs locally
before submission. The shared outgoing frame window accommodates both file and shell controls;
each frame remains bounded and only one physical write is outstanding.

Native owns queue-inclusive deadlines. The adapter's default is 120 seconds and its maximum is
10 minutes. It collects both terminal output streams before releasing the native record. Output
errors retain the other stream's evidence; contradictory offsets or completion receipts fail the
owned connection. Empty live output never implies EOF. The current protocol retains a 128 KiB
prefix per stream and reports observed totals and loss; it does not claim recoverable spill.

Terminal state changes are applied synchronously before output collection awaits. A slow old
output tail cannot erase the next queue head's new shell facts. A start notification followed by
cancellation before command bytes may correctly finish with `effectState: none`.

## Reproduction

Focused suites cover admission, protocol correlation, kernel transport and host package scope:

```console
node scripts/build.mjs
node test/run.mjs resident-shell-admission resident-shell-channel resident-kernel host-scope-source
```

`bench/probes/probe-872-shell-host.mjs` additionally uses actual Cordis, Agent, Session, policy,
directory, subprocess and sandbox services. Its approval and shell-env inputs are instrumented
public service shapes. The probe requires explicit worker, candidate, support payload, executable
hash and report paths; it neither changes the shipped runtime pin nor establishes model-facing
or complete application acceptance. See the PR validation record for exact hashes and results.
