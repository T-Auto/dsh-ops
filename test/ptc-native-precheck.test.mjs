/**
 * A registry mode that is not `ptc` cannot present PTC-only, and `modeFor` is the
 * very source the collapsed section reads. Answering from the scope chain is what
 * keeps an unattributed `tools/change` off the O(agents) assembly path.
 */
import { createScope } from '@deepseek-ai/dsh-scope'
import * as ptcModule from '../lib/ptc/index.js'
import { isPresentationProbe } from '../lib/presentation.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { assert, test, report, TEST_HOME } from './lib/harness.mjs'
import { legacyComponent } from './lib/legacy-component.mjs'
const ptc = legacyComponent(ptcModule)

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)) }

async function setup(toolsMode) {
  const { ctx, tools, prompt } = await bootHost({ toolsMode })
  await ctx.plugin(inner => {
    inner.provide('subprocess', { spawn() { throw new Error('a presentation probe must not execute a worker') } })
    inner.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: TEST_HOME, sessionId: session.id }) })
    inner.provide('ptcRuntime', { language: 'typescript' })
  })
  await ctx.plugin(ptc, { binaryPath: process.execPath, required: true })
  const agents = []
  for (let i = 0; i < 12; i++) {
    const id = `${toolsMode}-precheck-${i}`
    const agent = { id, session: { id, mode: 'danger-full-access', header: { cwd: TEST_HOME } } }
    agent.ctx = createScope(ctx, agent).ctx
    agents.push(agent)
    await ctx.serial('agent/created', { agent })
  }
  await flush()
  const assemble = prompt.assemble.bind(prompt)
  let probes = 0
  prompt.assemble = context => { if (isPresentationProbe(context)) ++probes; return assemble(context) }
  return { ctx, tools, agents, counted: () => probes, reset: () => { probes = 0 }, restore: () => { prompt.assemble = assemble } }
}

await test('a Native deployment answers an unattributed tools/change without assembling any agent', async () => {
  const host = await setup('native')
  try {
    // A bare registry notification is what the official host emits with no payload.
    // Every session here resolves to `native`, so the collapsed section renders empty
    // for all of them and no assembly can change a verdict.
    host.reset()
    await host.ctx.serial('tools/change', {})
    await flush()
    assert.equal(host.counted(), 0, 'a native scope owes no presentation assembly')

    // The same notification must still reach every scope: the optimisation may not
    // turn into a skipped reconcile.
    host.reset()
    const added = { id: 'native-precheck-added', session: { id: 'native-precheck-added', mode: 'danger-full-access', header: { cwd: TEST_HOME } } }
    added.ctx = createScope(host.ctx, added).ctx
    await host.ctx.serial('agent/created', { agent: added })
    await flush()
    assert.equal(host.counted(), 0, 'a newly created native scope resolves from the scope chain too')
    assert.ok(host.tools.get('run_code', added) === undefined, 'and it publishes no PTC surface')
  } finally { host.restore(); await shutdown(host.ctx) }
})

await test('a scope that flips to PTC is still probed, so the precheck never swallows a real transition', async () => {
  const host = await setup('native')
  try {
    const [flipped] = host.agents
    host.reset()
    // `presentAs` emits `tools/change` before `system-prompt/change`, so the registry
    // notification carries no re-derivation yet; the prompt epoch it raises is what the
    // next notification spends. That second pass verifies, and the precheck must let the
    // flipped scope through while the eleven native scopes still answer from the chain.
    await flipped.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.presentAs('ptc') } })
    await flush()
    await host.ctx.serial('tools/change', {})
    await flush()
    assert.equal(host.counted(), 1, 'the flipped scope pays its probe and the eleven native scopes do not')
    assert.ok(host.tools.get('run_code', flipped), 'and its PTC surface is published')
  } finally { host.restore(); await shutdown(host.ctx) }
})

await test('a both-mode deployment keeps probing, because only `ptc` renders the collapsed section', async () => {
  const host = await setup('both')
  try {
    host.reset()
    await host.ctx.serial('tools/change', {})
    await flush()
    assert.ok(host.counted() > 0, 'a non-ptc but non-native mode still owes the verdict it cannot answer from the scope chain')
  } finally { host.restore(); await shutdown(host.ctx) }
})

report('ptc-native-precheck')
