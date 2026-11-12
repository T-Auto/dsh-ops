/** Assembly-side foreign registry changes cannot trigger recursive discovery traversal. */
import { fixture } from './lib/discovery-admission.mjs'
import { selectExecutor } from './lib/executor.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { shutdown } from './lib/host.mjs'
const tool = name => ({ name, description: name, parameters: { type: 'object' }, output: { schema: {}, render: () => [] }, execute: () => ({}) })
for (const channel of ['tools', 'prompt']) await test(`assembly-side ${channel} changes do not amplify resolve or replace discovery identity`, () => withTempDir('feedback', async root => {
  const { ctx, mint, names, probes } = await fixture(root)
  try {
    const owner = await mint(), other = await mint()
    ctx.tools.register(tool('co_dummy'))
    let changes = 0
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const result = await next()
      if (channel === 'tools') context.scope.ctx.tools.restrict({ deny: ['co_dummy'] })
      else ctx.systemPrompt.section({ name: 'feedback-' + changes, order: 40, text: '' })
      ++changes
      return result
    })
    const definition = ctx.tools.get('ops_discover_tools', owner)
    probes.clear()
    for (let i = 0; i < 10; i++) assert.ok((await names(owner)).includes('ops_discover_tools'))
    assert.equal(probes.get(owner), 10, 'one mode probe per admission')
    assert.equal(probes.get(other), undefined, 'no unrelated traversal')
    assert.equal(changes, 20, 'one admission and one provider assembly per request')
    assert.equal(ctx.tools.get('ops_discover_tools', owner), definition)
  } finally { await shutdown(ctx) }
}))
await test('real external executor changes affect the next resolve without registration churn', () => withTempDir('feedback-executor', async root => {
  const { ctx, mint, names } = await fixture(root)
  try {
    ctx.provide('ptcRuntime', { language: 'typescript' })
    const owner = await mint(), definition = ctx.tools.get('ops_discover_tools', owner)
    assert.ok((await names(owner)).includes('ops_discover_tools'))
    const lift = selectExecutor(owner.ctx, 'ptc')
    assert.equal((await names(owner)).includes('ops_discover_tools'), false)
    lift(); selectExecutor(owner.ctx, 'native')
    assert.ok((await names(owner)).includes('ops_discover_tools'))
    assert.equal(ctx.tools.get('ops_discover_tools', owner), definition)
  } finally { await shutdown(ctx) }
}))
report('discovery-feedback-loop')
