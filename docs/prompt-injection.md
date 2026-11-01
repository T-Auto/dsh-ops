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
// Optional early withdrawal; plugin/Agent teardown also releases both.
removeTail()
removeSection()
```

Both functions return an idempotent `() => void`. An id must be unique per target agent and contribution kind, including across owner plugins; duplicates throw. Dispose the previous registration before replacing its revision. Priority defaults to zero; finite priorities sort ascending, ties by code-unit id order. Id and revision must be nonempty. Revisions are immutable registration metadata, not automatic cache invalidations. A disposed in-flight tail is withdrawn, and a replacement participates starting with the next accepted batch.

Section text can also be a synchronous `(context: AssembleContext) => string`. It receives only the current assembly signal, which must not control later turns. Tail `provide` returns `string | undefined` or a promise thereof; `''` and `undefined` create no message. It receives deeply frozen detached messages, not a writable view of the inbox. Its signal ends on admission cancellation or provider removal; providers should cooperate with cancellation. Errors become `PromptProviderError` with contribution id, revision and cause, observable via normal `agent/error`. No hidden retry is performed.

Section registration requires an available `systemPrompt` service. These functions do not mount a component, register tools, change permissions, or install a process-global provider. A complete system prompt suppresses additive system sections, not independently registered logged batch tails. Other plugins' cooperative pre-step hooks may transform the batch too: this is the tail of the accepted batch at this hook, not a promise about provider wire normalization or every downstream hook.

Verified with the installed `0.2.0-rc.2` host's real AgentLoop and fake LLM capture. The `0.2.1-rc.2` reference source uses the same public pre-step admission contract; that version was read, not installed or executed by this slice.

## Accepted step tails

`registerStepTailProvider(owner, agent, options)` runs providers after the host `agent/pre-step` waterfall has returned `enter`, only when that decision contains a non-empty accepted user-message batch. Providers receive a frozen read-only snapshot plus agent, turn, step, and the admission signal. Results are ordered by priority and id and become plugin-attributed `UserMessage` values appended to the admitted batch.

This is logged session history, not an ephemeral request overlay, system-role tail, fake user authorization, or a hook guaranteed to run on every model request. Empty batches—including tool-only continuation and turn-closing probes—do not invoke providers and cannot be used to wake a loop. Empty provider results create no message. A provider rejection aborts admission through the host's normal error path; cancellation prevents commit. Retries reuse the same admitted messages and do not duplicate tails.

The source kind is `dsh-ops:step-tail`, with contributor, revision, turn, and step metadata for attribution and replay.
