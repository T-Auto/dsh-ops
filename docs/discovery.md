# Advanced tools on demand

中文：[工具发现](工具发现.md).

`dsh-ops/discovery` publishes `ops_discover_tools` in each eligible Native scope. Describe a capability (`metadata revision hash`) or select an exact public name (`select:ops_stat`). Discovery only chooses tools; it performs no file action. A successful selection remains pending through the current tool round. Its owning session's committed `step/end` publishes it for the next provider request. The pinned host assembles before `agent/pre-step`; queued publication is therefore drained and the public prompt service reassembles a stale snapshot. Diagnostic assemblies before that committed boundary cannot activate pending names. Newly published tools remain scoped to their owner; parents, children and siblings must discover independently.

The seven-row bundle enables this component by default and preserves existing named row overrides. Its configuration is:

```yaml
- name: dsh-ops/discovery
  config:
    enabled: true
    maxResults: 3
    allowedTools: [inspect_local_file, result, glob, grep, replace, write_file, edit_file, diff, stat, copy, move, remove, read_table, read_docx, read_pdf]
    alwaysLoaded: []
```

| Setting | Default | Contract |
| --- | --- | --- |
| `enabled` | `true` | Publish the discovery entry. `false` preserves `alwaysLoaded` tools. Disabling the entire loader row unloads all its owned tools. |
| `maxResults` | `3` | Maximum selections per call, integer 1-5. A call's optional `max_results` is also validated as 1-5 and capped by this setting. |
| `allowedTools` | All implemented advanced names above | Allowed pool of raw capability names. Unknown/unimplemented formats are rejected, rather than advertised as usable. |
| `alwaysLoaded` | `[]` | Choices from the allowed pool that bypass discovery and are available at the first eligible step. |
| `binaryPath` / `required` | Automatic / `false` | Worker selection and activation failure behavior, as for native file tools. |
| `denyCredentialReads` | `true` | Preserve the native file credential fence. |

Configuration arrays are copied and deduplicated; unknown configuration keys are errors naming the key. Search is a deterministic keyword match over reviewed metadata, with stable tie ordering; it does not call a model. `query` is nonempty and at most 512 characters; extra action arguments are rejected. The implemented read_table, read_docx and read_pdf capabilities are discoverable with the bounded CSV/TSV, DOCX and restricted PDF contracts in [native-kernel.md](native-kernel.md). Binary DOC, OCR and unsupported PDF encodings are not advertised as usable.

Every activated file tool keeps its declared path base, argument schema, Native rendering, worker permission checks and revision/CAS contract. Read-only scopes cannot activate mutation tools. A sandbox-mode change clears that session's pending requests, cancels its active calls and re-evaluates registrations; other sessions retain their choices. Disposing an agent or unloading the component removes registrations and invalidates cached definitions. Pure PTC scopes do not publish this Native discovery surface; the PTC adapter owns its SDK.

Only this plugin's scoped `ctx.tools.register`, `restrict`, prompt sections and lifecycle listeners are used. No host method or shared tool registry is replaced. Publication compares the desired tool names before changing registrations so it can coexist with PTC lifecycle listeners.

## Incremental presentation checks

Adding an agent probes its presentation without reassembling unchanged agents. Background reconciliation reuses only a successful presentation decision, keyed by the agent context, session, cwd and freshly resolved sandbox policy (mode, workspace root and session identity). Starting the discovery worker with no resident tools does not emit a no-op tool-registry change. The inexpensive policy/ownership and desired-tool diff still visits existing entries; this is not a claim of constant-time reconciliation.

`tools/change`, `system-prompt/change`, runtime configuration updates and discovery-row ownership changes invalidate decisions. The global runtime-update hook awaits `next()` before invalidating: the pinned host's default returns an asynchronous `Fiber.restart()` despite its `void` declaration, while an in-place update can be synchronous. The pinned host's registry notifications have no affected-scope payload. OPS-owned synchronous registration changes carry package-local scope attribution, so only the changed scope and its descendants lose cached decisions. Unknown external changes still conservatively invalidate all entries, including a new scoped presentation declaration. No host event or registry method is replaced. Discovery registers its own prompt provider once per row, not once per agent. A session's `sandbox/mode` event invalidates only its entries. Required host-service unload removes the row's registrations and cache; reload rebuilds them. Optional PTC-runtime mount/unmount also refreshes decisions, and failed probes are not cached.

Arbitrary dynamic prompt providers need not emit any change event. For that reason, each model pre-step and every tool execution performs a fresh check for its own agent; this cache never authorizes a call. Runtime policy and cwd remain live inputs, including when the same agent object is reused. Native and `both` can publish discovery; pure PTC cannot. Invalidation during an asynchronous probe retires that result before publication; queued work and unload cleanup remain authoritative.

`node test/run.mjs discovery-incremental discovery-composition presentation-readiness progressive-loop` covers counting, invalidation, scoped ownership and lifecycle races. The incremental fixture adds one agent beside twelve existing agents and asserts **zero old-agent probes and one new-agent probe**; this is a deterministic assembly count, not a wall-clock benchmark.

## Incremental publication boundaries

PTC publication lifts and rebuilds only the affected inheritance family, preserving unrelated root sessions' SDK and Bash definition identities. A connected parent/child family is processed together because an ancestor's PTC claim can hide the Native provider a child must inherit. Native source-provider revisions detect registrations hidden behind an existing PTC override; unknown external registry changes conservatively revalidate Native shadows so a foreign ancestor restriction cannot be bypassed. Superseded publication requests are merged rather than dropped. Live execution still checks the authoritative calling scope and presentation.

The Bash component retains unchanged per-session definitions and inherited masks. Authority transitions update changed layers, while jobs/subprocess service replacement explicitly refreshes definitions. Neither component eliminates all inexpensive ownership, policy or tool-view scans. Real-host counter tests (`session-incremental`, `shells-incremental`) assert bounded attach probe/event counts and unchanged unrelated definition identities, separately from wall-clock GUI/session-create performance.

Bash publication coalesces lifecycle notifications until the next event-loop turn, after the host finishes publishing the session event. Retained callbacks still check current authority before execution, including while withdrawal is queued. Component unload cancels queued publication. Awaited agent creation includes Bash publication; a prompt racing a pending pass waits and rebuilds its schema snapshot. Disposal requested during an append also defers registry writes, while retained callbacks become inactive immediately. The PTC assembly listener accepts the text-only `PromptPresentation` waterfall introduced in DSH 0.2.1-rc.3; its separate full-assembly probes still require the single `run_code` schema and the nonempty PTC instruction. This hook compatibility is not a claim that every rc.3 host API has been validated. `session-lifecycle` also covers a first prompt racing delayed discovery startup: selected replacement validation waits for publication instead of rejecting a correct configuration.

## Measurement boundaries

The deterministic entry measurement uses `js-tiktoken@1.0.21` with `cl100k_base`, encoding compact JSON of the pinned host `ToolSchema` fields (`name`, `description`, `parameters`). The discovery entry is **95 tokens / 416 UTF-8 bytes**. This is a reproducible schema measurement, not provider billing, and excludes tool-message framing, prompt guidance and other OPS components. The tokenizer is a test-only dependency published on 2025-08-09; its locked `base64-js` dependency is also test-only.

The default file/discovery surface is now `ops_read_files` plus `ops_discover_tools`: **242 tokens / 1101 bytes** in actual host assembly order. The reader accepts multiple file ranges in one startup call; `ops_inspect_local_file` (including hex), search, mutations and Native result paging are discoverable. Routing names only published tools. The final Windows provider order with the full Bash/jobs contract measures **662 tokens / 3226 bytes** (the pre-rename snapshot was 660/3219; the older catalogue-order figure was 661 tokens). These full totals remain visible under the explicitly approved BM-03 scope: the ≤400-token gate applies to file/discovery schemas, while Bash remains at startup. Numeric bounds, defaults, path bases and permission contracts remain intact. Operator always-loaded choices expand the initial surface. See [benchmark evidence](benchmark-gates.md).

BM-04 now runs the implemented PDF reader through the real AgentLoop: its schema is absent initially, remains pending in the current round, appears in the owning next provider request, stays absent for a sibling, and then returns the fixture text. This verifies the supported PDF subset, not general PDF/OCR coverage.

Built-in settings persist validated arrays. Optional browser multi-selects use the pinned host client APIs and need the explicit offline carrier described in [configuration](configuration-reference.md); they are not activated by the default legacy file row.

Overlapping discovery rows use the nearest owning scope; the last row mounted in the same scope wins until it is unloaded. File rows may mount before or after discovery. Only exact OPS-owned Native registrations are yielded or masked; unrelated external registrations remain visible. PTC Native shadows retain their exact origin, and discovered activations cannot be inherited by another agent. Native `result` is page/release only and may be discovered in read-only mode; the worker still rejects forbidden release actions. Resident `read_files` and discoverable `edit_file` retain their existing per-file completeness and CAS contracts.

BM-03 now gates the approved file/discovery subtotal, and separately reports Bash and the full default Native surface. The exact default inventory remains mandatory, including a usable Bash (pinned Windows payload or host Bash) and its host jobs contract; absence blocks the measurement rather than earning a smaller score. Scope approval does not change tool defaults, arguments or permission boundaries.
