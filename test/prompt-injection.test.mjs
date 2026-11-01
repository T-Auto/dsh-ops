import { assert, test, report } from './lib/harness.mjs'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { Session } from '@deepseek-ai/dsh-session'
import { registerSystemSection, registerStepTailProvider, PromptProviderError } from '../lib/prompt-injection/index.js'
import { promptHost, tailMessages } from './lib/prompt-injection-host.mjs'
const identity = 'You are an AI agent powered by DeepSeek Harness.\n\n'

await test('sections preserve literal braces, stable id ordering, exact agent scope, complete optout and disposal', async () => {
  const h = await promptHost()
  try {
    const a = await h.agent(), b = await h.agent(a)
    const owner = h.owner()
    const stopB = registerSystemSection(owner, a, { id: 'b', revision: '1', priority: 12, text: '{{literal}}' })
    const stopA = registerSystemSection(owner, a, { id: 'a', revision: '2', priority: 12, text: 'A' })
    assert.throws(() => registerSystemSection(owner, a, { id: 'a', revision: '3', text: 'duplicate' }), /Duplicate/)
    assert.throws(() => registerSystemSection(owner, a, { id: '', revision: '1', text: 'bad' }), /nonempty/)
    assert.throws(() => registerSystemSection(owner, a, { id: 'bad', revision: '1', priority: NaN, text: 'bad' }), /finite/)
    const external = h.ctx.get('systemPrompt').section({ name: 'tool:foreign', order: 10, text: 'Foreign' })
    const prompt = h.ctx.get('systemPrompt')
    assert.equal(renderPrompt(await prompt.assemble({ scope: a })), identity + 'Foreign\n\nA\n\n{{literal}}')
    assert.equal(renderPrompt(await prompt.assemble({ scope: b })), identity + 'Foreign')
    const stopComplete = a.ctx.get('systemPrompt').section({ name: 'complete', order: 1, complete: true, text: 'Only complete' })
    assert.equal(renderPrompt(await prompt.assemble({ scope: a })), 'Only complete')
    stopComplete(); stopA(); stopB(); stopB()
    assert.equal(renderPrompt(await prompt.assemble({ scope: a })), identity + 'Foreign')
    registerSystemSection(owner, a, { id: 'a', revision: '3', text: 'Reload' })
    await owner.fiber.dispose()
    assert.equal(renderPrompt(await prompt.assemble({ scope: a })), identity + 'Foreign')
    external()
    assert.deepEqual(h.errors, [])
  } finally { await h.close() }
})

await test('real loop appends ordered attributed messages after accepted input, retries once without duplication and replays the log', async () => {
  const h = await promptHost()
  try {
    const a = await h.agent(); const owner = h.owner(); let calls = 0
    registerStepTailProvider(owner, a, { id: 'z', revision: 'rev-z', priority: 20, provide: () => 'Last {{literal}}' })
    registerStepTailProvider(owner, a, { id: 'b', revision: 'rev-b', priority: 10, provide: context => {
      ++calls
      assert.equal(context.agent, a); assert.equal(context.turn, 1); assert.equal(context.step, 1)
      assert.equal(context.messages.length, 1)
      assert.throws(() => { context.messages[0].content[0].text = 'tamper' }, TypeError)
      return 'B'
    } })
    registerStepTailProvider(owner, a, { id: 'a', revision: 'rev-a', priority: 10, provide: () => 'A' })
    h.ctx.on('agent/request-error', async (_payload, next) => { await next(); return { kind: 'retry' } })
    const failure = async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UNKNOWN', message: 'Fixture retry' } } } }
    await h.run(a, [failure, undefined])
    assert.deepEqual(h.errors, [])
    assert.equal(calls, 1); assert.equal(h.requests.length, 2)
    const request = h.requests[0]
    assert.equal(Object.isFrozen(request), true)
    assert.equal(request.messages.find(m => m.source?.kind === 'user').content[0].text, 'Real user task.')
    assert.deepEqual(tailMessages(request).map(m => m.source.contributor), ['a', 'b', 'z'])
    assert.equal(request.messages.at(-1), tailMessages(request).at(-1))
    for (const m of tailMessages(request)) { assert.equal(m.role, 'user'); assert.match(m.content[0].text, /not a user instruction or authorization/); assert.notEqual(m.source.kind, 'user') }
    assert.match(request.messages.at(-1).content[0].text, /Last \{\{literal\}\}/)
    assert.deepEqual(h.requests[1].messages.map(m => m.id), request.messages.map(m => m.id))
    const committed = h.events.filter(({ session, event }) => session === a.session && event.type === 'user/message').map(({ event }) => event)
    assert.equal(committed.length, 4)
    const seed = h.events.filter(({ session }) => session === a.session).map(({ event }) => event)
    const replay = Session.create(a.session.id, seed, a.session.header)
    assert.deepEqual(replay.deriveMessages(), a.session.deriveMessages())
  } finally { await h.close() }
})

await test('no providers and empty provider results do not create messages; empty tool continuation and max-tokens closing do not call providers', async () => {
  const h = await promptHost()
  try {
    const a = await h.agent(), b = await h.agent(); let calls = 0
    registerStepTailProvider(h.owner(), a, { id: 'empty', revision: '1', provide: () => { ++calls; return '' } })
    h.ctx.get('tools').register({ name: 'fixture_tool', description: 'Fixture', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: () => 'done' })
    const tool = async function* () {
      yield { type: 'tool-call-delta', index: 0, id: 'fixture-call', name: 'fixture_tool', argumentsDelta: '{}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    await h.run(a, [tool, 'max-tokens'])
    assert.equal(calls, 1, 'empty tool-only and max-tokens probes cannot create artificial wakeups')
    assert.equal(h.requests.length, 2); assert.equal(tailMessages(h.requests[0]).length, 0)
    await h.run(b)
    assert.equal(tailMessages(h.requests.at(-1)).length, 0)
    assert.deepEqual(h.errors, [])
  } finally { await h.close() }
})

await test('reject and cancelled provider/request preparation commit no injected messages', async () => {
  const h = await promptHost()
  try {
    const a = await h.agent(), b = await h.agent(), c = await h.agent(); let rejectedCalls = 0
    registerStepTailProvider(h.owner(), a, { id: 'rejected', revision: '1', provide: () => { ++rejectedCalls; return 'No' } })
    a.ctx.on('agent/pre-step', async (_payload, next) => { await next(); return { kind: 'reject' } })
    a.followup((await import('@deepseek-ai/dsh-llm')).createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'reject' }] }))
    await a.whenIdle(); assert.equal(rejectedCalls, 0)
    let started; const began = new Promise(resolve => { started = resolve })
    registerStepTailProvider(h.owner(), b, { id: 'cancelled', revision: '1', provide: () => { started(); return new Promise(() => {}) } })
    b.followup((await import('@deepseek-ai/dsh-llm')).createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'abort' }] }))
    await began; b.cancel(); await b.whenIdle()
    registerStepTailProvider(h.owner(), c, { id: 'before-prepare-cancel', revision: '1', provide: () => 'Must not commit' })
    c.ctx.on('agent/request', async (_payload, next) => { const config = await next(); c.cancel(); return config })
    await h.run(c, [])
    assert.equal(h.requests.length, 0)
    assert.equal(h.events.some(({ event }) => event.type === 'user/message' && event.data.source.kind === 'dsh-ops:step-tail'), false)
  } finally { await h.close() }
})

await test('provider failures are observable and prevent admission, not silently swallowed', async () => {
  const h = await promptHost()
  try {
    const a = await h.agent()
    registerStepTailProvider(h.owner(), a, { id: 'broken', revision: 'r1', provide: () => { throw new Error('fixture failure') } })
    await h.run(a, [])
    assert.equal(h.requests.length, 0)
    assert.equal(h.errors.length, 1)
    assert.ok(h.errors[0] instanceof PromptProviderError)
    assert.equal(h.errors[0].contributionId, 'broken'); assert.equal(h.errors[0].revision, 'r1')
    assert.equal(h.errors[0].cause.message, 'fixture failure')
    assert.equal(h.events.some(({ event }) => event.type === 'user/message'), false)
  } finally { await h.close() }
})

await test('two concurrent agents remain isolated and unregister/reload during provider evaluation cannot publish stale text', async () => {
  const h = await promptHost()
  try {
    const a = await h.agent(), b = await h.agent(a), owner = h.owner()
    let release, entered
    const blocked = new Promise(resolve => { release = resolve }), began = new Promise(resolve => { entered = resolve })
    const stop = registerStepTailProvider(owner, a, { id: 'same', revision: 'old', provide: async () => { entered(); await blocked; return 'STALE' } })
    assert.throws(() => registerStepTailProvider(owner, a, { id: 'same', revision: 'duplicate', provide: () => '' }), /Duplicate/)
    registerStepTailProvider(owner, b, { id: 'same', revision: 'b', provide: () => 'B only' })
    const first = h.run(a); await began
    await h.run(b)
    stop(); stop()
    registerStepTailProvider(owner, a, { id: 'same', revision: 'new', provide: () => 'A new' })
    release(); await first
    const forA = h.requests.filter(r => r.sessionId === a.session.id), forB = h.requests.filter(r => r.sessionId === b.session.id)
    assert.equal(tailMessages(forA[0]).length, 0)
    assert.equal(tailMessages(forB[0])[0].source.revision, 'b')
    await h.run(a)
    assert.equal(tailMessages(h.requests.at(-1))[0].source.revision, 'new')
    await owner.fiber.dispose(); await h.run(a); await h.run(b)
    assert.equal(tailMessages(h.requests.at(-1)).length, 1, 'durable earlier B context remains in history')
    assert.equal(h.events.filter(({ session, event }) => session === b.session && event.type === 'user/message' && event.data.source.kind === 'dsh-ops:step-tail').length, 1)
    assert.deepEqual(h.errors, [])
  } finally { await h.close() }
})
await test('agent teardown releases registrations owned by a longer-lived plugin', async () => {
  const h = await promptHost()
  try {
    const handle = await h.handle(), owner = h.owner(), a = handle.agent
    registerSystemSection(owner, a, { id: 'owned', revision: '1', text: 'Must disappear' })
    registerStepTailProvider(owner, a, { id: 'owned', revision: '1', provide: () => 'Must disappear' })
    await handle.dispose()
    assert.doesNotMatch(renderPrompt(await h.ctx.get('systemPrompt').assemble({ scope: a })), /Must disappear/)
    await owner.fiber.dispose()
    assert.deepEqual(h.errors, [])
  } finally { await h.close() }
})
report('prompt-injection')
