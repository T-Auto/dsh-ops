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
Full-access sessions use cache-only preparation when the host exposes it, without preparing the
workspace or requesting workspace confinement. On older Windows hosts without that capability,
optional cache creation is unavailable in full-access mode; switching a session to full access
does not repair workspace ACLs or create new workspace grants. An already prepared session cache
can still be reused under its current authority binding. Workspace-write sessions retain the
legacy confinement path. If a cache cannot be prepared, file operations retain their bounded,
explicit incomplete result; reference creation reports unavailable storage.
There is no unconfined PTC fallback.

Each reference binds the live session, current authority, credential fence, operation root and
producer tool. Only currently published/executable producers and the admitted tool are allowed.
Changing the permission mode invalidates the previous authority binding, including narrowing to
read-only. Read-only never creates a cache or updates LRU state. Existing direct legacy audit
references retain their separate contract.

Session disposal immediately expires references, cancels queued/running work, awaits settlement,
then purges validated snapshot/staging blobs through the current host authority. The stable lock
and unknown names remain; audit data is never purged. Read-only mode or unavailable host services
can prevent physical cleanup; the root is then recorded in a private pending ledger under the
temporary directory instead of being forgotten, together with the failure reason (read-only,
changed authority, cache grant, timeout, EPERM) and its attempt count. A later workspace-write
authorization, the next start-up or an operator command retries it with bounded exponential
backoff; nothing is deleted while the host stays read-only. A fresh in-memory session nonce
prevents reopening disk leftovers as valid references after a restart. Component owners share this
lifetime; unloading the last Native/PTC owner expires its remaining sessions. Cleanup is an
internal operation and cannot be requested through model tool arguments.

The native purge deliberately keeps the root directory, its `s-<hash>/` scope directory and the
stable lock inode, and the root is created eagerly on the first non-read-only call. A host-side
sweep therefore reclaims roots at start-up and after the last owner unloads. It only touches a
directory named `dsh-ops-results-<64 hex>` that is a private, current-user-owned, non-linked
directory whose contents are limited to `s-<64 hex>/` scope directories holding `lock`,
`<uuid>.json` and `<uuid>.tmp`; one unknown entry skips the whole root and is reported. Roots
referenced by this process are excluded, a root must be idle for `resultCache.maxAgeMs` before it
is touched (roots this process created skip that grace during shutdown), and one pass is bounded by
a root count and a wall-clock budget and stops at the first failed removal. By default only roots
that hold no snapshot data — an empty root, or scope directories with just their lock — are
reclaimed. `MAX_SESSION_BYTES` stays a per-nonce quota for one cache root and is never used as a
global budget: the aggregate limits are `resultCache.maxRoots` and `resultCache.maxTotalBytes`,
both 0. They are reporting thresholds, not deletion budgets — a root that still holds snapshot data
is classified as blocked (age, live set or over budget) and is never removed by the sweep; only the
authorized session purge or its deferred retry may reclaim that data. `dsh-ops result-cache status`
reports the inventory and `dsh-ops result-cache reclaim [--apply]` previews or performs the same
bounded pass.

## Native and PTC reference pages

Native, discovery and PTC lease one canonical result definition, including inherited sources.
The public input schema is put/page/release in every presentation; it is not write authority.
Native permits owned ref:// page/release only, never audit IDs or purge. Put is rejected before IO
unless a live root run_code execution token is its parent, with the same agent, root call and exact
admitted toolSet, and the current presentation admits PTC. The public events prove this live nested
call and current PTC admission, not cryptographic executor attestation. Native nested calls and
invented/stale parent tokens do not authorize put. Put writes only the session-private cache and
retains the normal size, format, credential and sandbox authority checks.

Omit root to use the current session cwd in both projections; after changing cwd, pass the original
referenceRoot. This replaces PTC's former workspace-root default for the shared result capability;
pass root explicitly when paging a workspace-bound batch audit. The locator grants no authority:
a different session/root, changed permissions or hidden producer denies access. Release removes
cached observations, never business files. Unloading one consumer leaves other grants intact;
a new resolve is required after real source/grant changes.

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
