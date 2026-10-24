# Native PTC enhancement — Windows x64, Linux x64, macOS arm64/x64

0.4.0 PTC callers use [Outcome contracts](ptc-outcomes.md) / [PTC 结果契约](PTC结果契约.md).
The historical worker/recovery details below remain applicable; SDK results now wrap canonical facts in `data`.

Issues: [#3](https://github.com/T-Auto/dsh-ops/issues/3), [#8](https://github.com/T-Auto/dsh-ops/issues/8).
The file and PTC components use an independent Rust worker. The FastCtx-backed
background component has been removed.

## Runtime-bearing installation and original DSH permission linkage

The current release ships native workers for `win32-x64`, `linux-x64`, `darwin-arm64` and `darwin-x64`, each with a version/checksum receipt, plus the Windows Bash IPC proxies. 0.3.1 shipped the first three; current support adds Intel macOS on macOS 13+. Formal `verify:release` requires all four target pairs and validates every PE/ELF/Mach-O worker and the Windows IPC binary/source closure. Local `check --staged` verifies only local development outputs. Windows/Linux ARM64 are not supported. macOS 12 lacks `CLONE_ACL`; its write-path fallback is a separate follow-up, not part of this support claim. The Windows Bash payload remains a Windows-only optional dependency; PowerShell is host-managed. POSIX uses host Bash. There is no postinstall download/build. Source builds use `npm run build:ptc`, plus `npm run build:bash-ipc` on Windows.

PTC/Bash use original per-call sandboxPolicy and sandbox.confine, reporting the
host's full/partial enforcement honestly. Read-only permits existing result pages
but rejects mutations/new audit records. Absolute operation roots are selections,
not new authority; full access permits external roots without confinement.
No-follow/protection/no-overwrite remain operation integrity semantics.
Windows owned Modify-only workspaces receive a backed-up, directory-only
WRITE_OWNER prerequisite automatically before outer run_code/pwsh launch. This
is not recursive repair, ownership change, self-escalation or unconfined fallback.
Real Windows provider and pure PTC SDK acceptance is covered in the release gates.

## Native file component and release scope

The fixed file component follows DSH fs-sandbox's trusted-operation policy fence,
not arbitrary-code isolation; shell and PTC code still require confinement.
Runtime binaries target Windows x64, Linux x64 and macOS arm64/x64; IPC proxies remain Windows x64 only.

In `workspace-write`, native batch/result operations and their audit records are
permitted under the selected workspace root through DSH confinement. Read-only
permits existing result pages only, not new records or mutations. Windows owned
Modify-only roots are prepared automatically with directory-only WRITE_OWNER,
not FullControl, before the outer run_code transport starts. Existing DACLs are
backed up under DSH_HOME/dsh-ops/acl-backups; descendants, owners and explicit
denials are never rewritten. Matching Windows x64 Bash payloads use a private
IPC-compatible MSYS copy, with the original DSH token/confinement unchanged.
Only new MSYS signal/anonymous/data pipes and pagefile-backed process-tracker
sections get compatible object ACLs/labels. No disk or token APIs are hooked.
The runtime pins original DLL and proxy hashes; unsupported versions fail closed.
Build proxies with npm run build:bash-ipc (MSVC, DSH_OPS_VCVARS64 when needed).
Real pure-PTC SDK command/script/pipeline and permission downgrade tests pass;
GUI acceptance still requires a Desktop restart.


```console
npm run build:ptc
npm run test:ptc
npm run verify
```

Rust >=1.88 is required. Build uses `cargo build --release --locked` against
`native/Cargo.toml`. No install scripts download binaries. On Windows, enable the
session toolchain before building; do not add multi-version toolchains to global PATH.

The `dsh-ops/ptc` bundle row is enabled by default after #170; existing explicit
profile disablement is preserved. Config accepts `required` (default false), an optional
absolute `binaryPath`, `allowedTools`, and `alwaysLoaded`; see [SDK loading](ptc-sdk-loading.md). `DSH_OPS_WORKER_BIN` can
select a build; otherwise the component uses `runtime/<platform>-<arch>/dsh-ops-worker[.exe]` before `native/target/release`.
Published 0.3.1 packages include the runtime bytes
of every supported platform; source checkouts stage them explicitly with
`node bin/native-runtime.mjs stage --platform <target>`. There is no automatic
compilation or download during installation.

The session must already use DSH's **PTC-only** presentation. The component does
not force presentation, replace the registry, or create a REPL. It recognizes the
host's public prompt assembly (`tools:ptc-only` section plus the reserved-only wire
schema), not private `modeFor`, run_code existence alone or a guessed session key.
This PTC row publishes its independent SDK only in PTC-only scopes, with inspect/result and the
loader initially resident. Other APIs require next-step activation or `alwaysLoaded`. It adds
no bindings or extra prompt in Native/both scopes. The file row independently supplies Native ops_result page/release; see [result budgets](result-budgets.md#native-and-ptc-reference-pages). 文件组件独立提供 Native 引用分页/释放，详见[结果预算](结果预算.md#native-与-ptc-引用分页)。
The host generates SDK declarations from the same tool schemas; no duplicate guide
or dynamic plan IDs are added to the system prefix.

### Native file-tool contract

The migrated `ops_glob`, `ops_grep`, `ops_inspect_local_file` and `ops_replace`
capabilities use one `path` resolved against the current DSH session cwd. `.`
means that cwd. Reads are permitted wherever the OS permits them, matching DSH
fs-sandbox. Replacement is denied in read-only; workspace-write fences writes to
the workspace and DSH temporary areas; other writes require danger-full-access.
These fixed trusted operations run through the host subprocess with native
no-follow path checks, not an arbitrary-code confinement runner. Shell and PTC
code continue to require OS confinement.

`ops_glob.pattern` and `ops_grep.glob` are arrays of include/exclude patterns;
`!` entries exclude matches. `ops_grep.pattern` and `ops_replace.pattern` are
single strings. Directory traversal skips symlink/junction/reparse entries,
hidden entries, `.git`, `.dsh-ops`, `node_modules`, `target` and `.venv` without
turning skipped children into a whole-operation failure. Root access failures
return `ACCESS_DENIED`; outside-workspace failures return `POLICY_DENIED` with
the active workspace root in the message. Results are bounded and UTF-8-first.

### Update-lock sidecars

Every mutating file operation serialises cooperating writers on a hidden sidecar
next to the target: `.dsh-ops-update-<sha256 of the lowercased basename>.lock`,
created mode 0600 when the lock is first needed and **removed when the writer that
holds it is done** (#319). Single-file operations validate a snapshot before
locking: stale revisions, edit conflicts and existing destinations are refused
without a sidecar. `write_file` and `edit_file` dry runs never acquire this lock.

Removing the artifact on release used to be considered unsafe (#240 P5): a waiter
that had already opened the old inode could lock it after the unlink, while the
next writer created and locked a fresh file under the same name — two writers, one
target. Two rules close that window without leaving anything in the operator's
directory:

- **Bind before publishing.** After taking the exclusive lock, the holder reopens
the name and compares the `(device, inode)` identity of that handle with the inode
it locked. A name that no longer leads to the locked inode means the previous
holder finished and removed the sidecar while this writer was opening it: the
handle is dropped and the acquisition starts over. Only a bound holder publishes.
- **Unlink while the lock is still held, and only the bound inode.** The same
identity check runs first, so a sidecar that someone removed out of band and
another writer has since re-created is left alone.

What this means for a directory: a published write leaves nothing behind, and a
request refused *after* the lock leaves nothing behind either — including
`ops_replace`, which locks every file its `glob` selects before it counts a match,
so a fenced directory-wide replace no longer leaves a sidecar beside each
candidate. A writer killed between locking and release (`SIGKILL`, power loss)
cannot run a cleanup path, so it can leave a zero-byte sidecar; it is not a stuck
lock — the next writer of that name binds to it, publishes under it and removes it.
`test/lock-sidecar.test.mjs` checks refusals, dry runs, published writes and that
reuse; `native/crates/ops-files/src/file_update_lock.rs` is the protocol and its
unit tests.

Because the name is derived from the target's basename rather than its bytes, the
walker's hidden-component rule keeps it out of `ops_glob`, `ops_grep` and a
directory-wide `ops_replace`, and `ops_batch` resolves its operations from the
request rather than from a walk — the artifact is never a result, never a
replacement target and never a batch item.

### `ops_glob` details and ordering

`outputMode: "details"` reports `bytes` (the on-disk size) and `modified`, a real
modification time in **milliseconds since the Unix epoch** — the same quantity
and unit `ops_stat` reports as `modifiedMs`, and `null` when the filesystem
cannot report one. `sort: "modified"` orders newest first and is stable, so equal
timestamps (a coarse clock, a preserved copy, two writes inside one second) keep
the walk's path order; `sort: "path"` and an omitted `sort` keep that order. The
timestamp is read without following links, and a link, junction or reparse entry
is refused before it can become a candidate, so no `ops_glob` item is a link;
`ops_stat` reports the opened file's time for a path reached through one.

The native schemas deliberately do not expose `root`, `workspace`, `cwd`, or
`file_path` aliases. `ops_bash` requires `description`, uses the host foreground/background/promoted result contract, and exposes `run_in_background` when host jobs are available. See the bilingual shell contract in [component-reference.md](component-reference.md) / [组件参考.md](组件参考.md).

Their important fields are (paths resolve relative to the DSH session cwd):

- `ops_glob`: required `pattern: string[]`, optional `path`, `sort`
  (`path` | `modified`) and `outputMode: "details"` (on-disk `bytes`,
  epoch-millisecond `modified`); at least one positive glob is required.
- `ops_grep`: required regex `pattern`, optional `path` and array `glob` filter.
  Use `summary` for aggregate file/match totals, `count` for per-file counts,
  `content` for matching text (default). Item pages default to 100, with 0-based
  `offset` and `nextOffset`. Every page scans candidates to count totals, but only
  materializes the requested window. `complete:false` means more results or an
  incomplete scan; `truncated`/`failed` scans are not exhaustive. Totals exclude
  non-UTF-8 and oversized files (`skippedFiles`); read errors increment `failed`.
  Bounds and traversal filters still apply; this is not a persistent scan cursor.
- `ops_inspect_local_file`: one optional `path` (session cwd by default; a directory
  is rejected), `offset` (1-based line or 16-byte hex row, default 1; legacy 0
  also reads the first unit), `limit`
  (1-10000, default 200), `encoding: "utf-8"`, `view: "text" | "hex"`.
  No multiple-file, PDF, arbitrary-encoding or `pages` interface is exposed.
- `ops_replace`: required literal `pattern` and `replacement`, optional `path`,
  `glob`, `maxReplacements` (1-100000, default 100) and `dryRun`.

File tools, `ops_batch` and `ops_result` return failures as values, not thrown
exceptions: check `status` and `error.code`/`error.nextAction`. A `try/catch`
alone misses these failures. For example:

```ts
const result = await tools.ops_grep({ path: "src", pattern: "TODO", outputMode: "summary" });
if (result.status === "completed") {
  console.log({ files: result.data.files, matches: result.data.matches });
} else if (result.status === "partial") {
  console.log({ coverage: result.coverage, continuation: result.continuation });
} else {
  console.log({ status: result.status, error: result.error });
}
```

File parameter bounds are described in the host-compatible SDK schema and enforced
by the native worker, even for direct PTC calls. Required fields, enums, nested
edit shapes and strict unknown-field rejection remain discoverable.
Native file rendering uses `=== FILE: path (Lines a-b of n) ===` and `N | text`,
with concise mutation receipts and explicit paging/effect/retry notices. PTC wraps the unchanged canonical
execution data in a typed Outcome envelope. Content blocks are capped at
64 KiB after JSON escaping; clipped displays instruct the caller to recover
undisplayed content without blindly advancing a cursor or repeating a write.
Physical LF defines line counts across projections; bare CR/control separators
are escaped for display. Invalid text encoding returns `ERR_INVALID_ENCODING`
with document/binary-reader guidance. Use hex byte rows to read beyond an in-line
cut. See [usage](usage.md#native-file-results) / [使用指南](使用指南.md#native-文件结果).

## Plan and execution semantics

`ops_batch({ action: "plan", operations })` performs preflight, persists a
no-effect manifest and returns a `detailsRef`/job id. It does **not** convert into
an executable `run` request. Execute that exact planned manifest with:

```ts
if (plan.status === "completed") {
  const execution = await tools.ops_batch({ action: "resume", id: plan.data.id });
  console.log(execution); // inspect its status before reading execution.data
}
```

`action: "run"` is a separate immediate path and requires the operations again;
`run` without operations and an id is intentionally rejected. A plan is therefore
`plan → resume`, not `plan → run`. This preserves the observed revision and
protection set instead of silently replacing the plan with new input.


### `ops_batch`

```ts
const result = await tools.ops_batch({
  action: "run", // plan journals without effects; resume accepts only id
  protect: ["project/main"],
  operations: [
    { op: "copy", path: "notes/source.md", to: "archive/source.md" },
    { op: "move", path: "reviews/pr-old", to: "archive/pr-old" },
    { op: "remove", path: "cache/explicitly-approved-target" }
  ]
});
console.log({ status: result.status, receipt: result.data,
  error: result.status === "completed" || result.status === "partial" ? undefined : result.error });
```

Workspace authority comes only from `sandboxPolicy.resolve({session})`.
Optional model `root` selects an absolute operation root, not new authority. Paths are **root-relative forward-slash paths** on all platforms,
including Windows (Unicode/spaces supported); absolute paths, `..`, device/stream
names and ambiguous Windows spellings are rejected rather than shell-escaped.
Destination parent directories must already exist. No overwrite, cyclic moves,
overlapping or dependent targets within a batch. No automatic selection of junk.

All items are preflighted before effects. SHA-256 content/tree snapshots guard
observations and verify copies. Linked ancestors are never traversed. Remove
unlinks leaf symlinks/junctions, not their targets. Copy/move of links or trees
containing links is intentionally rejected in v1. Linked Git worktrees (`.git`
files), special objects and nested audit stores require their owning manager.
Ordinary repositories with a `.git` directory may be explicitly operated on.
Windows readonly regular files may have their attribute cleared through a no-follow
file handle only when singly linked; no chmod of links or shared hardlinks.
Unix readonly file unlink uses native directory permissions. File mode bits are
preserved when copying; ownership, ACLs, xattrs, resource forks and directory
metadata are not promised. Move is **verified copy then delete**, not an atomic
rename: it works across filesystems but needs temporary space and additional I/O.

`operationsRef` can replace `operations` with a same-session result containing
operation rows. Reading a reference does not authorize anything: all filesystem
preflight and current DSH policy checks run again.

### `ops_result`

```ts
// Small data is better processed directly in JavaScript.
const stored = await tools.ops_result({ action: "put", items: operationRows });
if (stored.status !== "completed") return stored;
const batch = await tools.ops_batch({ action: "run", operationsRef: stored.data.id });
if (batch.data?.detailsRef) {
  const page = await tools.ops_result({ action: "page", id: batch.data.detailsRef,
    offset: 0, limit: 64, maxBytes: 16384, fields: ["operation", "state", "error"] });
  console.log(page); // partial pages include an explicit continuation
}
const released = await tools.ops_result({ action: "release", id: stored.data.id });
console.log({ batch, released });
```

put stores object rows; page supports top-level equality and field selection,
not a general query language. `nextOffset`, `total`, `complete`, `omitted` are
explicit. Pages obey serialized JSON bytes (including escape/envelope allowance),
not raw text length alone. A row that cannot fit produces `OUTPUT_LIMIT`, not a
silent empty page. Complete data stays accessible through subsequent pages.

## Authority, cancellation and job ownership

Every invocation requires a calling session identity, DSH `sandboxPolicy`,
`systemPrompt`, `tools` and `subprocess`. In `workspace-write`, exact native argv
is wrapped through **`sandbox.confine`**. The original host's enforcement level
(`full` or `partial`, including Windows ACL partial) is accepted and reported.
Missing/broken confinement fails closed. There is no unconfined fallback.
`danger-full-access` intentionally bypasses confinement as the host policy defines,
and permits explicit roots outside the workspace. Policy is resolved again after
async sandbox preparation. `read-only` supports existing result pages through a
read-only shared lock and denies mutations or new records.
Approval/escalation stays with DSH; the component does not self-grant permissions.

DSH subprocess owns credential scrub, process termination and cancellation. Native
input is bounded stdin JSON, never a shell command or argv-sized path list. Unload
aborts and waits for in-flight work. Authority downgrade aborts active workers.
If host jobs/controller admission is available, batch foreground work uses that
registry's owner, cancel and progress surfaces, waits once, then removes its own
collected terminal record. Otherwise it remains a bounded foreground call; the shared host ceiling is 30 seconds.
No second background scheduler, detached-job polling tool or cloned REPL is created.
Progress is currently preflight/settlement only, not per-file live reporting.

## Recovery and persistence

The host allocates an audit reference **before spawn**, so cancellation/output
failure still returns `detailsRef`. A reference may be absent if interruption
preceded the initial plan commit: `NOT_FOUND` is not evidence that later effects
were completed. Once execution starts, each item has a durable write-ahead
`unknown` state before any filesystem effect, and a verified settlement after it.

- `pending`: not begun;
- `completed`: verified, never executed again;
- `failed`: refused before effects; resume rechecks the original revision;
- `unknown`: may have effects; resume checks postconditions only, never retries it.

An unresolved partial copy/deletion remains unknown for manual inspection/repair.
Recovery never substitutes new targets or protections. It binds normalized root
and opened-root device/inode identity, session, original operations and observations; restart in the same session can
recover, another session is denied. Preflight is not a rollback transaction.
A missing post-delete source proves the postcondition, not who deleted it.

Records live in `<workspace>/.dsh-ops/`, outside model output. Add `.dsh-ops/` to
workspace Git ignores; do not commit sensitive audit paths/data. Access control is
the local workspace's permissions plus same-session tool fencing; the store is
**not an encrypted or tamper-proof secret vault**. A workspace owner can tamper
with records; references are not capability tokens. Capability-relative handles
and no-follow operations prevent ordinary symlink escape, but a malicious process
actively renaming mounted/open directories or changing content during an effect
is outside the stronger protected-content guarantee: the operation is not atomic.
Do not run destructive cleanup concurrently with untrusted filesystem writers.

Result records expire after 24 hours and can be released, including after expiry.
Job audits do not auto-expire or permit release through the result tool. Archive
completed job IDs only while no worker is active; never discard unresolved records.
Latest snapshots preserve all item states; older committed generations are compacted
while retaining a predecessor. File sync + generation rename persist records;
Unix also syncs the store directory. Windows power-loss durability of directory
renames is not claimed (process interruption is covered).

Budgets: 512 operations, 128 protections, 100000 scanned entries, depth 128,
10000 stored rows, 2 MiB request/record, 64 MiB store/4096 files, pages 1..512
rows and 512..65536 bytes. Quota overflow fails explicitly. Logical bytes count
paths and can double-count hardlinks; they are not physical reclaimed space.

## Verification and remaining release gates

One isolated `test/ptc.test.mjs` contains three compact scenarios plus a native
host-provider acceptance block, separate from
all `native/src` and `lib/ptc` business code:

1. Mixed temp workspace: protected main, link cleanup, readonly Git file,
   copy/move verification, collision, changed observation and interrupted audit
   recovery without repeating completed/unknown effects.
2. 1000-row lossless pagination, budgets/projection, reference-to-batch and output
   limit recovery; schema/summary byte measurements (not invented model tokens).
3. Real Cordis/tools/prompt scopes + real worker, simulated confinement/jobs:
   SDK publication, native/hybrid isolation, authority denial, interruption facts
   and unload. The simulated provider is **not** evidence of OS sandbox isolation.

Windows x64: release build, clippy `-D warnings`, full `npm run verify` and original
DSH process sandbox acceptance executed.
Linux x64 (`x86_64-unknown-linux-gnu`): release build, `cargo test`, full
`npm run verify` (every suite that does not need a FastCtx runtime, i.e. 28 passed
and 2 skipped) and the native worker scenarios executed on the platform, including
the DSH local sandbox's workspace/temporary-area policy fence.
macOS arm64 (`aarch64-apple-darwin`) and macOS Intel (`x86_64-apple-darwin`) now run
the full gate in CI: `macos-latest` (arm64) is blocking, and `macos-15-intel` (x64)
is a non-blocking signal because the leg measured 318 s > 300 s. Both build and stage
their Mach-O worker, run the suite, and verify the receipt. The earlier 0.3.1
`cargo check --locked`-only record is superseded. A local Intel macOS 12.7.6 run
still has one expected `CLONE_ACL` failure, so macOS 12 remains a follow-up.
No fixed token/time saving percentage, actual model-turn benchmark,
live Desktop upgrade, npm release or GitHub push is claimed.

Architecture: `native/src/{contract,paths,batch,store,results}.rs` is the shared
Rust operation core; `main.rs` is bounded single-call JSON transport;
`lib/ptc/{contract,worker,index}.js` is only DSH registration/authority/transport.
Tests do not enter published business code.
