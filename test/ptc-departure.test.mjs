import fs from 'node:fs'
import path from 'node:path'
import { createScope } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import * as ptc from '../lib/ptc/index.js'
import { isPresentationProbe } from '../lib/presentation.js'
import { assert, test, report, wait, waitFor, withTempDir } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'
requireWorker('ptc-departure')
let sequence = 0
const names = (ctx, agent) => ctx.get('tools').schemas(agent).map(tool => tool.name).sort()
// A stall must fail the check, not hang the suite: the timer is cleared so it cannot
// outlive the race and keep the process alive past report().
const bounded = async (work, ms) => { let timer; try { return await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), ms) })]) } finally { clearTimeout(timer) } }
async function setup(dir) {
  const { ctx } = await bootHost()
  const agents = []; ctx.provide('agents', { list: () => agents })
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem); await ctx.plugin(NodePtc)
  await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: session?.mode ?? 'workspace-write', workspaceRoot: dir, sessionId: session?.id }) }))
  await ctx.plugin(ptc, { binaryPath: WORKER, required: true })
  async function mint(mode = 'native') {
    const id = 'departure-' + ++sequence, agent = { id, session: { id, mode: 'workspace-write', header: { cwd: dir }, append() {}, read() { return [] } } }
    agent.ctx = createScope(ctx, agent).ctx
    await agent.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.presentAs(mode) } })
    agents.push(agent)
    await ctx.serial('agent/created', { agent })
    return agent
  }
  return { ctx, mint }
}
// A presentation probe assembles the whole prompt, so counting probe assemblies is how a
// pass that skips agents is told apart from one that walks every agent again.
await test('an agent departure republishes without re-probing the survivors', () => withTempDir('ptc-departure', async dir => {
  const { ctx, mint } = await setup(dir)
  try {
    const prompt = ctx.get('systemPrompt'), assemble = prompt.assemble.bind(prompt)
    let probes = 0
    prompt.assemble = context => { if (isPresentationProbe(context)) ++probes; return assemble(context) }
    try {
    const keep = await mint('ptc'), leave = await mint('ptc')
    await waitFor(() => names(ctx, keep).includes('run_code') && names(ctx, leave).includes('run_code'))
    await wait(200)
    const before = probes
    const settled = await bounded(ctx.serial('agent/disposed', { agent: leave }).then(() => 'done'), 5000)
    assert.equal(settled, 'done', 'a departure must not stall its own event')
    assert.equal(probes, before, 'a departure names no agent to probe, so the survivors keep the verdict they already have')
    assert.ok(names(ctx, keep).includes('run_code'), 'the surviving agent keeps the PTC surface the departure left intact')
    // run_code stays visible: presentAs('ptc') is the departing scope's own layer,
    // while the PTC row's own APIs are what a departure must withdraw.
    assert.equal(names(ctx, keep).filter(name => name.startsWith('ops_')).includes('ops_load_sdk'), true)
    assert.equal(names(ctx, leave).filter(name => name.startsWith('ops_')).includes('ops_load_sdk'), false)
    } finally { prompt.assemble = assemble }
  } finally { await shutdown(ctx) }
}))
report('ptc-departure')
