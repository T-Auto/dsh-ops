# Windows security regression coverage

This is the current coverage map for the useful increments from PR #128 (head
`d37f9e88c85dfa69f0ca48e1e0244d8fd5c58ca4`), not a claim that its historical
measurements apply to this version. 中文：[Windows安全回归.md](Windows安全回归.md).

| Historical item | Current assertion |
| --- | --- |
| W1a/b explicit/inherited/deny DACL | Existing file-operations compares complete SDDL before/after writes, edits, replace and copy, including protected and deny fixtures; do not duplicate weaker username/substring checks. |
| W1c same-user owner/group and timestamps | Existing file-metadata checks exact SDDL and mtime across overwrite/edit/replace/copy. Different-owner/two-account acceptance remains manual. |
| W1d READONLY replace | windows-security requires ACCESS_DENIED, structured phase/effectState/retry guidance, unchanged bytes, READONLY attributes, complete owner/group/DACL SDDL and exact directory contents; resets READONLY only for cleanup. |
| W1e FileShare.None | A child acknowledges its acquired exclusive handle on stdout; replace must return IO_ERROR with structured failure and no artifacts. The child releases normally and is awaited before checking original bytes. A separate readable handle without DELETE sharing reaches the atomic publication failure: ACCESS_DENIED and the publication message are required, with unchanged bytes/SDDL and no staging artifacts before and after handle release. |
| W1g uncontended/contended update | A pre-acquired byte-range lock on the exact sidecar deterministically forces REVISION_CONFLICT; after release a real replace changes exactly one item and removes the sidecar. Existing replace-concurrency/lock-sidecar and Rust unit tests cover cooperating writers. |
| W1h readers | While the acknowledged sidecar lock is held, a real inspect call and ordinary file/directory reads succeed. This proves off-target lock compatibility, not continuous observation of a production writer's entire publication window. No probabilistic large-file reader race is claimed. |
| W1f ADS | Existing file-operations checks fail-closed METADATA_UNSUPPORTED and retained stream bytes for write/copy. Cross-user ownership, remote filesystems and every ADS/replace variant are not claimed by the new suite. |

Run after building: `node test/run.mjs windows-security file-metadata file-operations lock-sidecar replace-concurrency`.
The runner discovers the new suite on every host. Non-Windows reports exit 77;
verify-gate includes only that exact platform skip in both its allowed-skip set
and the strict runner environment. Windows may not skip this suite, even when
its worker is absent. No operation failure or concurrency failure is retried.
PR #128's harness removal retry was not imported: explicit handle release and
awaited child shutdown remove the demonstrated fixture race without broadening
cleanup behavior. The suite pins codes where the current Windows worker contract
is known, rather than accepting any nonempty platform error as success.
