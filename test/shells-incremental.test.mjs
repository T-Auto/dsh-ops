import { createScope } from '@deepseek-ai/dsh-scope'
import { assert, test, report } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { mountSessionBash } from '../lib/session-shells.js'
const flush = () => new Promise(resolve => setImmediate(resolve))

async function setup() {
  const { ctx, tools } = await bootHost()
  await ctx.plugin(inner => {
    inner.provide('subprocess', { spawn() { throw new Error('publication test must not execute') } })
    inner.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: process.env.DSH_HOME }) })
  })
  await ctx.plugin({ inject: ['tools'], apply(inner) {
    mountSessionBash(inner, { publishBashTool: true }, { bash: { available: true, file: process.execPath, source: 'explicit', detail: 'publication only' } })
  } })
  const mint = async (id, parent, mode = 'danger-full-access') => {
    const agent = { id, session: { id, mode, header: { cwd: process.env.DSH_HOME } } }
    agent.ctx = createScope(parent?.ctx ?? ctx, agent, parent ? { parent } : undefined).ctx
    await ctx.serial('agent/created', { agent })
    await flush()
    return agent
  }
  return { ctx, tools, mint }
}
await test('unrelated attach and disposal preserve existing Bash definitions and bounded notifications', async () => {
  const {ctx, tools, mint} = await setup()
  try {
    const old = []
    for(let i=0;i<12;i++) old.push(await mint('old-'+i))
    const before = old.map(a => tools.get('ops_bash', a))
    let changes = 0; const off = ctx.on('tools/change', () => { changes++ })
    const added = await mint('new')
    assert.deepEqual(old.map(a => tools.get('ops_bash', a)), before)
    assert.equal(changes, 1, 'only the new Bash registration changes')
    await ctx.serial('agent/disposed', {agent:added})
    assert.equal(changes, 2, 'only the departed Bash registration changes')
    old.forEach((a,i) => assert.equal(tools.get('ops_bash',a),before[i]))
    off()
  } finally { await shutdown(ctx) }
})
await test('authority transitions preserve siblings and masks on restricted descendants', async () => {
  const {ctx,tools,mint} = await setup()
  try {
    const parent=await mint('parent'), child=await mint('child',parent,'read-only'), sibling=await mint('sibling')
    const stable=tools.get('ops_bash',sibling)
    assert.equal(tools.get('ops_bash',child), undefined, 'restricted child cannot inherit parent Bash without sandbox')
    parent.session.mode='read-only'
    await ctx.serial('session/event',parent.session,{type:'sandbox/mode'})
    await flush()
    assert.equal(tools.get('ops_bash',parent),undefined)
    assert.equal(tools.get('ops_bash',sibling),stable)
    parent.session.mode='danger-full-access'
    await ctx.serial('session/event',parent.session,{type:'sandbox/mode'})
    await flush()
    assert.ok(tools.get('ops_bash',parent))
    assert.equal(tools.get('ops_bash',child),undefined)
    assert.equal(tools.get('ops_bash',sibling),stable)
  } finally {await shutdown(ctx)}
})
report('shells-incremental')
