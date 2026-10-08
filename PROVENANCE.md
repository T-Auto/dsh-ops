# Provenance

What this repository is, where its parts came from, what was verified, and what
was not.

## 0.2.1 packaging work — not published

The assembler now builds all three Windows x64 payload packages. Bash carries
complete, unmodified PortableGit 2.56.0.2 (GNU bash 5.3.15); pwsh carries complete
PowerShell 7.6.6 under bin/. Original licenses/notices are preserved. Archive
and executable hashes are pinned in lib/shells.js. All three runtime packages
are injected into the main publish artifact; no install lifecycle downloads.

The maintainer authorized publication after the source-delivery risk was reported.
The actual first-package publish was rejected by npm with E403: 2FA or a granular
token with bypass 2FA is required. No package was published. PortableGit's
etc/package-versions.txt includes many GPL/LGPL components; complete matching
source closure/delivery has not been collected or reviewed. Retaining upstream
licenses does not attest that those obligations have been fulfilled. No source
offer is invented. Historical 0.2.0 pin-package descriptions below do not describe
this new payload layout.

The profile installer delegates to the official DSH CLI, retaining its locks,
compatibility checks and rollback rather than cloning them. Live installation
on each application version has not been attested. Default README is Chinese;
README.en.md is the English counterpart.

## Current slimming-pass evidence (supersedes historical ladder claims below)

This pass changes only plugin presentation, registration, and result projection; no vendored functionality changed. Historical tables below describe the earlier implementation and its earlier tests, not acceptance of the current revision.

- Restored three-layer intent: tools → ops_bash → PowerShell 7. `lib/session-shells.js` publishes bash through plugin-owned agent child fibers only with full-access authority and the subprocess service; it is independent of FastCtx availability and enableShellTools. Prompt routing prefers bash for general commands, not PowerShell fallback.
- Permission authority: host `packages/sandbox/sandbox-policy/src/index.ts:157-186`, `sandboxPolicy.resolve({session})`; durable mode event at `src/session-mode.ts:25-56`.
- Session mode feed: `ctx.on('session/event', (session, event))`, not client-wire projection change notifications. The plugin reconciles plugin-owned agent child fibers on `sandbox/mode`.
- Own registration scopes: `packages/core/tools/src/index.ts:1058-1088`; inherited restrictions and own-layer exemption at `:1090-1124,1163-1206`; prompt callbacks use assembly agent plus `ctx.get('tools').schemas(agent)`.
- Concurrency API: `packages/core/tools/src/index.ts:267-280,1303-1309` requires a pure function, not a boolean. FastCtx's read/search handlers use shared bounded permits and blocking executors (`vendor/fastctx/src/server.rs:198-280`); MCP request IDs isolate pending replies. Only read-only tools opt into sibling overlap.
- Host timeout metadata requires work quiescence; the current MCP transport removes pending waits but cannot prove server cancellation. No host `timeoutMs` promise is added.
- Job launch ID is parsed only from FastCtx's successful terminal marker (`vendor/fastctx/src/shell/jobs/mod.rs:232-278`); global durable lists at `:1053-1250` are projected to session-owned IDs. Footer grammar/placement comes from `vendor/fastctx/src/background_status.rs`.
- Baseline at pre-change plugin HEAD `dee3c57`, runtime FastCtx 0.2.6, is recorded in `docs/schema-baseline.json`. `scripts/measure-schemas.mjs` measures compact name/description/parameters JSON, not use frequency or actual billing.
- Per operator instruction: no regression tests or CI added, no existing suite updated or run. Syntax checks and schema-list measurements are not runtime acceptance. See `docs/manual-validation.md`.
- Residual boundaries: file tools remain outside the host filesystem sandbox; shell-mode gating does not confine `ops_replace`. Approval and sandbox state are separate; no new approval escalation is implemented. Reconnect loses job ownership and does not prove durable jobs terminated.

## Two bodies of work

| | Author | License | Where |
| --- | --- | --- | --- |
| The dsh-ops plugin | this repository | MIT | `lib/`, `bin/`, `scripts/`, `test/`, `cordis.patch.yml`, `dsh-plugin.json`, docs |
| FastCtx, vendored | [yc-duan](https://github.com/yc-duan) | Apache-2.0 | `vendor/fastctx/` |

`vendor/fastctx/UPSTREAM.md` records the exact upstream revision;
`vendor/fastctx/FORK.md` records every difference from it — the distribution
machinery removed, the standalone-only code removed, and every source file this
fork touches (each carries its own Apache-2.0 §4(b) notice at the top). The
composite licensing statement is in `NOTICE`.

## Distribution and binary sources

The plugin reaches a profile as a dependency of that profile — `dsh plugin
--profile <p> add dsh-ops`, or `plugin_manager { action: "install_bundle" }`. What
that install brings is this distribution's own work: one payload we build, and two
pins. The channels and the commands are described in the README under "What an
install brings".

### What this distribution ships

| Artifact | Contents |
| --- | --- |
| `dsh-ops@0.2.0` | the plugin itself: JavaScript, the manifest, the bundle patch, and the vendored FastCtx source. 497,013 B packed, 2,339,108 B unpacked, 130 files |
| `@dsh-ops/fastctx-win32-x64@0.2.0` | **a payload we build**: this fork's FastCtx, `bin/fastctx.exe` |
| `@dsh-ops/bash-win32-x64@0.2.0` | **a pin only**: upstream URL, release, version, byte count, and SHA-256. No binaries |
| `@dsh-ops/pwsh-win32-x64@0.2.0` | **a pin only**: the same for PowerShell 7. No binaries |
| `SHA256SUMS` (release asset) | the digests of those four tarballs, attached to the tag's GitHub Release beside them |

### What this distribution does not ship

The Git for Windows and PowerShell archives are **not** redistributed here: no
tarball, no release asset, and no cache in this repository holds them.
`dsh-ops provision-shells` reads the pin, downloads the archive from the upstream
URL on the user's own machine, verifies it against the pinned SHA-256, and unpacks
it under `<DSH_HOME>/dsh-ops/shells/<name>/<version>/`. Those bytes travel from
upstream to that machine directly, and the licences below are the ones the user
obtains them under.

### The pins

| Package | Upstream source | Release | Version | Artifact | Bytes | SHA-256 | Licence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `@dsh-ops/fastctx-win32-x64` | this fork's build of `vendor/fastctx/`, upstream `yc-duan/fastctx` at `ccaa157790d02328a60786eb94ee5ad698995a5f` | `v0.2.6` | `0.2.6` | `bin/fastctx.exe`, built here | 49,492,480 | `7f4b494627cf3c0b298dd0b6d36624fd09d35bd1add655c5d55e0372e9e20987` | Apache-2.0 |
| `@dsh-ops/bash-win32-x64` | [Git for Windows](https://github.com/git-for-windows/git) | `v2.56.0.windows.2` | `2.56.0.2` | `PortableGit-2.56.0.2-64-bit.7z.exe` — fetched by the user, not redistributed here | 60,027,568 | `075e158ef8e1f0ab80b347e245405d3eca735c2dc88fd8e032e137d0ca61f61b` | GPL-2.0-only |
| `@dsh-ops/pwsh-win32-x64` | [PowerShell](https://github.com/PowerShell/PowerShell) | `v7.6.6` | `7.6.6` | `PowerShell-7.6.6-win-x64.zip` — fetched by the user, not redistributed here | 106,328,873 | `02fe458be20493fbdf43f61ea20610b811ee6c738ab1676c61b9cfcd1a33c860` | MIT |

The pin values live in one table — `SHELL_UPSTREAM_PINS` in `lib/shells.js`, which
`dsh-ops provision-shells` downloads from and the release build imports when it
publishes the pinned facts beside the packages it assembles — and the release's
`provenance.json` records what was built from them. The URLs are upstream's own
release URLs verbatim, so a pin can be checked against the upstream release page
rather than trusted from here. Each pin also records the digest of the executable
inside its archive (`bin/bash.exe`, `bin/pwsh.exe`), which the provisioner re-checks
after unpacking, so an archive that yields something else is refused. Unpacked, the
bash pin is about 390 MiB and the PowerShell pin about 245 MiB on disk — which is
why neither is part of an install.

Every `@dsh-ops/*` platform package is an optional dependency of the published
main package, and each one carries its own `LICENSE`, `NOTICE`, and metadata beside
that payload or pin.

### The licence each pin points at

The plugin's composite statement is `MIT AND Apache-2.0`, and it covers the plugin
alone. The two shell pins point at someone else's distribution:

- **`fastctx` — this fork's Apache-2.0, plus upstream's notice.** The payload is
  built here from `vendor/fastctx/`, so it ships `vendor/fastctx/LICENSE-APACHE` and
  `vendor/fastctx/NOTICE`, and every source file this fork touched already carries
  its own §4(b) change notice (`vendor/fastctx/FORK.md` is the enumeration).
  FastCtx's required attribution is reproduced verbatim in `NOTICE` and in both
  READMEs; that text is reproduced, never edited.
- **`bash` — Git for Windows' GPL-2.0.** The pin names the upstream archive and its
  digest; the download, the extraction, and the resulting copy on disk are the
  user's, and the GPL-2.0 terms (and the corresponding source, published by the Git
  for Windows and Git projects) attach to those bytes. No GPL-2.0-covered component
  is part of this distribution, which is why nothing here carries a GPL text or
  makes a source offer for code it does not ship.
- **`pwsh` — Microsoft's MIT.** The same shape: the pin points at Microsoft's own
  release asset, the download happens on the user's machine, and the licence text
  and copyright are Microsoft's. Nothing in the plugin's MIT grant covers it.

## Host targeting

The plugin targets DSH `0.2.0-rc.2`, the version of the desktop installation this
was developed against.

The source of that exact version is readable on this machine: `dsh-core/v0.2.0-rc.2/`
is a checkout of tag `dsh-v0.2.0-rc.2` (`639ed015`, commit date 2026-09-29),
14,104 files. The installed host itself ships inside `app.asar` and stays
unreadable from a shell, so the readable copy is what "the host" means below.

Each depended-on API is therefore established twice: **read** from that source,
with the file and line recorded here, and **run** by the suite named in the same
row. The line numbers are of `dsh-core/v0.2.0-rc.2/` and will move with upstream;
the file is the durable part.

| Depended on | Read from | Run by |
| --- | --- | --- |
| `new Context()`, `ctx.plugin`, `ctx.inject`, `ctx.effect`, `ctx.on`, `ctx.waterfall`, `ctx.get` | Cordis source, vendored: `vendor/cordis/src/` | the mount suite boots a real context and disposes it |
| `tools.register(definition)` — one object argument, returns the unregister disposer | `packages/core/tools/src/index.ts:1057-1088` | the mount suite reads back the nine registered schemas, and the shells suite asserts the `ops_bash` definition and that its disposer removes it |
| `tools.restrict(filter)` — `{allow?, deny?}` over the global tools of one agent scope; requires a scoped context, rejects unknown names, intersects, lifts on dispose | `packages/core/tools/src/index.ts:1090-1124`, type at `:700-705` | **used by this plugin**: on `agent/created`, and only while a rung of its own is live, it masks the configured host shell tools out of that agent's own view (`lib/index.js` `hideHostShellTools`), and the disposer it returns is handed to the plugin's effect too. The mount suite asserts the masked names leave `schemas(agent)`, stop resolving through `get(name, agent)`, are still refused by the fence, stay registered globally, and come back when the plugin unloads; a name the agent registered itself makes `restrict()` throw, which the plugin reports once and leaves visible |
| `tools.guard(guard)` — monotonic denial registered after the pre-execute waterfall; the guard returns a denial reason or `undefined` | `packages/core/tools/src/index.ts:1126-1142`, type at `:723-731` | not used by this plugin yet: the fence at `tools/pre-execute` — with its model-readable reason and its `next()` delegation — plus the per-agent mask already implement `deny-host-shell` |
| `tools.get(name, scope?)` — the definition one scope resolves, or undefined; the lookup half of "visibility, lookup, and execution agree" | `packages/core/tools/src/index.ts:1230` | the mount suite only: a masked host shell name must not resolve for that agent while it stays registered globally |
| `ctx.on('agent/created')` and the agent's own scoped context (`agent.ctx`) — the event fires once per agent, after its scope is published and before its queued work is released and its prompt first assembled; the payload is `{agent, source, signal}` | `packages/core/agent/src/runtime-types.ts:261` (the typed event), sequenced at `packages/core/agent/src/index.ts:172-181` and emitted serially at `:550` | the mount suite dispatches the real event (`ctx.serial('agent/created', …)`) into real `@deepseek-ai/dsh-scope` scopes and asserts all three outcomes: hidden while a rung of the plugin's own is live, reported-and-visible when no such rung is live, and reported-and-visible when `restrict()` cannot name the tool |
| `tools/pre-execute` waterfall, `(exec, next) => PreToolDecision`, `@mode waterfall` | `packages/core/tools/src/index.ts:142-153` | the fence suite dispatches the real waterfall and asserts `{kind:'deny'}` |
| `systemPrompt.section({name, order, text, interpolate})`, duplicate names throw, returns an effect disposer | `packages/core/system-prompt/src/index.ts:446-463`, `PromptSection` at `:52-76` | the mount suite renders both sections from a real assembly |
| `systemPrompt.assemble({})` resolves sections in ascending order, equal orders by name | `packages/core/system-prompt/src/index.ts:548-558`, sort at `:237-238` | the mount suite asserts both sections appear in one assembly |
| `ctx.get('tools').schemas()` — one deep-cloned schema per visible tool, the global view when no scope is passed; the plugin's only answer to "are the `ops_` tools live right now" (asked at every prompt assembly) and to "which host shell names does this agent actually see" (asked when it hides them) | `packages/core/tools/src/index.ts:1252-1262` | the mount suite renders the tooling section from a real assembly and asserts it names exactly the live tools; it also reads `schemas(agent)` before and after a mask |
| `ctx.get('subprocess')` — the abstract `SubprocessRuntime`: `spawn(spec)` with a fully explicit `argv`, `cwd`, per-stream stdio, `graceMs`, cancellation, and `env` overrides merged after the service's own credential scrub; `argv` is never shell-interpreted | `packages/subprocess/subprocess/README.md:28` (mount and consume), `:44-46` (the call shape), `docs/subsystems/subprocess.md:91-104` (the fully-explicit spec), `:267-269` (`ctx.subprocess` registration) | the shells suite, through a recording subprocess service: `ops_bash` spawns `argv: [<resolved bash>, '-c', <command>]`, forwards exactly the terminal overrides, adds no credential-shaped name of its own, and reports a missing service instead of throwing something opaque. The mount suite is where the service is real, and where the registration is shown to be gated on it: with no `ctx.subprocess`, a resolved bash publishes no rung and installs no mask |
| the credential rule both spawn paths keep: a child never inherits credential-shaped names or ambient `DSH_*` facts, and a transport that owns its own spawn (the SDK client, MCP) stays outside the service so the policy has one source | `packages/subprocess/subprocess/README.md:80` (the scrub and its merges), `:84` (route around the service when the transport owns the spawn), `:104` (`scrubbedParentEnv`), `packages/subprocess/subprocess-local/README.md:156` (the scrub is a name heuristic, not a guarantee) | the mount suite's `childEnv` check, for the MCP child. That child's rule is restated in `lib/tools.js` `childEnv()` rather than imported, because importing `scrubbedParentEnv` would be the `@deepseek-ai/*` value import this host half forbids; the `ops_bash` child gets the service's own scrub instead (`ctx.get('subprocess')` above) |
| this plugin's own `ops_` namespace is its conflict domain: a name already registered in the same scope throws, so the whole generation is rolled back rather than half-published | `packages/core/tools/src/index.ts:746-748` (both duplicate branches) | not covered against the real host — no suite publishes a colliding name; the fixture's registry raises on a duplicate (`test/mount.test.mjs`) and `#publish` in `lib/tools.js` is where the rollback lives |
| a bundle is a package declaring `dsh.bundle.patch`, and a layer replaces a row's whole `config`: | `docs/user/develop/basic/publish.md:11-16`, `:56-64`, `:129-132` | `scripts/validate-manifest.mjs` parses the shipped patch and runs the row's config through the plugin's own validator |
| Cordis answers every service property read with a fresh traceable wrapper | `vendor/cordis/src/utils.ts:116-125` (`getTraceable`) and `:165-218` (`createTraceable`, a new `Proxy` per read) | the incident's regression assertions in the mount suite: the registry carries no own `register` after mount, and the same foreign name registered once in each of two scopes stays out of this plugin's global view |
| `ctx.pluginManager` (`installBundle`, `removeBundle`, `setBundleEnabled`, `setPluginEnabled`, `inspect`, `registries`, `waitForInstall`, `cancelInstall`, version exemptions) | `docs/subsystems/boot.md:85-180` | not run here; the install path is exercised by hand, not by a suite |

One row left this table when the plugin began speaking MCP itself:
`@deepseek-ai/dsh-mcp-client` and its `mcp__<serverName>__<rawName>` naming
contract are not part of this plugin's dependency surface — nothing in `lib/`
imports it, mounts it, or names anything after the names it would have produced.
The `0.2.0` changelog entry records its removal from `package.json`, together with
the declaration and the manifest check that went with it.

The package versions under test are pinned in `devDependencies`, so the gate is
reproducible. Because those are npm releases of the same packages rather than the
copies inside `app.asar`, a host-side API change between `0.2.0-rc.2` and what
this repository installs surfaces as a red mount suite.

Two things the read established that the earlier execution-only record could not:

- **`tools.register` takes one object, not `(name, definition)`.** The earlier
  record said "the ToolRuntime `register`", which left the argument form to the
  suite. The signature is `register(definition: ToolDefinition): () => void`
  (`packages/core/tools/src/index.ts:1063`), and it validates `output.schema`,
  `output.render`, and `timeoutMs` before registering.
- **`restrict` and `guard` exist, with exactly the monotonic semantics this
  plugin's design assumes.** `restrict` narrows what one agent inherits
  (`:1097`), `guard` denies after the waterfall and cannot be turned back into
  permission by a later listener (`:1136`, `:723-731`). The plugin uses `restrict`
  for the visibility half of `deny-host-shell` and is runtime-verified for it; it
  registers no `guard` yet, so that half is read-only here.

### The boundary the 2026-10-08 incident established

**What happened.** While the plugin still mounted the harness MCP bridge, it
renamed that bridge's tools by installing an interceptor on the shared tool
registry — `interceptBridgeRegistrations` wrote an own `register` property on the
service object. A Cordis service property read returns a wrapper **bound to the
reading context** (`vendor/cordis/src/utils.ts:165-218`), so the interceptor's
`original.call(…)` attributed every later registration — including foreign ones —
to *this* plugin's host plane. The host's second registration of a name that
another plugin installs per agent (`subagent`) then collided and **every new
session failed**: `tool "subagent" is already registered (for a per-agent variant,
register through that agent's `agent.ctx` instead)`
(`packages/core/tools/src/index.ts:746-747`, the `scope === undefined` branch,
i.e. the global layer). A fresh `DSH_HOME` without this plugin did not fail, which
is what located the fault here rather than in the composition.

**What stands now.** The plugin publishes its own tools through its own
`ctx.tools.register` (`lib/tools.js` for the hosted nine, `lib/shells.js` for
`ops_bash`) and rewrites nothing: no own property on the shared registry, no
replaced service method, no name derived from another component's naming. The one
place it acts on another context's tools is `agent.ctx.tools.restrict({ deny })` —
the documented per-agent visibility call, made on that agent's own scoped registry
to hide the host shell tools this deployment asked to deny. The symptoms, the
mechanism, and the regression contract are stated in the plugin's `AGENTS.md`,
"上游兼容 (upstream compatibility)"; that section is the authority for the
boundary, and `test/mount.test.mjs` is the executable form of it.

Rules that follow, and that this repository must not regress:

- **Do not replace a shared service method to observe or reshape it.** Reading a
  service method is not identity-stable, and the wrapper carries the caller's
  context, so re-entering through a saved `original` changes whose registration it
  is.
- **The public namespace is this plugin's own registrations.** `ops_<name>` comes
  from `publicToolName()` in `lib/policy.js` and is registered into this plugin's
  scope, so no other component's naming can change or claim it.
- **Release only through the disposers the surface collected.**
  `ctx.get('tools').register` is not identity-stable across two reads
  (`ctx.get('tools').register !== ctx.get('tools').register`), so a registration
  cannot be recognized by function identity; one generation is published and
  released as one unit.
- **Foreign registrations are none of this plugin's business.** A name in another
  server's namespace, a lookalike of this plugin's own, or the same name in two
  scopes must survive a mount, an unload, and each other — `test/mount.test.mjs`
  is what keeps that true.
- **Act on another context's tools only through its documented API, on that
  context.** The per-agent mask is `agent.ctx.tools.restrict({ deny })`, called on
  the agent's own scoped registry and released through the plugin's effect as well;
  the plugin never reaches into a registry instance and never names a tool that
  agent registered itself.

### Not verified here

- **A real `dsh plugin add` into a live profile.** The profile that booted the
  session which produced this record is the one that installed the plugin by
  `link:`, so the install did happen — but through a manual profile edit, not
  through `dsh plugin`. The *installation path* (`dsh plugin --profile … add`, the
  profile's `dsh.profile.bundles` ordering, the host compatibility gate reading
  `peerDependencies`) is documented from the harness sources above, not exercised
  by a suite in this repository.
- **Hot reload of a replaced package.** `ctx.hmr` is read
  (`docs/subsystems/boot.md:56-83`) and the upstream rule that replacing an
  installed package needs a restart is quoted in the README
  (`packages/preset/agent-preset/skills/cordis-plugin-development/references/host-plugin.md:60`),
  but no suite here replaces a mounted package and observes the new module
  generation.
- **A conflicting registration against the real host.** `lib/tools.js` publishes
  one whole generation and rolls a partial one back when a name is already taken,
  but no suite publishes a name that collides with this plugin's `ops_` namespace
  against the real registry: only the fixture's own registry in
  `test/mount.test.mjs` raises on a duplicate.
- **The platform packages and the pins, against a real tag.** The release step
  declares `@dsh-ops/fastctx-<platform>-<arch>` and the two pins, and the shell
  layouts they can resolve to are exercised against a temporary install in
  `test/shells.test.mjs` — including the L3 expression agreeing with the plugin's own
  probe on every layout. What has never run is the release pipeline itself: no tag has
  been pushed and nothing has been published, so no tarball and no Release asset has
  been fetched from a release, and no deployment has yet resolved a runtime from one.
  The first real tag is what has to prove that path end to end.
- **A `provision-shells` download against upstream's live assets.** The pin values
  are read from `SHELL_UPSTREAM_PINS` in `lib/shells.js`, and the digests there were
  checked against the archives this machine downloaded while the release build was
  assembled — but that was a build-time fetch here, not `dsh-ops provision-shells`
  fetching into `<DSH_HOME>/dsh-ops/shells/` on a user's machine, and not a
  re-download of the pinned bytes after upstream had served them again. Whether
  upstream still serves the pinned URL, and whether the extracted tree is the one the
  plugin's probe accepts, is what the first run of that command has to establish.
- **A real DSH boot running the L3 override.** The patch's `!!js` expression is
  parsed from `cordis.patch.yml` and evaluated the way the vendored loader does it
  (`with (ctx) { return eval(expr) }`, `vendor/loader/src/config/utils.ts:5-9`) —
  inert without a bundled pwsh, resolving one with it — but no DSH boot has mounted
  the patched `pwsh-sandbox` row.

## Design decisions worth recording

### Two spawn paths, one credential policy

The plugin reaches every host service through `ctx.inject([...])` / `ctx.get()` and
imports no `@deepseek-ai/*` value at any point. That leaves two ways to start a
process, and the credential rule is kept on both.

**The FastCtx server is the plugin's own spawn** (`lib/handshake.js`,
`node:child_process.spawn`), because it is the plugin's transport, and the harness's
own guidance for that case is to stay outside the subprocess service — "when a
transport owns its own spawn (the SDK client, MCP), route around the service and
import `scrubbedParentEnv` directly so environment policy stays single-sourced"
(`packages/subprocess/subprocess/README.md:84`). Importing `scrubbedParentEnv` is
exactly the value import this host half forbids, so the rule is restated in
`lib/tools.js` `childEnv()`: credential-shaped names (`*KEY*` / `*PASSWORD*` /
`*SECRET*` / `*TOKEN*`) and ambient `DSH_*` facts are dropped, tool configuration
locations such as `GH_CONFIG_DIR` survive, and the mount suite pins that behaviour.
The heuristic has the limits upstream documents
(`packages/subprocess/subprocess-local/README.md:156`): a differently named secret
passes through.

**`ops_bash` goes through the service** (`lib/shells.js`). It has no reason to own a
spawn, so it takes the harness's real credential scrub, output spilling, and
process-range termination, and supplies only the argv, the directory, the budgets,
the terminal overrides, and its cancellation — read with `ctx.get('subprocess')`
rather than imported. Nothing in the plugin writes `process.env`, `PATH`, or the
working directory.

### One question decides the ladder and the mask

`ladderLevels({published, pwsh})` (`lib/policy.js`, a pure function) turns the
published `ops_` names plus one resolution fact into the three rungs: rung 1 is live
when any published name is not one of this plugin's own in-process tools — so the
shell tools cannot stand in for a server that is not there — rung 2 when `ops_bash`
is among them, and rung 3 when this plugin has a pwsh of its own on this platform.
`hostShellEnforcement({shellPolicy, levels})` then asks the same object whether
`deny-host-shell` may hide the host shell tools, and it is asked again as each agent
appears. Both answers therefore follow "what the model can reach"; `resolveShells()`
supplies the detail and the report and never the decision. The `tools/pre-execute`
fence is installed by the mode alone, so the guarantee does not depend on either
answer.

### Rung 3 is a bundle patch; rung 2 is a tool

The two bundled rungs are implemented differently because the host leaves two
different seams open, and both were read from the host source rather than assumed:

- **Rung 2 must be a tool.** `bash-local` has no executable field — its config is
  `cwd`/`timeoutMs`/`maxTimeoutMs`/`maxOutputBytes`/`maxSpillBytes`/`graceMs`
  (`packages/shell/bash-local/src/index.ts`) — so the only zero-internal-dependency
  way to run the plugin's own bash is to publish `ops_bash` and execute through
  `ctx.subprocess`. The rung is therefore the published tool, not the resolved
  executable: a bash that resolved without that service is a rung the model cannot
  reach, so `lib/shells.js` publishes nothing, names the resolved bash in its report,
  and the ladder has no rung 2.
- **Rung 3 must be a patch.** `pwsh-sandbox` inherits `pwshPath` verbatim from
  `pwsh-local` (`packages/shell/pwsh-sandbox/src/index.ts:40`, `type Config =
  LocalConfig`), so pointing that row at the plugin's executable puts the bundled
  pwsh 7 under the host's sandbox, credential scrub, and output governance with no
  custom executor and no patched internals. A bundle patch is evaluated before any
  `dsh-ops` row is mounted, which is also why there is no config key for it: a key
  could never reach the expression, and a key that pretended to would make the
  ladder claim a rung the host row never runs. A patch replaces the target row's
  entire `config`, so every non-default field must be restated — the target row
  declares none (`packages/bundle/base/cordis.patch.yml:241-243`), and the shells
  suite asserts that the shipped patch writes `pwshPath` and nothing else.
  **The expression and the probe are single-sourced by an order, not by an import**
  (a bundle patch is plain YAML and cannot import `lib/shells.js`): both accept
  `PWSH_LAYOUT_ORDER` — the provisioned copy under
  `<DSH_HOME>/dsh-ops/shells/pwsh/<version>/` first, then an installed
  `@dsh-ops/pwsh-<platform>-<arch>` package's `bin/pwsh.exe`, then
  `vendor/pwsh/<platform>-<arch>/pwsh.exe` inside this package — apply the same
  `lstat`-based usability test, and the shells suite asserts that agreement on every
  layout, so the ladder's rung 3 and the host row are one fact rather than two
  guesses.

### No Schemastery `Config`

The plugin exports no `Config` schema, so the row's config is validated by
`lib/config.js` instead. A `Config` export means importing
`@deepseek-ai/schemastery` — a value import whose resolution the profile loader
owns — and this host half deliberately imports no `@deepseek-ai/*` value at load
time. There is no exception now: every host service this plugin needs arrives as
a service, never as an import.

### Resolution and probing are synchronous

`apply` resolves the executable and probes it with `--version` before returning.
Both are synchronous, so they belong in `apply` rather than behind a service
injection: `required: true` must reject *activation*, which is only observable if
the failure happens while the loader is still loading the plugin.

### Prompt section orders 1500 and 3250

The harness allocates named section orders centrally, and an external
contribution supplies its own numbers. Reading the table
(`packages/core/system-prompt/src/index.ts:125-159`):

- **1500 is already claimed** — it is `TOOL_GREP`. The host-shell rule therefore
  shares an order with a first-party section instead of sitting in a gap. Equal
  orders are broken by name, code-unit order (`:231-238`), so
  `dsh-ops:host-shell-policy` sorts before `tool-grep`; the rule still lands after
  `TOOL_BASH` (1000) and before `MCP_SERVERS` (3100), which is the position the
  policy text is written for. `lib/policy.js` states the same allocation in place,
  and `scripts/validate-manifest.mjs` compares both numbers against the manifest.
- **3250 sits in a real gap** — between `MCP_SERVERS` (3100) and `TOOLS_SDK`
  (5000), which is where the tooling section is meant to sit.

### `ctx.get('tools')`, never `ctx.tools`, from the prompt scope

The tooling section's text function asks the registry whether the FastCtx tools
exist, and `lib/shells.js` asks it where to register `ops_bash`. Both run from
injection scopes that do not declare `tools`; the `ctx.tools` property proxy is
topology-sensitive and answered `undefined` there. The mount suite caught this — the
section rendered empty next to nine registered tools.

## Verification record

On Windows x64 with Node 24.18.0, at the commit that carries this record. The
totals are the output of that run; what has to keep holding is what the suites
assert, not the count:

```console
node scripts/validate-manifest.mjs   # all 47 checks passed
node test/run.mjs                    # 7 suites, 122 checks, passed in 9s
node bin/dsh-ops.mjs status          # fastctx 0.2.6 from the managed runtime, 9 tools
```

The vendored source build:

```console
cargo 1.97.1 (c980f4866 2026-06-30)
cargo build --release --locked       # Finished `release` profile in 7m 05s
vendor/fastctx/target/release/fastctx.exe --version   # fastctx 0.2.6
```
