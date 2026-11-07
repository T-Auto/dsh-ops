# Disk and cache

English | [中文](磁盘与缓存.md)

Every disk resource OPS may create has a declared owner, retention category and default action.
`dsh-ops disk status` reports them read-only. The report **deletes nothing**, and no action on this
page is a promise that a future release evicts automatically: reclamation needs ownership evidence,
never a directory-name or modification-time guess.

## Running the report

```console
dsh-ops disk status                 # human table
dsh-ops disk status --json          # stable machine schema (dsh-ops/disk-status@1)
dsh-ops disk status --config row.json
```

`--config` reads a JSON file shaped like the row's config, for example
`{"disk":{"status":{"includeRepository":true,"maxEntries":100}}}`. It follows the same rule as
`ladder --config`: a key the plugin rejects fails here first.

The JSON report carries `schema`, `generatedAt`, `platform`, `home`, `tempRoot`, `workspace`,
`config`, `resources`, `totals` and `notes`. Every resource row carries `id`, `name`, `category`,
`owner`, `action`, `cleanupEntry`, `description`, `paths`, `samples`, `bytes`, `files`, `count`,
`ageMs`, `reclaimableBytes`, `reclaimBlocked`, `truncated`, `skippedCount` and `skipped`.

Sizes are apparent regular-file bytes: symbolic links are never followed and are reported as skips,
unreadable entries and out-of-root targets degrade to skips instead of failing the report, and a
traversal stops at `disk.status.maxEntries`. Nested rows (`R3`, `R4`, `R11`) are counted inside their
parent and excluded from `totals` so nothing is counted twice.

## Categories and default actions

| Category | Meaning | Default action |
| --- | --- | --- |
| `renewable` | OPS-created state that can be rebuilt or discarded | `report-only`: only a cleanup entry with ownership evidence may reclaim it |
| `diagnostic` | Panel capture, batch audit, ACL backup receipts | `never-touch`: the only record of what happened |
| `user-artifact` | Session temporary directories holding user/model work | `never-touch`: the plugin never deletes them |
| `host-owned` | Host subprocess spill directories | `report-only`: OPS never cleans another provider |

`report-only` means the row names why it is retained in `reclaimBlocked`; `explicit-command` means
only the named operator command may reclaim it; `never-touch` means no OPS entry point removes it.

## Resource inventory

| Id | Resource | Location (pattern) | Category | Action |
| --- | --- | --- | --- | --- |
| R1 | Niubash execution copies | `<OS temp>/dsh-ops-niu-exec-*` | renewable | report-only |
| R2 | Result cache roots | `<OS temp>/dsh-ops-results-*` | renewable | report-only |
| R3 | Result snapshots (nested in R2) | `<root>/s-*` | renewable | report-only |
| R4 | Batch audit stores (nested in R2) | `<root>/.dsh-ops` | diagnostic | never-touch |
| R5 | Session temporary directories | `<OS temp>/dsh-ops-session-*` | user-artifact | never-touch |
| R6 | Panel capture | `<workspace>/.dsh-ops/panel` | diagnostic | never-touch |
| R7 | Host subprocess spill | `<OS temp>/dsh-subprocess-*` | host-owned | report-only |
| R8 | Confined-Bash generations | `<DSH_HOME>/dsh-ops/bash-ipc` | renewable | explicit-command |
| R9 | Installed shells | `<DSH_HOME>/dsh-ops/shells` | renewable | explicit-command |
| R11 | Niubash payload swap (nested in R9) | `<DSH_HOME>/dsh-ops/shells/niubash.{stage,previous}-*` | renewable | report-only |
| R9b | Workspace ACL backups | `<DSH_HOME>/dsh-ops/acl-backups` | diagnostic | never-touch |
| R10 | Provision download scratch | `<OS temp>/dsh-ops-{bash,pwsh,niubash}-*` | renewable | report-only |
| R12 | Review probe scratch | `<OS temp>/dsh-ops-review-*` | renewable | report-only |
| R13 | Repository gate scratch | `<OS temp>/dsh-ops-{gate,pack,legacy-bash-fixture}-*`, `ops-ipc-build-*` | renewable | report-only |

R13 belongs to repository gate scripts, not to the shipped plugin, and is included only when
`disk.status.includeRepository` is on.

## Reclaim evidence

`reclaimableBytes` is non-zero only for a resource with real ownership evidence. Today that is R8
alone: the Bash IPC cache keeps a managed marker and leases, so `bash-runtime clean-cache
--yes --all-hosts-stopped` can name what it may reclaim. Every other renewable family reports 0 and
states the blocker (`reclaimBlocked.reason`), because a name prefix, an old modification time or a
dead PID does not prove no shell descendant is still using the files.

Operator entries:

- `dsh-ops bash-runtime remove --yes` removes receipt-owned shell payloads.
- `dsh-ops bash-runtime clean-cache --yes --all-hosts-stopped` reclaims idle Bash IPC generations.
- `dsh-ops uninstall --yes` removes the whole `<DSH_HOME>/dsh-ops` tree. It is deliberately broad
  and is **not** evidence that a cache lifecycle is solved; see
  [Upgrade and uninstall](upgrading.md).

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `disk.status.includeRepository` | false | Include repository gate scratch (R13) in the report |
| `disk.status.maxEntries` | 5000 | Entries one resource may visit before the traversal stops |
| `disk.retention.enabled` | false | Reserved: no eviction exists in this release |
| `disk.retention.maxAgeDays` | 0 | Reserved: 0 keeps everything |
| `disk.retention.maxBytes` | 0 | Reserved: 0 keeps everything |

The defaults above match `cordis.patch.yml`. The retention keys are validated so a future slice can
implement eviction without a breaking config change; nothing reads them for deletion today.

## What the report never scans

Shared npm/pnpm stores, `Downloads`, experiment areas, the Rust `target` directory, other plugins'
output, and any path outside the declared families are never measured. This keeps a read-only report
from becoming a cleanup tool by accident.
