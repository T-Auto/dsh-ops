# DSH 0.2.2-alpha.2 validation (#482)

中文：[0.2.2 宿主验证](宿主022验证.md).

**Draft investigation; this host remains outside `engines.dsh` and the DSH peer
range.** Compiling the adapter and running a tool directly do not establish
model-request compatibility. DSH 0.2.2-alpha.2 requires Node **24.9.0 or newer**;
the plugin's Node 22.19 floor continues to apply with its older supported hosts.

The port preserves the contributions from #486 and #487 and follows #542's
publication fixes. It uses the published Native and PTC executor packages and the
new batch execution API in tests. No host registry or executor is replaced by
product code. The ordinary lockfile stays on 0.2.1-rc.5.

## Reproduction

Use a disposable checkout and a separate dependency directory. The manifest in
`test/fixtures/host022/package.json` records the published host graph used for this
investigation. Install that manifest with `npm install --ignore-scripts`; point
only the disposable checkout's `node_modules` at that directory (a junction on
Windows or a symbolic link on POSIX). Keep the normal checkout and dependencies
intact. Build its matching worker with `npm run build:ptc`, then:

```console
npm run build
npm run typecheck
node test/run.mjs host-executor consumer-assembly preset-integration ptc-directory settings-ui host-metadata
node test/run.mjs progressive-loop credential-denial
node test/run.mjs ptc-sdk
```

The first group tests actual scoped Native file dispatch, Node PTC dispatch,
direct-call rejection in PTC, callback revocation, executor removal, metadata,
settings and provider composition. The metadata test deliberately **rejects**
alpha.2. Executor removal on alpha.2 leaves its scope unavailable until an
explicit replacement; it does not inherit an ancestor's executor.

The actual AgentLoop group is red on alpha.2: the first Native provider request
lacks `ops_discover_tools` or configured startup `ops_stat`; the second PTC
request lacks the selected `ops_stat` declaration. No model or network request
is needed: the real host loop drives a deterministic model response fixture.
The PTC SDK transition test also observes a stale first snapshot: after switching
to Native, the live registry has Native tools but the first assembly still
advertises `ops_load_sdk`; a second independent assembly sees the current list.

## Required admission contract

The published alpha.2 [`dsh-agent-loop`](https://unpkg.com/@deepseek-ai/dsh-agent-loop@0.2.2-alpha.2/lib/index.js)
resolves `toolSet` before assembling the prompt, then invokes `agent/pre-step`.
The published [`dsh-system-prompt`](https://unpkg.com/@deepseek-ai/dsh-system-prompt@0.2.2-alpha.2/lib/index.js)
collects tool schemas before the text waterfall and reattaches that original
array afterward. Returning a fresh assembly from an OPS waterfall cannot update
that original tool snapshot. Rejecting `agent/pre-step` consumes the claimed
message and is not a safe retry mechanism.

A useful upstream contract is an **awaitable scope preparation hook before
`tools.resolve()` and prompt collection**, or a bounded admission restart that
disposes the old ToolSet, prepares publication and recollects both schemas and
SDK text without consuming the pending user message or making a model request.
Acceptance should require the Native startup and request-two PTC assertions
above to pass, with permission revocation and cancellation still enforced.

Registration-time `when` conditions alone cannot add capabilities discovered
later: `tools.resolve()` captures the registry view before evaluating them.
Migrating OPS to stable pre-registered capabilities would require coordinating
the Native/PTC definitions, scoped ownership and incremental loader lifetimes;
that is a separate design change, not a version-range edit.

Alpha.2 also removes the old `modeFor` precheck. The compatibility tests retain
the conservative full-presentation fallback; they do not claim the older host's
Native precheck cost or Desktop startup timings for this host.
