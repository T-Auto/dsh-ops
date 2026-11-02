# Windows runtime evidence

Use this guide when the payload resolves but a command still fails. Record the
loaded DSH core/Desktop, OPS and Bash payload versions, installation channel,
Native/PTC presentation, session sandbox mode, and exact executable paths. Run
`ladder --json` with the affected profile's installed copy, not a different npx
cache. Redact usernames, tokens and private command data before sharing evidence.

## What a compatible payload proves

`shells.bash.restricted.compatible` compares the selected MSYS payload with the
IPC compatibility receipt. It does not launch a command, query the child token,
check executable integrity labels, prove an antivirus decision, or test the host
runner. `available: true` similarly means a shell was resolved. These are static
checks, not an end-to-end health result.

## Full access and a Low child process (#446, #463)

OPS skips `sandbox.confine` in `danger-full-access`. Windows can still start an
executable carrying a Low integrity label with a Low token. A Low process cannot
normally write to a Medium object even when its DACL allows access; an unlabeled
object is treated as Medium. This is separate from the session selector.
[Microsoft's Mandatory Integrity Control documentation](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control)
describes these process-creation and write restrictions.

Collect read-only evidence from the same caller and affected executable:

```powershell
whoami.exe /groups
icacls.exe '<resolved bash.exe>'
icacls.exe '<workspace root>'
icacls.exe '<existing file that failed>'
Get-FileHash -LiteralPath '<resolved msys-2.0.dll>' -Algorithm SHA256
```

In the affected `ops_bash`, `MSYS2_ARG_CONV_EXCL='*' whoami.exe /groups` records
the child token. Keep the complete integrity SID (`S-1-16-4096` is Low,
`S-1-16-8192` is Medium), then compare with the host shell in the same session.
An unreadable label is unknown; it is not evidence that the image is Medium.

A workspace can contain new Low-labeled files and older Medium files. Therefore
“new file succeeds, editing an existing file fails” needs both files' labels.
Hash equality does not imply equal security metadata. A final Bash exit0 also
does not prove an earlier command succeeded: a later successful command can
replace the shell's final exit status. Keep stderr and verify the intended effect.

Do not recursively relabel DSH_HOME or the workspace as a diagnostic step. Have
the administrator or host maintainer review the labels and intended boundaries.
An explicit `bashPath` is authoritative and stops following provisioned upgrades;
moving a payload is not a general repair for restricted-mode compatibility.

## Shared MSYS objects and startup status (#409, #417, #480)

`CreateFileMapping S-<user SID>.<n>, Win32 error 5` identifies a shared-object
access failure. The #389 proxy fix prepares **new** selected IPC objects under a
restricted Low token; it does not repair an existing foreign object's DACL.
Stopping DSH does not stop an unrelated external MSYS holder. Record the exact
payload/root, whether an owned normal-token holder is alive, stderr, exit value,
and a restricted positive control. Stop only jobs you own; do not kill all Bash
processes or rewrite foreign ACLs to make a comparison pass.

`3221225794` and `-1073741502` represent `0xC0000142`. The status alone does not
identify the failing DLL or prove which process reached the command. A manual
launch of a staged restricted payload under a normal token is unsupported: its
IPC proxy requires a restricted Low token. Use the OPS tool to exercise the
host-confined execution path. Preserve complete stderr
and compare the host's own shell under the same policy. Do not map a normal
application exit49 to an MSYS startup failure.

## Antivirus correlation (#439)

Collect the security product/version, timestamp, event/action, exact blocked
image or file, parent process, and the corresponding OPS callId. Hash that exact
file and record its Authenticode status with `Get-AuthenticodeSignature
-LiteralPath '<file>'`. Distinguish installation/hardlink events from execution
and workspace writes. A count of unsigned files or a nearby timestamp alone
does not identify the cause. Do not disable protection or broadly trust the
payload tree to collect evidence. No OPS-specific block or speed claim is proved
until a matching event identifies the affected path and operation.

## Heredoc and automatic-approval reports (#425, #426)

For heredocs, include the exact command string with real newlines, the final
newline, quoting, resolved Python/Bash versions, and stdout/stderr/exit/status.
Compare a tiny heredoc, `python -c`, and an equivalent temporary `.py` under the
same tool, policy and presentation. A terminal-only success does not validate
Desktop/PTC. Keep application exit values unchanged until their source is known.

For auto-approval, include the minimal redacted rule, its provider, tool name,
callId, arguments, requested/standing mode, and approval request/result. State
whether the failure is extra prompting, rejection, cancellation or a hang.
Controlled approval-service tests do not prove a real rule-provider integration.
Reproduce in an isolated profile without changing the real approval policy.

If these exact reproducer fields are missing, report “not reproduced; evidence
missing,” not “fixed.” The guide itself does not repair host token construction,
security-product decisions, image labels or an unobserved approval conflict.
