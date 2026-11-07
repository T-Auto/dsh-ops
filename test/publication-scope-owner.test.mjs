import { createScope } from '@deepseek-ai/dsh-scope'
import { acquirePtcFile, acquireSharedFile } from '../lib/publication/scope-owner.js'
import { publicToolName } from '../lib/policy.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { prepareStep } from './lib/executor.mjs'
import { assert, test, report } from './lib/harness.mjs'

await test('file owner shares static contracts and leases without transferring old step authority', async () => {
  const { ctx, tools } = await bootHost()
  const steps = []
  try {
    const agent = { id: 'shared-file-owner', session: { id: 'shared-file-owner' } }
    agent.ctx = createScope(ctx, agent).ctx
    const first = await acquirePtcFile(agent, 'grep')
    const second = await acquirePtcFile(agent, 'grep')
    const name = publicToolName('grep')
    const grant = label => ({ consumer: {}, agent, token: {}, entitled: true,
      dispatch: async () => ({ source: label }) })
    first.grant(grant('first'))
    const old = await prepareStep(ctx, agent); steps.push(old)
    second.grant(grant('second'))
    assert.equal(tools.definitions(agent).filter(def => def.name === name).length, 1)
    const ambiguous = await prepareStep(ctx, agent); steps.push(ambiguous)
    assert.equal(tools.executable(name, agent, ambiguous.toolSet), undefined)
    first.dispose()
    assert.equal(tools.executable(name, agent, old.toolSet), undefined)
    const fresh = await prepareStep(ctx, agent); steps.push(fresh)
    const current = tools.executable(name, agent, fresh.toolSet)
    assert.ok(current, 'remaining lease must keep the owner registered')
    assert.deepEqual(await current.execute({}, { agent, toolSet: fresh.toolSet }), { source: 'second' })
    second.dispose()
    assert.equal(tools.get(name, agent), undefined)
  } finally { steps.forEach(step => step.dispose()); await shutdown(ctx) }
})

await test('presentation predicate only narrows a captured consumer', async () => {
  const { ctx, tools } = await bootHost()
  const steps = []
  try {
    const agent = { id: 'file-presentation', session: { id: 'file-presentation' } }
    agent.ctx = createScope(ctx, agent).ctx
    const lease = await acquirePtcFile(agent, 'grep')
    let visible = false
    lease.grant({ consumer: {}, agent, token: {}, entitled: true,
      present: () => visible, dispatch: async () => ({ source: 'fixed-consumer' }) })
    const name = publicToolName('grep'), definition = tools.get(name, agent)
    const hidden = await prepareStep(ctx, agent); steps.push(hidden)
    assert.equal(tools.executable(name, agent, hidden.toolSet), undefined)
    visible = true
    const shown = await prepareStep(ctx, agent); steps.push(shown)
    assert.equal(tools.get(name, agent), definition, 'when must not mutate registration')
    assert.equal(tools.executable(name, agent, hidden.toolSet), undefined, 'old hidden step must stay hidden')
    assert.equal(tools.executable(name, agent, shown.toolSet), definition)
    lease.dispose()
  } finally { steps.forEach(step => step.dispose()); await shutdown(ctx) }
})
await test('asynchronous acquisition cannot revive a disposed source owner', async () => {
  const { ctx, tools } = await bootHost()
  try {
    const agent = { id: 'disposed-owner', session: { id: 'disposed-owner' } }
    const scope = createScope(ctx, agent)
    agent.ctx = scope.ctx
    const acquisition = acquirePtcFile(agent, 'grep')
    const rejection = assert.rejects(acquisition, /inactive context/)
    await scope.dispose()
    await rejection
    await assert.rejects(acquireSharedFile(agent, 'stat', { workerPath: process.execPath }), /inactive context/)
    assert.deepEqual(tools.definitions(agent), [], 'no source or registration survives disposed ownership')
  } finally { await shutdown(ctx) }
})
report('publication-scope-owner')
