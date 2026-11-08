import fs from 'node:fs'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { createAssistantMessage, createToolResultMessage, createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import { assert, test, report } from './lib/harness.mjs'
import { NativeFileTools } from '../lib/projections/native/runtime.js'
import { acquireResultAdmission } from '../lib/publication/result-admission.js'
import { WORKER } from './lib/boundary.mjs'
import { requireWorker } from './lib/boundary.mjs'
import { fixture, READ, text, full, elided } from './lib/context-read.mjs'
requireWorker('context-read-dedup')

await test('only exact prior Native body in a completed ordinary provider request permits a compact repeat', () => fixture(async ({ agent, adapter, request, read, policyReads }) => {
  const first = await read()
  full(first)
  full(await read())
  const before = agent.session.surface.contentGeneration
  const chunks = await request()
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.deepEqual(adapter.requests[0].messages, agent.session.deriveMessages(), 'real adapter receives the same body and identities')
  const beforeAuthority = policyReads.count
  const repeat = await read()
  assert.ok(policyReads.count > beforeAuthority, 'repeat traverses current host authority again')
  elided(repeat)
  assert.deepEqual(repeat.value, first.value, 'canonical value remains complete')
  assert.equal(agent.session.surface.contentGeneration, before, 'append-only history is not a rewrite')
  assert.ok(text(repeat).includes(first.message.id))
  assert.ok(Buffer.byteLength(text(repeat)) < Buffer.byteLength(text(first)))
  // No IO cache: each call still executes the read and returns its full canonical rows.
  assert.equal(repeat.value.data.items.length, 30)
}))

await test('retained transcript alone, uncommitted results and untrusted user body text are not proof', () => fixture(async ({ request, read }) => {
  const first = await read({ commit: false })
  await request([first.assistant, first.message])
  full(await read())
  const second = await read()
  await request([createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: text(second) }] })])
  full(await read())
}))

await test('changed body, source call, message identity and assistant arguments fail closed', () => fixture(async ({ request, read }) => {
  const first = await read()
  const alternatives = [
    [first.assistant, { ...first.message, content: [{ type: 'text', text: 'redacted' }] }],
    [first.assistant, createToolResultMessage({ callId: first.message.toolCallId, content: first.content, isError: false })],
    [first.assistant, { ...first.message, source: { kind: 'tool', callId: 'wrong' } }],
    [createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'tool-call', id: first.message.toolCallId, name: READ, arguments: '{"path":"wrong"}' }] }), first.message],
    [first.message],
  ]
  for (const messages of alternatives) { await request(messages); full(await read()) }
}))

await test('latest ordinary request must still include the body; auxiliary calls cannot supply proof', () => fixture(async ({ request, read }) => {
  const first = await read()
  await request(undefined, { purpose: 'compaction' })
  full(await read())
  await request([first.assistant, first.message])
  await request([], { purpose: 'session-title' })
  elided(await read())
  await request([])
  full(await read())
}))

await test('real session surface compaction invalidates evidence even if an old request is replayed', () => fixture(async ({ request, read, compact }) => {
  const first = await read()
  await request()
  compact()
  await request([first.assistant, first.message])
  full(await read())
}))

await test('file revision, same-size mtime change, identity replacement and requested range invalidate', () => fixture(async ({ file, request, read }) => {
  const first = await read()
  await request([first.assistant, first.message])
  const stat = fs.statSync(file)
  fs.utimesSync(file, stat.atime, new Date(stat.mtimeMs + 2000))
  full(await read())
  await request([first.assistant, first.message])
  const bytes = fs.readFileSync(file)
  fs.renameSync(file, file + '.old')
  fs.writeFileSync(file, bytes)
  fs.utimesSync(file, stat.atime, stat.mtime)
  full(await read())
  await request([first.assistant, first.message])
  const range = await read({ args: { path: file, offset: 2, limit: 5 } })
  assert.match(text(range), /^2 \| payload/m)
  fs.writeFileSync(file, bytes.toString().replace('payload line 1', 'changed line 1'))
  const changed = await read()
  assert.match(text(changed), /^1 \| changed/m)
  assert.notEqual(changed.value.data.revision, first.value.data.revision)
}))

await test('paged reads keep completeness and continuation notices when identical body is omitted', () => fixture(async ({ file, request, read }) => {
  const args = { path: file, limit: 10 }
  const first = await read({ args })
  await request()
  const repeat = await read({ args })
  elided(repeat)
  assert.match(text(repeat), /10 items revalidated; complete=false.*nextOffset=11.*omitted=20/)
  assert.deepEqual(repeat.value, first.value)
}))

await test('nested transport dispatch uses a real registry parent token and keeps full PTC data', () => fixture(async ({ ctx, agent, file, request, read, call }) => {
  const first = await read()
  await request()
  let nested
  await ctx.plugin({ inject: ['tools'], apply: inner => inner.tools.register({
    name: 'fixture_transport', description: 'Nested canonical dispatch fixture', parameters: { type: 'object', properties: {} },
    output: { schema: ctx.get('tools').get(READ, agent).output.schema, render: () => [] },
    execute: async (_args, exec) => {
      const pipeline = new ToolExecutionPipeline(ctx)
      const prepared = await pipeline.prepare({ agent, callId: 'nested-read', rootCallId: exec.rootCallId, parent: exec.token,
        toolSet: exec.toolSet, name: READ, arguments: { path: file }, signal: exec.signal })
      const outcome = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared
      nested = await pipeline.complete(prepared.exec, outcome)
      return nested.value
    },
  }) })
  const outer = await call({ agent, callId: 'transport', name: 'fixture_transport', arguments: {}, signal: new AbortController().signal })
  full(nested)
  assert.deepEqual(nested.value, first.value)
  assert.deepEqual(outer.value, first.value)
  await request([first.assistant, first.message])
  full(await read()) // Unknown outer tools conservatively discard evidence.
}))

await test('post-execute policy content and failures remain authoritative', () => fixture(async ({ ctx, agent, request, read, call }) => {
  await read()
  await request()
  const stop = ctx.on('tools/post-execute', async () => ({ kind: 'accept', content: [{ type: 'text', text: 'policy redacted' }] }))
  assert.equal(text(await read()), 'policy redacted')
  stop()
  const deny = ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'permission withdrawn' }))
  const denied = await call({ agent, callId: 'denied', name: READ, arguments: {}, signal: new AbortController().signal })
  assert.equal(denied.isError, true)
  assert.doesNotMatch(text(denied), /Unchanged file range/)
  deny()
}))

await test('missing content generation, separate owners and agent disposal cannot borrow proof', () => fixture(async ({ ctx, agent, mint, request, read }) => {
  await read()
  await request()
  full(await read({ owner: mint('other-session') }))
  full(await read({ owner: { id: 'old-host', session: { id: 'old-host', header: agent.session.header } } }))
  await ctx.serial('agent/disposed', { agent })
  assert.equal(ctx.get('tools').get(READ, agent), undefined)
  full(await read({ owner: { id: agent.id, session: agent.session } }))
}))

await test('failed or superseded ordinary requests cannot restore stale provider evidence', () => fixture(async ({ adapter, request, read }) => {
  const first = await read()
  await request()
  adapter.next = async function* () { throw new Error('provider failed') }
  const failed = await request()
  assert.equal(failed.at(-1).reason.kind, 'error')
  full(await read())
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  const hold = new Promise(resolve => { release = resolve })
  adapter.next = async function* () { entered(); await hold; yield { type: 'finish', reason: { kind: 'stop' } } }
  const stale = request([first.assistant, first.message])
  await started
  await request([])
  release()
  await stale
  full(await read())
}))

await test('component disposal removes hooks and stale definitions cannot elide', () => fixture(async ({ ctx, agent, fiber, request, read }) => {
  await read()
  await request()
  const old = ctx.get('tools').get(READ, agent)
  const last = await read()
  elided(last)
  await fiber.dispose()
  assert.equal(old.finalizeContent({ agent, callId: 'stale', token: Symbol(), arguments: {}, signal: new AbortController().signal }, last), undefined)
}))
await test('message content projection increments generation and invalidates without surface replacement', () => fixture(async ({ ctx, agent, request, read }) => {
  const first = await read()
  await request()
  const generation = agent.session.surface.contentGeneration
  const replacement = agent.session.surface.replaceGeneration
  await ctx.get('sessions').registerMessageProjection({
    type: 'fixture/read-redaction',
    project: () => new Map([[first.event.seq, freezeMessage({ ...first.message, content: [{ type: 'text', text: 'rewritten body' }] })]]),
  })
  agent.session.append('fixture/read-redaction', { target: first.event.seq })
  assert.equal(agent.session.surface.replaceGeneration, replacement)
  assert.ok(agent.session.surface.contentGeneration > generation)
  await request([first.assistant, first.message])
  full(await read())
}))

await test('sandbox-mode events and other tool results discard evidence before another read', () => fixture(async ({ ctx, agent, request, read, call }) => {
  const first = await read()
  await request()
  agent.session.append('sandbox/mode', { mode: 'read-only' })
  full(await read())
  await request([first.assistant, first.message])
  full(await read())
  const fresh = await read()
  await request([fresh.assistant, fresh.message])
  await ctx.plugin({ inject: ['tools'], apply: inner => inner.tools.register({ name: 'fixture_mutation', description: 'Potential mutation',
    parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) }) })
  await call({ agent, callId: 'mutation', name: 'fixture_mutation', arguments: {}, signal: new AbortController().signal })
  full(await read())
}))

await test('bounded record retention expires old bodies rather than inferring that history remains visible', () => fixture(async ({ request, read }) => {
  const first = await read()
  let newest
  for (let i = 0; i < 33; i++) newest = await read()
  await request([first.assistant, first.message])
  full(await read())
  await request([newest.assistant, newest.message])
  elided(await read())
}))

await test('ordinary requests without session identity clear proof and incomplete streams cannot restore it', () => fixture(async ({ adapter, request, read }) => {
  const first = await read()
  await request()
  await request([], { sessionId: undefined })
  full(await read())
  adapter.next = async function* () { yield { type: 'finish', reason: { kind: 'max-tokens' } } }
  await request([first.assistant, first.message])
  full(await read())
}))

await test('short, hex, clipped and denied reads preserve the full authoritative result', () => fixture(async ({ ctx, agent, file, request, read, call }) => {
  fs.writeFileSync(file, 'payload')
  const short = await read()
  await request()
  assert.equal(text(await read()), text(short), 'a longer reference is never substituted')
  const args = { path: file, view: 'hex' }
  const hex = await read({ args })
  await request()
  assert.equal(text(await read({ args })), text(hex))
  fs.writeFileSync(file, 'payload' + 'x'.repeat(100_000))
  const clipped = await read()
  assert.ok(clipped.value.data.items.some(item => item.truncatedInLine) || text(clipped).includes('TruncatedBy: output-budget'))
  await request()
  const clippedRepeat = await read()
  assert.equal(text(clippedRepeat), text({ content: ctx.get('tools').get(READ, agent).output.render({ path: file }, clippedRepeat.value) }),
    'a fresh stored reference must keep its own full authoritative rendering')
  assert.doesNotMatch(text(clippedRepeat), /Unchanged file range/)
  fs.unlinkSync(file)
  const absent = await call({ agent, callId: 'absent', name: READ, arguments: { path: file }, signal: new AbortController().signal })
  assert.ok(absent.isError || absent.value.status !== 'completed')
  assert.equal(absent.value.data?.error?.code, absent.value.error?.code, 'Outcome retains the raw failure receipt')
  assert.doesNotMatch(text(absent), /Unchanged file range/)
}))

await test('root observers remain runtime-owned and separate source lifetimes cannot dispose or transfer proof', () => fixture(async ({ ctx, agent, mint, read, request }) => {
  const first = await read(); full(first)
  await request(); elided(await read())
  const unrelated = new NativeFileTools({ ctx, config: { workerPath: WORKER, required: true } })
  await unrelated.start([])
  try {
    const sibling = mint('independent-read-source')
    full(await read({ owner: sibling }))
    await request()
    full(await read({ owner: sibling }))
  } finally { await unrelated.stop() }
  await request()
  elided(await read())
  assert.equal(first.value.data.items.length, 30)
}))

// A host that guards the compose root refuses `root.events.*` from a plugin
// activation (dsh-tui 0.19.0). Subscriptions must therefore be owned by the ctx
// that constructs the runtime, never by `ctx.root`.
const guardedRoot = () => {
  const deny = method => () => { throw new Error(`root.events.${method} is unavailable from a plugin activation`) }
  const events = { on: deny('on'), once: deny('once'), register: deny('register'), unregister: deny('unregister') }
  return { events, on: (...args) => events.on(...args), once: (...args) => events.once(...args), effect: (...args) => events.register(...args) }
}
const subscriptionRecorder = () => {
  const subscribed = [], disposed = []
  return { subscribed, disposed, ctx: { on(name) { subscribed.push(name); return () => disposed.push(name) } } }
}
const ADMISSION_EVENTS = ['system-prompt/change', 'tools/execute']
const RUNTIME_EVENTS = ['agent/disposed', 'llm/stream', 'session/disposed', 'session/event', 'tools/result']
const sorted = names => [...names].sort()

await test('a guarded compose root cannot receive subscriptions; the constructing ctx owns them', async () => {
  const subscribed = []
  const ctx = { root: guardedRoot(), get: () => undefined, on(name) { subscribed.push(name); return () => {} } }
  const runtime = new NativeFileTools({ ctx, config: { workerPath: WORKER, required: true } })
  const admission = acquireResultAdmission(ctx)
  try {
    assert.deepEqual(await runtime.start([]), [])
  } finally {
    await runtime.stop()
    admission.dispose()
  }
  assert.deepEqual(sorted(subscribed), sorted([...RUNTIME_EVENTS, ...ADMISSION_EVENTS]),
    'every subscription lands on the constructing ctx; a root receiver would have thrown')
})

await test('an explicit events ctx carries the subscriptions and the admission ledger', async () => {
  const identity = subscriptionRecorder()
  const eventsA = subscriptionRecorder()
  const eventsB = subscriptionRecorder()
  const first = acquireResultAdmission(identity.ctx, eventsA.ctx)
  const second = acquireResultAdmission(identity.ctx, eventsB.ctx)
  try {
    assert.deepEqual(identity.subscribed, [], 'the authorization ctx never receives an event listener')
    assert.deepEqual(sorted(eventsA.subscribed), sorted(ADMISSION_EVENTS))
    assert.deepEqual(sorted(eventsB.subscribed), sorted(ADMISSION_EVENTS),
      'the ledger is keyed by the subscription ctx, not shared through the authorization ctx')
    first.dispose()
    assert.deepEqual(sorted(eventsA.disposed), sorted(ADMISSION_EVENTS), 'disposal releases by the same key')
    assert.deepEqual(eventsB.disposed, [], 'another subscription ctx keeps its listeners and ledger')
  } finally {
    second.dispose()
  }
  assert.deepEqual(sorted(eventsB.disposed), sorted(ADMISSION_EVENTS))
})

await test('an explicit events ctx receives the runtime subscriptions instead of the read ctx', async () => {
  const read = subscriptionRecorder()
  const events = subscriptionRecorder()
  const runtime = new NativeFileTools({ ctx: read.ctx, events: events.ctx, config: { workerPath: WORKER, required: true } })
  try {
    assert.deepEqual(await runtime.start([]), [])
  } finally {
    await runtime.stop()
  }
  assert.deepEqual(read.subscribed, [], 'the read ctx does not become the event receiver')
  assert.deepEqual(sorted(events.subscribed), sorted([...RUNTIME_EVENTS, ...ADMISSION_EVENTS]))
  assert.deepEqual(sorted(events.disposed), sorted([...RUNTIME_EVENTS, ...ADMISSION_EVENTS]), 'disposal releases every runtime listener')
})

report('context-read-dedup')
