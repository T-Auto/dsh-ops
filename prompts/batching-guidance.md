# Batch tool calls

One run_code call is one round trip. A program that fetches one fact, thinks, then
fetches the next costs the same budget as a program that fetches six and decides once.
The difference is not length: it is whether every operation was decided before the
first one ran.

## Core rules

1. **Call tools only inside run_code**: write `await tools.<name>(args)`.
2. **No dependencies, run concurrently**: use Promise.all for independent calls.
3. **Dependencies, run sequentially**: await the earlier call before using its result.
4. **Per-call fault tolerance**: wrap each call in try/catch so one failure does not
   abort the rest.
5. **Return only what is needed**: intermediate results are never shown; return a short
   summary of the fields the next step needs.
6. **OPS first for file work**: list with ops_glob, search with ops_grep, read with
   ops_read_files or ops_inspect_local_file, edit with ops_edit_file. The shell starts
   processes and reads environment facts; node:fs and node:child_process bypass path
   policy, the sandbox and the audit trail, so they are never a workaround.
7. **Load before you call**: an unloaded ops_* name is loaded, never replaced.

## Step 0 - the plan line

The first line of every program is a plan comment, and it is what makes a wasted step
visible: the line cannot be written without deciding the whole step, and comparing it
with what the program actually issued shows whether the two agree.

```ts
// plan: <operation>; <operation>; <operation>
```

One entry per tool call, in the order you intend to run them. Prose is fine, and a
full-width semicolon also separates entries. It has to be the first line of the program:
a plan comment on a later line does not count, and neither does one after a blank line.

## Step 1 - split by dependency

Independent operations go in the same program under Promise.all. An operation that
needs a value you do not have yet is a later program. Splitting by dependency is what
keeps the plan honest: everything in one program must have been decidable in advance.

## Step 2 - reconcile

Fewer operations ran than the plan listed means the plan was wrong or the step was
wasted; decide which before the next step. A one-entry plan is legitimate only when
that result decides what comes next.

## Step 3 - load before you call

Only ops_inspect_local_file is resident. Every other tools.ops_* name must be loaded,
and the load takes effect on the NEXT program, never in the one that requested it:

```ts
// plan: load glob/read_files/stat; read the manifest head with the resident reader
const [load, head] = await Promise.all([
  tools.ops_load_sdk({ tools: ["glob", "read_files", "stat"] }),
  tools.ops_inspect_local_file({ path: "package.json", limit: 30 }),
])
return { loaded: load.data?.tools, headLines: head.data?.items?.length }
```

Calling an unloaded name throws "tools.ops_read_files is not a function". That is not a
reason to fall back to the shell; it is one step spent loading. Loaded names stay
callable for the rest of the session, so pay it once, early.

## Trajectory 1 - reconnaissance: independent probes in one program

```ts
// plan: top-level directory list; source file list; manifest head
const [dirs, src, manifest] = await Promise.all([
  tools.ops_glob({ pattern: ["*/**"], outputMode: "paths", limit: 40 }),
  tools.ops_glob({ pattern: ["src/**/*.ts"], outputMode: "paths", limit: 60 }),
  tools.ops_read_files({ files: [{ path: "package.json", limit: 30 }] }),
])
return {
  dirs: dirs.data?.items?.length ?? 0,
  src: (src.data?.items ?? []).map(item => item.path).slice(0, 20),
  manifestLines: manifest.data?.items?.[0]?.lineCount,
}
```

Three probes, one round trip. Read the three result shapes carefully: a glob answers in
data.items[].path, a file read in data.items[0].items. Mixing them up is the most
common copy error.

## Trajectory 2 - search, then read the hits: one dependency, then a fan-out

```ts
// plan: find the batching sites; read the first five files
const hits = await tools.ops_grep({ pattern: "batchingGuidance", glob: ["**/*.ts"],
  outputMode: "files_with_matches", limit: 50 })
const files = (hits.data?.items ?? []).map(item => item.path).slice(0, 5)
const reads = await Promise.all(files.map(async file => {
  try {
    const read = await tools.ops_read_files({ files: [{ path: file, limit: 20 }] })
    return { file, ok: true, lines: read.data?.items?.[0]?.lineCount }
  } catch (error) { return { file, ok: false, reason: error.message } }
}))
return reads
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
const edit = await tools.ops_edit_file({
  path: "src/policy.ts",
  expectedRevision: stat.data.revision,
  edits: [{ oldText: "export const VERSION = 1", newText: "export const VERSION = 2" }],
})
return { context: context.data?.items?.length, changed: edit.data?.changed }
```

The revision and the context are independent, so they share one program. The write
needs the revision, so it is a second await in the same program, not a second step.

## Trajectory 4 - paging: a loop is still one program

```ts
// plan: read every page of the event log until it reports complete
const rows = []
let offset = 1
for (let page = 0; page < 40; page++) {
  const read = await tools.ops_read_files({ files: [{ path: "events.jsonl", offset, limit: 200 }] })
  const file = read.data?.items?.[0]
  rows.push(...(file?.items ?? []))
  const next = file?.nextOffset ?? 0
  if (file?.complete || !next || next <= offset) break
  offset = next
}
return { lines: rows.length }
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
  tools.ops_glob({ pattern: ["*/**"], outputMode: "paths", limit: 40 }),
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
| One failure aborting the batch | try/catch per item and keep e.message |
| Shell standing in for a file tool | Use the OPS file API for list, search, read and edit |
| ops_read_files before it is loaded | ops_load_sdk in the previous program |
| Using e.toolName as the error reason | Use e.message |
