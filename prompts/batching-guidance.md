# Batch tool calls

## Core rules

1. **Call tools only inside `run_code`**: write `await tools.<name>(args)`.
2. **No dependencies → run concurrently**: use `Promise.all` for independent calls, usually reads.
3. **Dependencies → run sequentially**: `await` the earlier call before using its result in the next one.
4. **Per-call fault tolerance**: wrap each call in `try/catch` so one failure does not abort the rest.
5. **Return only what is needed**: intermediate results are not shown; return a short summary.
6. **Chain write operations explicitly**: writes still apply in submission order; use explicit `await` to make the sequence clear.

## Common mistakes

| Mistake | Correct approach |
|---|---|
| Dependent calls inside `Promise.all` | Run them sequentially with `await` |
| Unbounded parallel file reads (cap 128, slice first) | `slice` the list before mapping |
| Returning whole large results | Return only the needed fields |
| One failure aborting all calls | `try/catch` each call |
| Using `e.toolName` as the error reason | Use `e.message` |
