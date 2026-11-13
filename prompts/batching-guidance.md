# Batch tool calls

Group independent calls in one run_code program and keep dependencies explicit.
Return enough status and completion facts for the next decision.

## One session, one scope

A program's top-level `const`, `let`, `class` and `function` can outlive the program: a
state-retaining runtime keeps them, and a second declaration of that name is a compile-time
SyntaxError that discards the whole program before its first line runs, tool calls
included. A program that throws keeps its names too, so re-sending a failed program
verbatim dies on a name rather than on its arguments.

- One name, one program. Never declare `load` twice.
- Give each program its own top-level names; a name this session already used is spent.
- Declare at top level only what a later program reads, and read it without re-declaring.
- A program that died did nothing: change its arguments and its names before retrying.

## Core rules

1. **Call tools only inside run_code**: write `await tools.<name>(args)`.
2. **No dependencies, run concurrently**: use Promise.all for independent calls.
3. **Dependencies, run sequentially**: await the earlier call before using its result.
4. **Per-call fault tolerance**: check each Outcome status and per-file error; failures
   are values. Catch dispatch exceptions separately so one failure does not abort the rest.
5. **Return only what is needed**: intermediate results are never shown; return a short
   summary of the fields the next step needs.
6. **OPS first for file work**: list with ops_glob, search with ops_grep, read with
   ops_read_files or ops_inspect_local_file, edit with ops_edit_file. The shell starts
   processes and reads environment facts; node:fs and node:child_process bypass path
   policy, the sandbox and the audit trail, so they are never a workaround.
7. **Load before you call**: an unloaded ops_* name is loaded, never replaced.

## Step 0 - the plan line

Declare the intended calls on the first line of every program:

```ts
// plan: <operation>; <operation>; <operation>
```

Use one entry per tool call; a full-width semicolon also separates entries. The plan
must be the first line of the program, before code or blank lines.

## Step 1 - split by dependency

Run independent calls under Promise.all. Await dependencies sequentially in the same
program. SDK loading requires a separate program before using the new bindings.

## Step 2 - reconcile

Compare planned and actual calls. A one-entry plan is valid when its result determines
the next operation.

## Step 3 - load before you call

Use names already present in the current SDK. The default resident reader is
ops_inspect_local_file; load absent names only. Loading takes effect on the NEXT program,
never in the one that requested it:

```ts
// plan: load glob/read_files/stat; read the manifest head with the resident reader
const [load, head] = await Promise.all([
  tools.ops_load_sdk({ tools: ["glob", "read_files", "stat"] }),
  tools.ops_inspect_local_file({ path: "package.json", limit: 30 }),
])
return { loaded: load.data?.tools, headLines: head.data?.items?.length }
```

Calling an unloaded name throws "tools.ops_read_files is not a function". That is not a
reason to fall back to the shell; it is one step spent loading. Loaded names remain
selected in this live scope; recheck the current SDK after a mode or component change.
Programs need not share a process or local variables.

## Trajectory 1 - reconnaissance: independent probes in one program

```ts
// plan: top-level directory list; source file list; manifest head
const [dirs, src, manifest] = await Promise.all([
  tools.ops_glob({ pattern: ["*"], kind: "directory", outputMode: "paths", limit: 40 }),
  tools.ops_glob({ pattern: ["src/**/*.ts"], outputMode: "paths", limit: 60 }),
  tools.ops_read_files({ files: [{ path: "package.json", limit: 30 }] }),
])
return {
  status: [dirs.status, src.status, manifest.status],
  dirs: dirs.data?.items ?? [],
  src: (src.data?.items ?? []).slice(0, 20),
  manifestLines: manifest.data?.items?.[0]?.lineCount,
}
```

Three probes, one round trip. Glob paths are `data.items: string[]`; details are
`{path,bytes,modified,kind?}[]`. Grep content is `{path,line,text}[]`,
files_with_matches is `{path}[]`, count is `{path,count}[]`, definitions adds `kind`
to content rows, and summary has empty items with `data.files`/`data.matches` totals.
Read-files contains per-file results in `data.items`, with lines in each file's
`items`. Check status, scan/page completeness and each file's error before claiming success.

## Trajectory 2 - search, then read the hits: one dependency, then a fan-out

```ts
// plan: find the batching sites; read the first five files
const hits = await tools.ops_grep({ pattern: "batchingGuidance", glob: ["**/*.ts"],
  outputMode: "files_with_matches", limit: 50 })
const files = (hits.data?.items ?? []).map(item => item.path).slice(0, 5)
const reads = await Promise.all(files.map(async file => {
  try {
    const read = await tools.ops_read_files({ files: [{ path: file, limit: 20 }] })
    return { file, status: read.status, error: "error" in read ? read.error : undefined,
      lines: read.data?.items?.[0]?.lineCount }
  } catch (error) { return { file, ok: false, reason: error instanceof Error ? error.message : String(error) } }
}))
return {
  search: { status: hits.status, error: "error" in hits ? hits.error : undefined, complete: hits.data?.complete,
    scanComplete: hits.data?.scanComplete, pageComplete: hits.data?.pageComplete,
    matchedObserved: hits.data?.matchedObserved, matchedTotal: hits.data?.matchedTotal,
    nextOffset: hits.data?.nextOffset, continuation: hits.status === "partial" ? hits.continuation : hits.data?.continuation },
  reads,
}
```

The search is the dependency, so it is awaited first. The five reads depend on its
result but not on each other, so they fan out inside the same program instead of
across five steps.

## Trajectory 3 - a verified edit: revision first, patch second

```ts
// plan: read the revision; read the surrounding context; patch against that revision
const [stat, context] = await Promise.all([
  tools.ops_stat({ path: "src/policy.ts" }),
  tools.ops_inspect_local_file({ path: "src/policy.ts", offset: 1, limit: 20 }),
])
if (stat.status !== "completed" || !stat.data.revision)
  return { status: stat.status, error: "error" in stat ? stat.error : undefined }
const edit = await tools.ops_edit_file({
  path: "src/policy.ts",
  expectedRevision: stat.data.revision,
  edits: [{ oldText: "export const VERSION = 1", newText: "export const VERSION = 2" }],
})
return { status: edit.status, error: "error" in edit ? edit.error : undefined,
  context: context.data?.items?.length, changed: edit.data?.changed }
```

The revision and the context are independent, so they share one program. The write
needs the revision, so it is a second await in the same program, not a second step.

## Trajectory 4 - paging: a loop is still one program

```ts
// plan: read every page of the event log until it reports complete
const rows = []
let offset = 1
let complete = false
let error
for (let page = 0; page < 40; page++) {
  const read = await tools.ops_read_files({ files: [{ path: "events.jsonl", offset, limit: 200 }] })
  const file = read.data?.items?.[0]
  if ("error" in read || file?.error) { error = "error" in read ? read.error : file?.error; break }
  rows.push(...(file?.items ?? []))
  const next = file?.nextOffset ?? 0
  if (file?.complete) { complete = true; break }
  if (!next || next <= offset) break
  offset = next
}
return { lines: rows.length, complete, error, nextOffset: complete ? undefined : offset }
```

Advance by nextOffset, never by page count, and stop when the result reports complete.
A loop of dispatches is batched work, not repeated single steps.

## Anti-pattern, and its rewrite

```ts
// plan: list the source files            <- one entry, one dispatch, one round trip
const files = await tools.ops_glob({ pattern: ["src/**/*.ts"], outputMode: "paths" })
return files.data?.items?.length
// ... then a second program for the directories, a third for the manifest
```

```ts
// plan: source files; directories; manifest head       <- same work, one program
const [files, dirs, manifest] = await Promise.all([
  tools.ops_glob({ pattern: ["src/**/*.ts"], outputMode: "paths" }),
  tools.ops_glob({ pattern: ["*"], kind: "directory", outputMode: "paths", limit: 40 }),
  tools.ops_read_files({ files: [{ path: "package.json", limit: 30 }] }),
])
return { files: files.data?.items?.length, dirs: dirs.data?.items?.length,
  manifestLines: manifest.data?.items?.[0]?.lineCount }
```

## Common mistakes

| Mistake | Correct approach |
|---|---|
| No plan line, or one that is not the first line | Open every program with it |
| Dependent calls inside Promise.all | await the dependency first, then fan out |
| More than 128 dispatches in one program | slice(0, 128) before mapping, continue in the next program |
| Returning the whole payload | Return only the fields the next step needs |
| One failure aborting the batch | Check Outcome status; catch dispatch exceptions and keep e.message |
| Shell standing in for a file tool | Use the OPS file API for list, search, read and edit |
| ops_read_files before it is loaded | ops_load_sdk in the previous program |
| The same top-level name in a second program | Give the program its own names; a used name is spent |
| Re-sending a failed program with new arguments | It left its names behind; rename first |
| Using e.toolName as the error reason | Use e.message |
