# Internal architecture

English | [中文](内部架构.md)

OPS is an opt-in capability layer. Built-in presets are default consumer plans, not separate
implementations of the tools. External presets use the same assembly pipeline.

## Responsibility map

| Directory | Responsibility |
| --- | --- |
| `integration/` | Stable `dsh-ops/integration` export and scoped diagnostics |
| `consumer/` | Preset identity, explicit bindings, validated options, consumer plan and shared assembly |
| `presets/` | Built-in product defaults and compatibility configuration; never generic publication policy |
| `capabilities/` | Tool contracts, mutation metadata, argument normalization and resident profiles |
| `discovery/` | Provider metadata, ranked candidates, next-step selection and dynamic publication |
| `publication/` | Scoped ownership, reconciliation, Native/PTC publication, presentation and replacement masks |
| `execution/` | Worker resolution, bounded transport, fixed-file authority bridge and confined batch/result bridge |
| `projections/native/` | Compact model-facing text and read evidence |
| `projections/ptc/` | Typed Outcome, schema and progressive SDK projection |
| `lifecycle/` | Cooperative invocation cancellation, deadlines and draining |
| `kernel/` | Shared outcome vocabulary, admission budgets and session result storage/lifetime |
| `adapter/dsh/` | Host types, lazy host loaders and browser primitives |
| `settings/`, `client/` | Single-row validation, profile persistence and native-control UI |
| `shells/` | Shell resolution, admission, host execution and jobs |
| `panel/`, `tui/` | Opt-in capture and read-only UI integrations |
| `legacy/` | Retained pre-single-row component entry behavior |

`src/index.ts` is the single-row composition root. `consumer/mount.ts` is the only current
assembler for built-in and explicit preset consumers. `presets/builtin.ts` translates the
built-in defaults and saved switches into that plan; `integration/index.ts` translates public
options into the same plan. A configured preset id does not change host presentation or authority.

## Execution is shared; projection is not

Native file tools and typed PTC file APIs call `execution/files.ts`, then the same Rust kernel.
Batch/result operations call `execution/jobs.ts`; both bridges use `execution/transport.ts`.
The fixed-file bridge retains its trusted data-operation policy; the batch bridge retains host
process confinement. Sharing transport must not erase that security distinction.

Native text and PTC typed data deliberately remain separate. A Native text renderer is not a
PTC SDK contract. Third-party providers currently support Native only; registering external typed
PTC SDKs is explicitly unsupported rather than guessed from a preset name.

## Lifetime and publication

`lifecycle/invocations.ts` links each call to its consumer and caller signal. External calls are
also linked to their provider instance. Consumer unload, Agent disposal, preset/presentation or
authority withdrawal cancels owned calls. Trusted worker calls drain during teardown. Foreign
provider publication retires without waiting indefinitely for arbitrary provider promises; a warning
reports any unfinished call whose effects may still be unknown. AbortSignal is not forced isolation:
providers remain responsible for execution and authorization and must honor cancellation.

Selection is pending until the next model step. It does not execute a tool or mutate the current
model request snapshot. Provider reload creates a new token and does not inherit a previous
instance's selection. Built-in and external metadata compete in one ranked candidate pool before
the result limit is applied.

## Compatibility and boundaries

Published component paths remain available where they have documented legacy semantics. Older
internal `file/`, `modes/` and root helper paths are compatibility reexports. `ptc/` retains
configuration and execution-contract seams; projection and publication implementations live in
the responsibility-based modules above. These private seams are not new public APIs. New consumers must import `dsh-ops/integration`, never private `lib/*` paths.

The obsolete `dsh-ops/compat` export was dangling after the single-row change and is removed.
Use `hideOfficialTools: false` in a built-in section or `replaceOfficial: false` in an explicit
consumer. Shell hiding is independently controlled by `hidePwsh`.

The host inherits ancestor registrations and restriction masks. Mount unrelated preset
compositions as siblings, not below an opted-in preset. OPS rejects inherited callbacks for the
wrong consumer, but does not promise schema isolation across that unsupported nesting boundary.

## Validation

- `test/consumer-assembly.test.mjs`: explicit overrides, custom profiles, external cancellation,
  late authority services, candidate scoring and invocation ownership.
- `test/settings-ui.test.mjs`: real host persistence, revision conflicts, native Switch cards and
  exact nested paths for custom preset ids (including dots).
- `test/publication-boundary.test.mjs`: generic layers do not import built-in preset policy;
  discovery controller does not import consumer/integration products.
- Existing authority, permissions, PTC projection, next-step, scope-family, result-lifetime,
  release closure and package-source suites remain regression gates.
