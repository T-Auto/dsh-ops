# PTC result contracts

中文：[PTC 结果契约](PTC结果契约.md).

In 0.4.0 the PTC component owns its file, batch and result SDK bindings independently
of the Native file row. Every binding returns an `Outcome<T>` value. Native tools
continue to render compact text; PTC receives canonical structured data in `data`.
See [SDK loading](ptc-sdk-loading.md) for availability and next-turn activation.
See [file mutation contracts](file-contracts.md) for exact revision fields, same-call read/edit examples and retained replacement receipts.

| Status | Required fields | Caller action |
| --- | --- | --- |
| `completed` | `data` | Consume the requested operation's result. |
| `partial` | `data`, incomplete `coverage`, `continuation` | Inspect retained data; explicitly retrieve the remaining range or stored page. |
| `rejected`, `conflict`, `error`, `unknown` | `error` and optional retained `data` | Follow `error.code`, `effectState`, `retry` and `nextAction`. |

A successful plan is completed planning, not completed execution. `result.put` is
completed storage even though the receipt does not echo its rows. Failed batch
items retain their data and report an error; an interrupted mutation never receives
an automatic retry cursor. `unknown` means effects require read-only inspection.
Do not access `error` on `partial`, or treat every non-error status as complete.

```ts
// After ops_read_files has been activated for this agent:
const result = await tools.ops_read_files({
  files: [{ path: "src/a.ts", offset: 1, limit: 20 }]
});
if (result.status === "completed") {
  return { lines: result.data.items?.map(file => file.items?.length ?? 0) };
}
if (result.status === "partial") {
  return { coverage: result.coverage, continuation: result.continuation };
}
return { code: result.error.code, effectState: result.error.effectState,
  retry: result.error.retry, action: result.error.nextAction };
```

Continuation values describe bounded read-only retrieval. They preserve the
original query, page limits, selected fields and operation root. A spilled mutation
continues with `result.page`, never with a repeated write. A result page advances
its existing reference; it never wraps the reference in another reference. Zero
progress, an incomplete physical search scan, an oversized descriptor or a range
that cannot safely resume produces `RESULT_PARTIAL` with retained data and explicit
guidance, not a fabricated continuation. All retrieval still checks current authority
and available SDK bindings. No helper automatically executes or retries a tool.

Search scan coverage, captured snapshot completeness and page completeness are
separate facts. Exhausting a stored page does not prove that the original scan was
complete. Read `data.source` and the original search report when consuming snapshots;
see [result budgets](result-budgets.md).

## Generated declarations

`npm run build` generates `lib/ptc/sdk.d.ts` from the same capability catalogue and
Outcome schemas that the host validates and uses for its SDK section. The npm package
ships this file. It is build output and must not be edited by hand. TypeScript
consumers can use the type-only package export:

```ts
import type { OpsSdk, Outcome, StorageReference } from "dsh-ops/ptc-sdk";
```

`OpsSdk` describes the complete supported API, not the bindings currently loaded
in a particular agent. The host's actual SDK section contains only visible,
activated bindings. Required arguments, enums, nested range/edit shapes and
status narrowing remain typed; canonical extension data stays JSON. Bounds in
parameter descriptions are enforced by the worker. This export does not load a
host service or create a second runtime.
