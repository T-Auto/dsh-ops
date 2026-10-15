# Windows MSYS IPC compatibility (original MIT code)

The DSH restricted-token backend remains the only authority for arbitrary Bash
execution. MSYS creates several IPC objects using explicit security descriptors
that omit every DSH restricting SID; changing the token's default DACL does not
help these objects. Reopening the signal pipe fails with Win32 5 / 0xC0000142.

The local build redirects only the private copy of msys-2.0.dll's KERNEL32 and
NTDLL import descriptors to two small proxy DLLs. All imports are forwarded
unchanged except:

- `CreateNamedPipeA`: a first-instance, remote-rejecting single-instance MSYS
  signal pipe with the current Windows PID and a 16-hex installation key.
- `CreatePipe`: newly created anonymous process-tracking pipes.
- `NtCreateNamedPipeFile`: new single-instance MSYS data pipes, relative to the
  verified `\Device\NamedPipe\` root, with the current PID in their name.
- `NtCreateSection`: pagefile-backed `cygpid.<digits>` process trackers under a
  verified MSYS installation object-directory root. Disk-backed mappings and
  all other names are unchanged.

For those new objects only, retain the original DACL/denies, add the current
logon SID already present in the host restricting list, and use a Low integrity
label. Compatibility is active only under a Low token with restricting SIDs.
Failure to construct the descriptor fails closed. There is no token SID change,
impersonation, disk ACL change, filesystem syscall hook or retry with full access.
It does not grant filesystem rights to the logon SID.

IPC objects are accessible to the same Windows logon, not a per-session secret
channel. The backend's existing Windows `partial` enforcement designation is
retained; this is not an upgrade to full cross-session/kernel isolation.

## Build and distribution

`npm run build:bash-ipc` on Windows x64 with MSVC/Windows SDK; set
`DSH_OPS_VCVARS64` if the session uses a different installed BuildTools path.
The command builds in a temporary directory and stages DLLs plus hash receipt
into `runtime/win32-x64/bash-ipc`. The receipt pins the original MSYS DLL hash.
`runtime/` is generated/ignored, included by npm's existing files whitelist, and
must be built before distributing a source package. No installation scripts
compile, download, alter original payloads or change host services.

On the first confined call, `lib/bash-ipc.js` verifies original/proxy hashes,
creates a complete private copy under `DSH_HOME/dsh-ops/bash-ipc/<identity>`,
redirects import DLL names (no executable instructions modified), and records a
receipt. Unsupported layouts/versions or corrupt generations fail closed.
Only the per-call environment puts the matching `usr/bin` first in PATH, so
Bash children do not accidentally load another MSYS installation. Full access
continues using the original shell. The default payload remains GPL software;
existing LICENSE/provenance files are copied unchanged, and the modified MSYS
copy is identified in `.ops-ipc.json`. That manifest records the published PATH
directories by **size and mtime** only (not source hashes), so it serves as an
accidental-drift detector — the tamper anchors are the patched MSYS digest and
the in-package receipt, which the cache directory cannot rewrite. A public
modified MSYS distribution requires a separate license/source-compliance review.

## Evidence

`test/permissions.test.mjs` runs original DSH sandbox/subprocess providers and
Node PTC runtime with the generated tools SDK: workspace-write command,
script_path, external executable pipeline, inside writes, outside writes denied,
read-only downgrade denied, and full access. Test failures are gate failures.
`test/bash-ipc.test.mjs` pins untouched file/token APIs and unsupported-version
rejection. GUI Desktop acceptance is separate and requires a restart.
