# Prompt injection integration

This package export provides two scoped, disposable integration seams.

## System sections

`registerSystemSection(owner, agent, options)` registers one section through the host `systemPrompt` service in the target agent scope. `id` and `revision` are producer metadata; `priority` controls deterministic ordering. Section names are internally namespaced, so unrelated host sections are not shadowed. Text is literal (`{{...}}` is not interpolated). The disposer is idempotent and removes the section on owner or agent disposal.

A host `complete` section still has precedence. This API does not bypass complete-prompt opt-out.

## Example

```ts
import { registerSystemSection, registerStepTailProvider } from 'dsh-ops/prompt-injection'

// Call inside a plugin with the target Agent already available.
const removeSection = registerSystemSection(ctx, agent, {
  id: 'example:guidance', revision: '1', priority: 3200,
  text: 'Use {{literal braces}} exactly as written.',
})
const removeTail = registerStepTailProvider(ctx, agent, {
  id: 'example:state', revision: '1', priority: 10,
  provide: ({ signal, step }) => signal.aborted ? undefined : `Current step: ${step}`,
})
// Removes future contributions; a tail snapshot already handed to host may still be logged.
removeTail()
removeSection()
```

Both functions return an idempotent `() => void`. An id must be unique per target agent and contribution kind, including across owner plugins; duplicates throw. Dispose the previous registration before replacing its revision. Priority defaults to zero; finite priorities sort ascending, ties by code-unit id order. Id and revision must be nonempty. Revisions are immutable registration metadata, not automatic cache invalidations. Disposal withdraws a tail only before the batch is handed back to host pre-step. After that boundary, the completed snapshot may still be admitted and logged even if the provider is removed before commit. A replacement participates only in a subsequent accepted nonempty batch.

Section text can also be a synchronous `(context: AssembleContext) => string`. It receives only the current assembly signal, which must not control later turns. Tail `provide` returns `string | undefined` or a promise thereof; `''` and `undefined` create no message. It receives deeply frozen detached messages, not a writable view of the inbox. Its signal ends on admission cancellation or provider removal; providers should cooperate with cancellation. Errors become `PromptProviderError` with contribution id, revision and cause, observable via normal `agent/error`. No hidden retry is performed.

Section registration requires an available `systemPrompt` service. These functions do not mount a component, register tools, change permissions, or install a process-global provider. A complete system prompt suppresses additive system sections, not independently registered logged batch tails. Other plugins' cooperative pre-step hooks may transform the batch too: this is the tail of the accepted batch at this hook, not a promise about provider wire normalization or every downstream hook.

Verified with the installed `0.2.0-rc.2` host's real AgentLoop and fake LLM capture. The `0.2.1-rc.2` reference source uses the same public pre-step admission contract; that version was read, not installed or executed by this slice.

## Accepted step tails

`registerStepTailProvider(owner, agent, options)` wraps the host `agent/pre-step` waterfall: after its downstream `next()` returns `enter`, providers run only if that decision contains a nonempty accepted user-message batch. Providers receive a frozen read-only snapshot plus agent, turn, step, and the admission signal. Results are ordered by priority and id and become plugin-attributed `UserMessage` values appended to the admitted batch.

This is logged session history, not an ephemeral request overlay, system-role tail, fake user authorization, or a hook guaranteed to run on every model request. Empty batches—including tool-only continuation and turn-closing probes—do not invoke providers and cannot be used to wake a loop. Empty provider results create no message. A provider rejection aborts admission through the host's normal error path; admission-signal cancellation before commit prevents commit. Provider disposal is narrower: it cancels pending evaluation without waiting for non-cooperative promises and filters completed contributions at the final active check, immediately before this hook returns its batch to host pre-step. There is no asynchronous gap between this check and return. This is the snapshot handoff (linearization) boundary, not a revocation guarantee until commit. The installed host then runs `agent/request` and `prepareCall()` before appending the accepted batch to the session log; disposal during those phases does not retract the handed-off snapshot or erase earlier history. Retries reuse the same admitted messages and do not duplicate tails.

The source kind is `dsh-ops:step-tail`, with contributor, revision, turn, and step metadata for attribution and replay.

## Conditional job-wait guidance

A shell-enabled consumer with `promptPolicy: true` observes successful standalone
`sleep` or `Start-Sleep` calls lasting at least 20 seconds. If `job_output` is
available to that agent, it registers one system section through
`registerSystemSection`. The text recommends `job_output({ wait: true })` **when
waiting for an existing host job**; it explicitly allows external-service delays
and does not infer that a job is running from tool availability.

The hint becomes visible at the next prompt assembly. It cannot guide later tool
calls already running inside the same PTC program. Native and PTC calls use the
same post-execution observation. No sleep is denied, repeated or rewritten; tool
results and logged messages remain unchanged. Loops, compound commands, dynamic
durations, short delays, failed/cancelled calls and background/promoted results
do not trigger it.

Before the first qualifying call, added prompt bytes are zero. One section stays
registered for that agent and consumer lifetime; subsequent sleeps add no copies.
Its text is empty while consumer ownership is revoked or `job_output` is absent.
Owner/agent disposal removes it. `promptPolicy: false` installs no observer or
section. This does not use batch tails, invent user messages, or promise a model
will stop using sleeps. Reloading the consumer starts a new observation lifetime.
