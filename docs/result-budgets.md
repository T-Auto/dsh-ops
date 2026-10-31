# Result budgets and session lifetime

OPS worker calls have a 30-second execution ceiling. Native and PTC share a FIFO admission lane
per host session: two active calls and eight waiting calls. Overflow returns CALL_LIMIT with no
effects. A cancelled queued call never starts. Authority is resolved again after admission.
Native model text remains capped at 64 KiB after escaping; worker transport has a separate
128 KiB collection limit. Canonical result storage has its own 10 MiB/result and 100 MiB/session
limits. Transport, model text and stored data are separate budgets.

Reference storage uses a private temporary cache selected by trusted host metadata. Windows uses
the actual sandbox provider's session temp directory and private-temp write capability. PTC still
runs through host confinement; Native fixed file operations keep their policy-governed executor.
Full-access cache preparation voluntarily uses a narrower workspace-write policy. If a cache
cannot be prepared, file operations retain their bounded, explicit incomplete result; reference
creation reports unavailable storage. There is no unconfined PTC fallback.

Each reference binds the live session, current authority, credential fence, operation root and
producer tool. Only currently published/executable producers and the admitted tool are allowed.
Changing the permission mode invalidates the previous authority binding, including narrowing to
read-only. Read-only never creates a cache or updates LRU state. Existing direct legacy audit
references retain their separate contract.

Session disposal immediately expires references, cancels queued/running work, awaits settlement,
then purges validated snapshot/staging blobs through the current host authority. The stable lock
and unknown names remain; audit data is never purged. Read-only mode or unavailable host services
can prevent physical cleanup, with a diagnostic. No automatic retry is scheduled; up to the session
quota can remain for host temporary-directory cleanup or operator removal. A fresh in-memory session nonce prevents reopening
disk leftovers as valid references after a restart. Component owners share this lifetime; unloading
the last Native/PTC owner expires its remaining sessions. Cleanup is an internal operation and
cannot be requested through model tool arguments.

## Native and PTC reference pages

The file row provides Native ops_result with page/release only, independently of the PTC row.
The single result catalogue entry also supplies PTC put/page/release; PTC-only scopes retain the
richer schema, and Native descendants receive the file row's page-only projection. Disabling
file withdraws that projection while the PTC row remains independent. Advanced discovery owns
its later on-demand publication; enabling the pager does not change any official tool.

Native accepts only ref:// handles, never legacy audit IDs or put/purge. Omit root to use the
current session cwd; after changing cwd, pass the original referenceRoot. PTC defaults to the
workspace root. The locator grants no authority: a different session/root, changed permissions,
or a hidden producer denies access. Release removes cached observations, never business files.

Pages default to offset=0, limit=64 and maxBytes=16384 (bounds: 1-512 rows, 512-65536 bytes).
equals filters top-level exact values before fields projection; offsets count filtered stored rows.
New references use ttlMs=0 for session lifetime, or up to seven days when PTC put specifies ttlMs.
createdAt is Unix milliseconds. The entire put request is capped at 2 MiB, each physical snapshot
at 10 MiB. Legacy audit contracts are unchanged.

Native renders intact stored rows under a 64 KiB escaped-content ceiling. Follow nextOffset only
when displayComplete=true; otherwise repeat the same offset with smaller limit/maxBytes or fewer
fields. pageComplete reports pagination of stored rows. source preserves original execution facts,
source.root, capturedItems and captureComplete: finishing pages never completes an incomplete scan.
With source.itemEncoding=tagged-json-v1, kind=item rows contain value. item-json-chunk rows carry
index, chunk, byteOffset, text and complete; concatenate text for one index in byteOffset order and
JSON.parse only after its final chunk. A final chunk alone is not a complete logical item. A stored
snapshot represents the requested operation/page, not an unbounded whole-query result.
