# Read-only OPS sidebar

[中文](tui-panel.zh.md)

## Enable

In the dsh-TUI profile, enable the existing `dsh-ops/tui` bundle row and restart dsh-TUI. It is disabled by default. This uses experimental `tuiPanels` API v1 and needs a TUI build that admits exported subcomponents using their own nearest package manifest. Older builds that inspect only the outer manifest cannot provide reliable component identity.

Edit the existing row rather than adding a duplicate:

```yaml
id: dsh-ops-tui
name: dsh-ops/tui
disabled: false
config:
  maxSessions: 32
  maxActive: 128
  recentLimit: 8
```

The OPS tab does not open itself or change focus. No TUI/React runtime dependency is added: the host provides React and UI primitives. Without `tuiPanels`, only this optional row remains pending. Declined API-v1 registration starts no observer. OPS operation permissions are unchanged; the UI subcomponent has its own manifest without tool requirements, grants, commands or decision subscriptions.

## What it shows

- Live native and PTC OPS calls for the selected session, since this component was enabled.
- Calls, in-flight count, transport returns/errors and recent observed durations.
- Refusal, operation errors, preview/plan, partial failure and explicit unknown effects, read from the Native tools' presentation metadata and from PTC JSON envelopes; unknown effects warn against blind retry.
- Settled batch counts, omitted details and paging hints, never invented live progress.
- Tracking-limit warnings. A return is neutral, **not proof of business success**; a background launch returning does not mean the job finished.

This is not history replay or persistent accounting. Closing/reopening the tab preserves observation; unloading clears it. No command, argument, pattern, replacement, path, result body or error text is retained. Session changes select a different snapshot. No extra model/worker calls, job-output reads, polling, prompt sections or token-savings estimates are added. There are no destructive actions or send-to-chat controls.

Shell prose and spilled/truncated content cannot reliably establish business status and remain business-unconfirmed, never success. Native file tools and Native `ops_result` attach a bounded `opsOutcome` object to the host's replayable presentation metadata (status, error code and effect state, safe counters and booleans; never paths, items or messages), because their model text is not JSON. PTC children are classified from a single JSON text of at most 64 KiB. Model prose is never parsed into an outcome.

## Read-only filters and local pages

With the OPS panel focused:

| Key | Action |
| --- | --- |
| `f` | Cycle all rows → running → anomalies; reset to page one |
| `n` / PageDown | Next retained-metadata page |
| `p` / PageUp | Previous retained-metadata page |
| `a` | Acknowledge all-session notifications only |

Esc and left/right panel-switch arrows remain the host's; chat typing and modified shortcuts are not intercepted. The footer shows the filter, current page/page count and filtered retained-row count. Header statistics stay cumulative and unfiltered. The anomaly filter shows **only the selected session's retained anomalies**, not the all-session notification ledger. Acknowledging notifications does not remove rows.

Pages use only the bounded in-memory active/recent rows. They never execute tools, read session history, fetch `ops_result` pages or expand omitted result bodies. Long diagnostics continue on following pages with their tool name. Live settlements and retention eviction can move rows between pages; this is a live view, not a stable archive. Resize clamps the selected page; session changes and panel remount reset the local filter/page. Very short panels may only fit the summary: enlarge the panel to browse details.

## Aggregate anomaly alerts

The OPS tab uses the public badge API for newly observed refusals/partial failures (warning) and operation/transport errors or explicit unknown effects (error). Normal returns, previews and business-unconfirmed prose do not create alerts. Duplicate events do not inflate them. Observation continues while the panel is hidden; alerts never open the tab or move focus.

This is an **all-session aggregate since the last acknowledgement**, not the current session's failure count or an unresolved-issues list. The panel labels the scope explicitly. It retains only a count and the highest severity, no session IDs or result bodies; activity LRU eviction does not reset it. Counts saturate at 999 (the panel shows `999+` once exceeded).

With the OPS panel focused, press **a** to acknowledge all aggregate alerts. This only resets notification state, never session statistics, tools, permissions or jobs. Switching sessions and focusing the panel do not acknowledge it. The host may clear the tab indicator on opening the tab independently; the labelled aggregate count remains until acknowledgement or component unload. No missing opened/focused notification hooks or polling are assumed.

## Limits

Only these keys belong on the TUI row:

| Key | Default | Range |
| --- | ---: | --- |
| `maxSessions` | 32 | 1–256 retained sessions, LRU |
| `maxActive` | 128 | 1–1024 active calls per session |
| `recentLimit` | 8 | 1–64 recent settled rows per session |

These bound observer memory, not tool execution. At active capacity, new calls are omitted and statistics are marked incomplete. Evicting a session never cancels its work. The full component panel is used: compact-only rendering and send-to-chat are not available in the current TUI API.

## Verification

```console
node test/run.mjs tui-activity tui-panel tui-result tui-attention tui-navigation manifest
DSH_OPS_TUI_ROOT=/path/to/dsh-TUI DSH_OPS_REQUIRE_TUI=1 node test/run.mjs tui-host
```

The optional host suite resolves React/Cordis/rendering dependencies from the same TUI checkout or built package and isolates HOME/USERPROFILE/DSH_HOME before importing it. It tests real Loader admission, the exported OPS subpath, inline/fullscreen rendering at panel widths 28/38, session switching, focused navigation/acknowledgement, local repagination on resize/live settlement and unload. Tool events are synthetic: this is not native Windows, OS sandbox or manual PTY acceptance. Without the root variable the suite is counted as skipped, never passed; `DSH_OPS_REQUIRE_TUI=1` makes a missing root fail. Add `DSH_OPS_TUI_BUILT=1` to use `lib/types` in a compiled checkout. The target must resolve its test/peer dependencies; a production profile whose peers are supplied by the DSH launcher is not a standalone test root. Do not install test dependencies into a live profile to satisfy this suite.

### Real source-worker integration

Build the independent worker explicitly (Rust 1.97.1), then opt into the separate suite:

```console
cargo build --release --locked --manifest-path native/Cargo.toml
DSH_OPS_TUI_ROOT=/path/to/dsh-TUI DSH_OPS_TUI_WORKER=/absolute/path/to/dsh-ops/native/target/release/dsh-ops-worker DSH_OPS_REQUIRE_NATIVE_TUI=1 node test/run.mjs tui-native
```

This uses the real Rust worker, OPS file runtime, DSH tool runtime, AgentLoop and Session post-commit notifications, plus the real admitted sidebar and renderer. Model responses and policy selection are scripted fixtures; no online model is called. It covers native file reads, bounded listings, dry-run replacement and read-only refusal. PTC batch/result execution, production PTC-only publication, run_code execution, disk-persistence durability, Windows confinement and manual PTY acceptance are **not** covered. Only owned temporary fixtures are mutated; HOME/USERPROFILE/DSH_HOME stay isolated. The suite neither builds/downloads a worker nor changes the release platform resolver. Missing opt-in prerequisites are counted as skipped; the required flag makes them fail.

The sidebar does not change the package's declared targets: Windows x64, Linux x64, macOS arm64 and macOS Intel x64. UI tests alone do not establish native execution or OS sandbox acceptance.
