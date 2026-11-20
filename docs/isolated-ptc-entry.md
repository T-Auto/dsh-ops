# Isolated OPS-PTC test entry (#990)

## Why this entry exists

A headless comparison can only speak about OPS-PTC if the group it measured
actually entered that routing. Before this entry, the loop fixture assembled a
synthetic `fixture` preset, and the byte probes covered the built-in presets —
so a green number could come from a Standard composition and still look like
OPS-PTC evidence. Issue #980 puts it as the V1 gate: if the actual route is
Standard, the worker is missing, or the routing is unknown, the run is invalid
and must say so.

## What a group is

`bootEntryGroup(root, …)` in `test/lib/ptc-entry.mjs` boots one preset group:

- the real AgentLoop and Session with a scripted provider — no network model
  request is ever made;
- the shipped single row (`apply` from the package entry) mounted with only
  the target mode enabled, exactly as a profile mounts it, so the ops-ptc row's
  real defaults are what the group runs;
- a root directory inside the suite's throwaway `DSH_HOME` — `node test/run.mjs`
  creates one home per suite, and the entry refuses any root outside it.

The environment summary is collected at boot and carried on every report:
plugin commit (read from the git directory, no subprocess), plugin version, host
runtime version, platform (for example `linux-x64`), the worker file with its
sha256, the staged runtime receipt beside it and whether the two digests match,
the sandbox mode and workspace root, the resolved row switches including the
batching guidance default, and the actual `agentPreset` with its mode. The
provider is marked `scripted` and `networkModelRequests` is recorded as 0,
because a mocked provider verifies assembly only and a report must never hide
that.

## The report contract

`enterPtc(group)` runs the minimal case first: exactly one scripted provider
request that executes nothing, which is the only request a wrong group ever
earns. Checks run in a fixed order — worker, preset, route, execution — and the
first failure becomes the report's reason.

- **entered** — the request's top-level surface is exactly `['run_code']` and
  the SDK text is present; only then does a second turn invent one fresh probe
  file and execute a single program through the worker. The evidence block
  records the surface, the preset, the mode, the request counts and the
  executed result.
- **invalid** — the report names the reason and carries findings for every
  check, but no evidence block and no byte or token numbers of any kind:
  - Standard is the deliberate counter-example. It is a real composition, not a
    stub, and it fails on `preset` with the route finding showing the native
    surface;
  - a PTC preset on a native executor fails on `route` — the preset is right,
    the transport is not, and the surface may declare no tool at all;
  - a row that cannot resolve an executable worker fails at boot on `worker`,
    before any request is made.

Byte and cost accounting is deliberately not collected here; that is the V2
card's scope (#991). The later cards consume this entry's groups and
environment record instead of rebuilding them.

## Reproduce

```
npm run build
npm run build:ptc
node test/run.mjs progressive-loop
```

The filter must select `progressive-loop.test.mjs`, where the four entry
checks live beside the three loop checks. A skip means the worker did not
resolve — run `npm run build:ptc` first; a skip is not a pass. Only freshly
invented fixture files enter these groups; no real session, credential or
conversation text is read or reported.
