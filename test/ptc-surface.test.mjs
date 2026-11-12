/** Public DSH 0.2.2 definition reads preserve identity without schema cloning. */
import { createScope } from '@deepseek-ai/dsh-scope'
import { bootHost, shutdown } from './lib/host.mjs'
import { prepareStep } from './lib/executor.mjs'
import { assert, test, report } from './lib/harness.mjs'
import { surfaceOf, surfaceNames, visibleNames } from '../lib/surface.js'
const tool = name => ({ name, description: `fixture ${name}`, parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) })

await test('one public definition read supplies names and identity without schema projection or private access', async () => {
  const { ctx, tools } = await bootHost()
  try {
    tools.register(tool('alpha')); tools.register(tool('beta'))
    let reads = 0
    const publicOnly = { definitions(scope, toolSet) { reads++; return tools.definitions(scope, toolSet) } }
    const before = surfaceOf(publicOnly)
    assert.equal(reads, 1)
    assert.deepEqual(surfaceNames(before), ['alpha', 'beta'])
    const stop = tools.register(tool('gamma'))
    assert.notEqual(surfaceOf(publicOnly), before)
    stop(); assert.equal(surfaceOf(publicOnly), before)
  } finally { await shutdown(ctx) }
})
await test('same-name scoped replacement changes identity and unloading restores the prior key', async () => {
  const { ctx, tools } = await bootHost()
  try {
    tools.register(tool('alpha'))
    const agent = { id: 'identity' }
    agent.ctx = createScope(ctx, agent).ctx
    const before = surfaceOf(tools, agent)
    const fiber = await agent.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.register(tool('alpha')) } })
    assert.notEqual(surfaceOf(tools, agent), before)
    assert.deepEqual(surfaceNames(surfaceOf(tools, agent)), ['alpha'])
    await fiber.dispose(); assert.equal(surfaceOf(tools, agent), before)
  } finally { await shutdown(ctx) }
})
await test('registered definitions and admitted definitions are explicitly different reads', async () => {
  const { ctx, tools } = await bootHost()
  try {
    const agent = { id: 'admission' }; agent.ctx = createScope(ctx, agent).ctx
    let enabled = false
    await agent.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.register(tool('conditional'), { when: () => enabled }) } })
    const old = await prepareStep(ctx, agent)
    try {
      assert.deepEqual(visibleNames(tools, agent), ['conditional'])
      assert.deepEqual(visibleNames(tools, agent, old.toolSet), [])
      enabled = true
      assert.deepEqual(visibleNames(tools, agent, old.toolSet), [])
      const next = await prepareStep(ctx, agent)
      try { assert.deepEqual(visibleNames(tools, agent, next.toolSet), ['conditional']) }
      finally { next.dispose() }
    } finally { old.dispose() }
  } finally { await shutdown(ctx) }
})
await test('names containing separators round-trip without inventing registrations', () => {
  for (const name of ['one\u0000two', 'one\u0001two', 'one\\0two', 'one\\1two']) {
    const definitions = [tool(name)]
    const registry = { definitions: () => definitions }
    assert.deepEqual(surfaceNames(surfaceOf(registry)), [name])
    assert.deepEqual(visibleNames(registry), [name])
  }
})
report('ptc-surface')
