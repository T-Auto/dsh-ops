/** Replacement guards use the exact DSH 0.2.2 step admission, not waterfall text. */
import { createScope } from '@deepseek-ai/dsh-scope'
import { mountReplacements } from '../lib/publication/replacements.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { assert, test, report, wait } from './lib/harness.mjs'
import { prepareStep, executeCall } from './lib/executor.mjs'
const COUNTERPART = 'ops_inspect_local_file'
const tool = name => ({ name, description: `fixture ${name}`, parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({ ran: name }) })
async function fixture(body) {
  const { ctx, tools } = await bootHost()
  let allowed = true
  const agent = { id: 'replacement', session: { id: 'replacement' } }
  agent.ctx = createScope(ctx, agent).ctx
  ctx.provide('agents', { list: () => [agent] })
  tools.register(tool('read'))
  await ctx.plugin({ apply(inner) { mountReplacements(inner, { id: 'fixture', targets: new Map([['read', COUNTERPART]]),
    gate: { allows: () => allowed }, keepOfficial: () => false }) } })
  try { await ctx.serial('agent/created', { agent }); await body({ ctx, tools, agent, revokeAuthority: () => { allowed = false } }) }
  finally { await shutdown(ctx) }
}
const dispatch = (ctx, agent, step, name) => executeCall(ctx, { agent, name, arguments: {}, callId: name,
  signal: new AbortController().signal, toolSet: step.toolSet })

await test('a conditional replacement never denies the official-only held request', () => fixture(async ({ ctx, tools, agent }) => {
  let enabled = false
  await agent.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.register(tool(COUNTERPART), { when: () => enabled }) } })
  const held = await prepareStep(ctx, agent)
  try {
    assert.deepEqual(held.assembly.tools.map(t => t.name), ['read'])
    enabled = true
    await wait(30)
    await ctx.get('systemPrompt').assemble({ scope: agent })
    const result = await dispatch(ctx, agent, held, 'read')
    assert.equal(result.isError, false); assert.equal(result.value.ran, 'read')
    assert.equal(tools.executable(COUNTERPART, agent, held.toolSet), undefined)
    const next = await prepareStep(ctx, agent)
    try {
      assert.ok(next.assembly.tools.some(t => t.name === COUNTERPART))
      const refused = await dispatch(ctx, agent, next, 'read')
      assert.equal(refused.isError, true)
      assert.match(JSON.stringify(refused), /MODE_REPLACEMENT|replaced the official/)
      assert.equal((await dispatch(ctx, agent, next, COUNTERPART)).isError, false)
    } finally { next.dispose() }
  } finally { held.dispose() }
}))
await test('an unloaded conditional counterpart cannot deny a still-live official tool', () => fixture(async ({ ctx, agent }) => {
  const fiber = await agent.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.register(tool(COUNTERPART), { when: () => true }) } })
  const step = await prepareStep(ctx, agent)
  try {
    await fiber.dispose()
    const result = await dispatch(ctx, agent, step, 'read')
    assert.equal(result.isError, false)
    assert.equal(result.value.ran, 'read')
  } finally { step.dispose() }
}))
await test('revoked consumer authority cannot guard an official call on a held admitted step', () => fixture(async ({ ctx, tools, agent, revokeAuthority }) => {
  await agent.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.register(tool(COUNTERPART), { when: () => true }) } })
  const step = await prepareStep(ctx, agent)
  try {
    assert.ok(tools.executable(COUNTERPART, agent, step.toolSet))
    assert.equal((await dispatch(ctx, agent, step, 'read')).isError, true)
    revokeAuthority()
    const result = await dispatch(ctx, agent, step, 'read')
    assert.equal(result.isError, false)
    assert.equal(result.value.ran, 'read', 'a revoked consumer cannot keep both tools unavailable')
  } finally { step.dispose() }
}))
report('replacements-admission')
