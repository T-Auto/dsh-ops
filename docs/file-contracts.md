# File read and mutation contracts

中文：[文件读写契约](文件读写契约.md).

These are the current contracts, including deliberate differences between tools. Native output is a bounded display; PTC uses the canonical `Outcome.data` below. Do not parse numbered Native display lines back into file bytes. A revision is the lowercase SHA-256 of the complete observed bytes, including BOM and line endings.

| Operation | Preconditions | Canonical facts and receipts |
| --- | --- | --- |
| `inspect_local_file` | Existing readable file; bounded line/byte view | Top-level `revision`, `bytes`, `lineCount`; `items` contains physical lines. `complete`, `nextOffset` and `truncatedInLine` describe the returned range. |
| `read_files` | 1–32 explicit ranges; one aggregate output budget | Each file item has its own revision, coverage and lines or error. Check every item, not just the outer status. |
| `write_file` | Required `expectedRevision`: observed SHA-256 for overwrite, literal string `"absent"` for creation; parent exists | A completed receipt's `revision` is the after-image. Omission, `null` and empty text are invalid revision inputs. `"absent"` never overwrites an existing file. |
| `edit_file` | Existing UTF-8 file, observed `expectedRevision`, 1–100 nonempty `oldText` replacements with required uniqueness | Receipt `revisionBefore` is the observed before-image and `revision` is the after-image. A stale revision fails with `REVISION_CONFLICT` and no effect. BOM/line endings/EOF bytes not selected by the edit remain unchanged. |
| `replace` | Literal pattern/replacement, bounded scope and match ceiling; optional preview | Each receipt's `revision` is the before-image and `revisionAfter` is the planned after-image. A real execution marks each receipt `completed`, `error` or `pending`. The operation scans and compares its own read before publishing each file; it has no caller-supplied expected revision. |

`replace` is not bound to an earlier `inspect_local_file` result. Use `edit_file` when a single-file change must depend on that exact read. A `replace` preview is not a reservation: execution rescans. `changed` counts applied literal replacements, not files. A preview has `dryRun: true`; planned hashes alone do not establish that writes happened.

## One PTC call: read, derive, edit

Load the required bindings before the execution turn, using [SDK loading](ptc-sdk-loading.md). A successful `ops_load_sdk` receipt with `nextTurn: true` does not make a missing binding callable in that same `run_code`. `OpsSdk` is the complete type catalogue, not a promise that every binding is currently loaded.

```ts
const read = await tools.ops_inspect_local_file({ path: "settings.txt" });
if (read.status !== "completed") return read;
const row = read.data.items?.find(item => item.line === 2);
if (!read.data.revision || !row?.text || row.truncatedInLine) {
  return { action: "Read the complete intended edit range before choosing text." };
}
return await tools.ops_edit_file({
  path: "settings.txt",
  expectedRevision: read.data.revision,
  edits: [{ oldText: row.text, newText: row.text.replace("setting=old", "setting=new") }]
});
```

This passes the exact observed text and revision into CAS. It does not infer missing lines, concatenate numbered display text or normalize line endings. The caller must still choose a unique intended `oldText`; repeated lines are rejected when ambiguous. `partial` retains data and read-only continuation guidance; it is not permission to treat missing or truncated bytes as empty. A complete range can be narrower than the file: decide whether the visible range is enough for the intended edit.

Creation is explicit:

```ts
return await tools.ops_write_file({
  path: "new.txt", content: "hello\n", expectedRevision: "absent"
});
```

The literal is a string, not an instruction to omit the field. An external write between read and edit produces a conflict; read the changed file and reconsider the edit. Do not replace the expected revision blindly and retry the original edit.

## Partial mutation and errors

Multi-file replacement is a sequence of atomic per-file publications, not a transaction across files. If file A succeeds and B fails, `Outcome.data` retains the completed A receipt, B's error and any pending files. `failed` and `pending` count those files; `changed` counts replacements confirmed before the failure. A completed receipt's after-hash describes the published bytes. An error or pending receipt's after-hash remains a plan, not evidence of publication.

Inspect `error.effectState` before deciding what happened: `none` means no effect, `applied` means earlier changes occurred, and `unknown` requires read-only verification even when earlier receipts are known. Such errors never carry an automatic mutation continuation. Check retained receipts and current filesystem state; do not replay the whole replacement blindly. Error codes do not override effect uncertainty. Metadata warnings describe limitations separately from publication success.

The generated declarations preserve these distinct receipt shapes and require status narrowing; they are generated from the capability catalogue. Bounds, SHA-256 validity and empty-string rejection remain runtime checks. Regression coverage includes real `run_code` read/edit, external-write CAS conflict, mixed/partial reads, Windows later-file replacement refusal, Native receipt rendering, and positive/negative SDK compilation. No convenience mutation helper or implicit retry changes these semantics.
