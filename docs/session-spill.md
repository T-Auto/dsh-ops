# Session output recovery

中文：[会话输出溢写](会话输出溢写.md)

This internal #872 slice connects persistent session output to the same native
spill store and retention ledger as fresh tasks. It does not publish session
tools, change the default executor, or qualify the stock Windows runtime for
persistent asynchronous commands.

## Ownership and completion

The resident kernel allocates one `SpillStore`, clones it into the task and shell
managers before `READY`, and then advertises `shell-spill-v1` alongside
`shell-v1`. Store configuration performs no filesystem I/O. The first stream
overflow creates the private directory lazily in its owned capture reader.
Creation failure degrades to bounded memory and `spillError`; it does not prevent
kernel startup or file-tool operation.

Session stdout and stderr retain their existing 128 KiB prefixes. Crossing that
boundary starts a complete raw file, including bytes already captured in memory,
up to 64 MiB per stream. Control receipts, framing and original process
diagnostics never enter these files. Exact-limit streams remain memory-only.
Exceeding the file cap, or failing a write or seal, withdraws the complete path
while bounded capture continues. The underlying private origin, no-follow checks,
owned I/O cancellation and irreversible poison semantics are described in
[private-channel spill](private-channel-spill.md) and [native raw spill](native-raw-spill.md).

Each correlated `shell.output` receipt may include `spillPath`,
`spillOrigin: "ops-native-v1"`, `spillPid`, `spillSealed`, and separate `spillError`
degradation. The host requires negotiated spill support, all origin fields
together, and the PID from the actual resident handshake. Terminal collection
joins both stream reads before releasing the native record. Unsealed terminal
metadata or metadata that changes between terminal reads fails the protocol.
Raw capture errors retain partial bytes without inventing EOF or a recovery path.

Only sealed, error-free stream captures with confirmed cleanup enter the existing
ledger, attributed to the exact calling Session. An ordinary command failure or
cancellation may still leave a fully captured, sealed stream; a raw capture error
or unknown cleanup cannot. There is no second ledger or host spill writer.
Releasing a native record preserves its sealed files for the existing bounded
retention pass. Recovery uses existing absolute-path file-read authority; write
permissions are unchanged.

## Validation and activation boundary

The real public-host probe is:

```powershell
node bench/probes/probe-872-session-spill.mjs <worker.exe> <candidate-niu.exe> <stock-payload-niu.exe> <report.json>
```

Its nine checks cover the exact memory boundary; complete binary stdout/stderr
recovery with retained cwd, exports, functions and options in all three sandbox
modes; one store shared with a fresh task; ledger reload and exact Session
attribution; file-read recovery and write refusal; the 64 MiB cap; retention; and
kernel death with an unsealed stream. The local backport candidate additionally
runs external background commands followed by `wait`, and passed all nine checks
with confirmed cleanup and no survivors.

CI passes `--stock-foreground` with the pinned stock executable. That mode proves
the same storage/lifecycle path with foreground external commands only. It does
not establish stock asynchronous output fidelity. Public session activation must
separately require `shell-v1`, `shell-spill-v1`, and a qualified runtime. Internal
bounded `shell-v1` fixtures remain compatible. POSIX shell ownership remains
unsupported; no process-group fallback or silent scope change is introduced.
