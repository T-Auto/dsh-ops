# Resident result and batch execution

[中文](常驻结果与批处理.md)

Native and PTC result put/page/release share the same bridge. PTC batch plan/run/resume
uses that bridge too. On Windows, all of these calls now use the owning resident kernel;
the public subprocess service starts the kernel once, not another OPS worker per call.
The original reference/audit implementations, IDs, result budgets, write-ahead records,
root/session binding and no-follow checks remain unchanged.

The permission boundary is explicit:

| Current policy/platform | Execution path |
| --- | --- |
| Full access, every supported platform | Existing trusted fixed worker leaf inside the resident kernel. |
| Read-only or workspace-write, Windows | Exact public `sandbox.confine()` command, launched inside the existing atomic Windows Job range. |
| Read-only or workspace-write, POSIX | Existing public confined runner. Native arbitrary-runner ownership is not established on this platform; this remaining route is not a kernel-error fallback. |

Batch operations are data, but their existing root-relative path checks are not treated as
proof that OS confinement can be removed. The restricted Windows path preserves the
original argv, working directory, public scrubbed parent environment and Electron Node-runner
adaptation. It reports the actual confinement enforcement and preserves runner-failure and
denial-signature classification. No shell configuration environment is added to a file worker.
Current authority is checked again after asynchronous preparation and before dispatch.

The existing `execute` control frame may carry trusted launch facts for batch/result only.
An older kernel without `confined-worker-v1` refuses the request before dispatch. The envelope
remains limited to 2 MiB, launch metadata to 64 KiB, and the shared request window to 32 calls.
There is no second scheduler. Cancellation and completion retain the same request ID.

The owned range is established before sending request bytes. A started receipt precedes
bounded stdin delivery and EOF; stdin and both output readers join before terminal settlement.
The native envelope deadline covers launch, the physical started acknowledgement, stdin delivery
and a stalled runner before worker decoding. The existing bounded reply queue preserves
started-before-completed ordering when cancelled. A joined input-delivery error does not erase
a known nonzero runner exit or captured stderr; timeout and cancellation remain interrupted.
Cancellation terminates the whole owned range, including the public confinement wrapper.
Unconfirmed cleanup poisons the connection instead of reporting successful cleanup. A lost
receipt never authorizes replay, and interrupted batch effects retain their existing unknown
state and recoverable audit identity when available.

Cache purge continues to use the dedicated resident teardown path. The remaining one-shot
transport is used only by restricted POSIX batch/result calls and the explicit WSL read path.
This slice does not claim POSIX confined-runner migration or completion of issue #872.

Windows verification used worker SHA-256
`024d5e80b9befe77dce3b3ad4bf6c2d4d40e236047054acc79dd9f7196192b2c`.
The eight real routing checks and thirteen Native result checks passed, including actual
public confinement, root-link replacement, cancellation, stalled input, early runner refusal,
and zero public one-shot OPS launches through disposal. The original route failed all three
initial routing checks; the intermediate kernels separately failed the stdin deadline and both
early-refusal checks. These are correctness and ownership observations, not performance results.
