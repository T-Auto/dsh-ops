# Windows session qualification handoff

中文：[Windows 会话资格交接](Windows会话资格交接.md).

This 2026-11-14 handoff records the Windows-first review scope of [#872](https://github.com/T-Auto/dsh-ops/issues/872).
It describes local qualification of unpublished adoption commit
`511f9920044c1aa38d7ca8443e1a6e26f7bc61c5`, not a published runtime or complete issue acceptance.
The qualified candidate inventory is recorded for review, while the stock pin remains fresh-only;
the [session contract](session-shell.md) remains conditional on a qualified complete runtime.

## Completed Windows evidence

| Check | Recorded result |
| --- | --- |
| Full release gate on clean `511f992` | `node scripts/verify-gate.mjs --skip-install --target win32-x64` passed: 739 Rust tests passed, 0 failed, 8 ignored; 263 suites passed, 0 failed, 4 permitted skips; 92 manifest checks passed. |
| Four actual DSH CLI instances | Production package-root activation and public fresh/session/Jobs tools passed with a shared temporary home/workspace: 61 events, 53 observed PID/creation-time identities, and 0 survivors before emergency cleanup. |
| Quiet task and isolation | Observed quiet interval: 310047.7863 ms. State isolation, targeted cancellation, control loss, kernel crash, normal shutdown and forced host death were exercised against established process ranges. |
| Public Jobs return | Observed returns were approximately 17–29 ms in that functional run. These individual observations are not latency percentiles, a baseline comparison or performance acceptance. |
| Process-cold activation | `872-activation-windows-511f992/report.json` passed all 10 baseline/candidate pairs. Each pair used new Node processes and fixture homes; OS caches were not flushed and no command workload ran in these pairs. |

The four permitted suite skips were `linux-attributes`, `linux-shell`, `tui-host` and `tui-native`.
The release worker SHA-256 was
`36f2a4c47abdf54c82569703d29c8887d6f40a7a22ab0d05be70f24eb06b7c4a`.
These local receipts are retained outside the repository:

| Receipt | SHA-256 |
| --- | --- |
| `reset-runtime-adoption-511f992-full-windows-gate.json` | `215a18bc05eddbe4f89e5be6fbad7ebc5159f71abc94ec1da2c1641a9d3d2ac0` |
| `1794627071145-report.json` | `a08a28d82ebc4571c7bdaa03f3bc22373716be7590ff1e4aa6a41c3ae6904072` |
| `872-activation-windows-511f992/report.json` | `1ff04ec013e231907381d679d9680f53a3d8bf17a4a582dd430cf635a1b94454` |

## Deferred acceptance and distribution

The 200-sample benchmark was stopped for the requested handoff deadline and remains incomplete.
The cold-activation pairs and functional timings do not establish a performance improvement;
the complete interleaved workload and resource comparison still need completion.

Linux qualification is deferred: a local WSL execution error prevented the planned run, and the
stopped-kernel host-death cleanup gap remains open. Windows evidence covers established ranges;
it does not close the public host's outer process-create-to-Job-assignment crash interval.
See [resident ownership and evidence](resident-kernel.md) for those boundaries.

This handoff publishes no runtime archive, package, release asset or tag. Qualified runtime
publication remains pending. The review can proceed on the completed Windows evidence while
Linux ownership, the Windows outer startup interval and complete performance acceptance remain
explicit follow-up work; none is waived by this handoff.
