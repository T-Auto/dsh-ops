/** Shared per-scope assembly cache across discovery and ptc: a scoped
 * registration re-verifies only the affected agent while every other agent
 * reuses the cached assembly, so tools/change never re-assembles the whole
 * fleet. */
import { createScope } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import { bootHost, shutdown } from './lib/host.mjs'
import { assert, test, report, waitFor, withTempDir } from './lib/harness.mjs'
import * as Ptc from '../lib/ptc/index.js'
import { tryResolveWorker } from '../lib/ptc/runtime.js'

const worker = tryResolveWorker()
if (!worker.ok) skipSuite('ptc-cache', worker.reason)

async function boot() {
  const { ctx } = await bootHost()
  await ctx.plugin(Subprocess)
  await ctx.plugin(Sandbox, {})
  ctx.plugin(inner => inner.provide('sandboxPolicy', {
    resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: session.header.cwd, sessionId: session.id }),
  }))
  ctx.provide('ptcRuntime', { language: 'typescript' })
  await ctx.plugin(Ptc, { required: true })
  await new Promise(resolve => setImmediate(resolve))
  return { ctx }
}

async function mint(ctx, id, dir) {
  const agent = { id, session: { id, mode: 'danger-full-access', header: { cwd: dir } } }
  await ctx.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
  await ctx.serial('agent/created', { agent, source: 'startup' })
  return agent
}

await test('a scoped registration re-verifies only the affected agent while others reuse the shared cache', () => withTempDir('ptc-cache', async dir => {
  const { ctx } = await boot()
  try {
    let assembles = 0
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => { assembles++; return next() })
    const agents = []
    for (let i = 0; i < 3; i++) agents.push(await mint(ctx, `ptc-cache-${i}`, dir))
    await waitFor(() => assembles === 3, { what: 'each attach probes once through the shared cache' })
    const shellRow = { name: 'sim_shell_row', description: 'mock shell row', parameters: {}, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) }
    await agents[2].ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.register(shellRow) } })
    await waitFor(() => assembles === 4, { timeoutMs: 15000, what: 'a scoped registration re-verifies exactly that agent' })
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(assembles, 4, 'tools/change re-verifies one agent, not three')
  } finally { await shutdown(ctx) }
}))

await report('ptc-cache')
