/** Unselected discovered tools must name the selector and its select: query (#764). */
import { createScope } from '@deepseek-ai/dsh-scope'
import SessionStore from '@deepseek-ai/dsh-session'
import { mountDiscovery } from '../lib/discovery/controller.js'
import { registerNativeCapability } from '../lib/discovery/providers.js'
import { assert, test, report, waitFor } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { executeCall } from './lib/executor.mjs'

const DISCOVER = 'ops_discover_tools'
const definition = (name, execute = () => ({ status: 'completed', answer: 42 })) => ({
  name, description: 'Look up project inventory.', parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute,
})
/** The minimal tool-set view the registry's executable check accepts for one definition. */
const soloView = definition => ({ view: () => new Map([[definition.name, definition]]) })

async function setup() {
  const { ctx, tools } = await bootHost()
  await ctx.plugin(SessionStore)
  const agents = []
  ctx.provide('agents', { list: () => agents })
  // Publication-only worker fixture: never invoked; no Rust runtime is needed by this suite.
  ctx.provide('subprocess', { spawn() { throw new Error('deferred rejection fixtures never spawn') } })
  ctx.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session?.mode ?? 'danger-full-access', workspaceRoot: process.cwd(), sessionId: session?.id }) })
  await ctx.plugin({ apply(inner) {
    mountDiscovery(inner, { allowedTools: ['stat', 'write_file'], alwaysLoaded: [], binaryPath: process.execPath }, {
      allows: () => true, residentTools: () => [],
      external: { allowed: ['acme_lookup'], disabled: [], alwaysLoaded: [] },
    })
  } })
  await waitFor(() => ctx.get('tools') && ctx.get('systemPrompt'))
  for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve))
  await registerNativeCapability(ctx, {
    definition: definition('acme_lookup'), search: 'inventory project lookup', authorize: () => true,
  })
  const mint = async (mode = 'danger-full-access') => {
    const id = 'discovery-deferred-' + mode
    const session = ctx.get('sessions').create(id, { meta: { cwd: process.cwd() } })
    session.mode = mode
    const agent = { id, session }
    agent.ctx = createScope(ctx, agent).ctx
    agents.push(agent)
    await ctx.serial('agent/created', { agent })
    await waitFor(() => tools.get(DISCOVER, agent), { what: 'discovery lifecycle initialization' })
    return agent
  }
  return { ctx, tools, mint }
}

/** Dispatch the registered definition the way a host that ignores `when` does (#934 shape). */
const dispatch = async (ctx, agent, name) => {
  const definition = ctx.get('tools').get(name, agent) ?? ctx.get('tools').definitions(agent).find(def => def.name === name)
  assert.ok(definition, name + ' must be registered for this scenario')
  return definition.execute({}, { agent, signal: new AbortController().signal, toolSet: soloView(definition) })
}

await test('an unselected builtin discovery capability answers with the select: query path', async () => {
  const { ctx, mint } = await setup()
  try {
    const agent = await mint()
    const result = await dispatch(ctx, agent, 'ops_stat')
    assert.equal(result.error?.code, 'CAPABILITY_NOT_SELECTED')
    assert.match(result.error.message, /ops_stat/)
    assert.match(result.error.nextAction ?? '', /ops_discover_tools/)
    assert.match(result.error.nextAction ?? '', /select:ops_stat/)
  } finally { await shutdown(ctx) }
})

await test('an unselected external provider capability answers with the same select: path', async () => {
  const { ctx, mint } = await setup()
  try {
    const agent = await mint()
    const result = await dispatch(ctx, agent, 'acme_lookup')
    assert.equal(result.error?.code, 'CAPABILITY_NOT_SELECTED')
    assert.match(result.error.message, /acme_lookup/)
    assert.match(result.error.nextAction ?? '', /select:acme_lookup/)
  } finally { await shutdown(ctx) }
})

await test('a discovered selection stops answering with the deferred rejection', async () => {
  const { ctx, mint } = await setup()
  try {
    const agent = await mint()
    // The selector itself must stay callable while its pool defers.
    assert.equal((await dispatch(ctx, agent, 'ops_stat')).error?.code, 'CAPABILITY_NOT_SELECTED')
    const select = await executeCall(ctx, { agent, name: DISCOVER, arguments: { query: 'select:ops_stat' }, callId: 'select-stat' })
    assert.equal(select.isError, false, JSON.stringify(select))
    assert.deepEqual(select.value.activated, ['ops_stat'])
    agent.session.append('step/end', { turn: 1, step: 1 })
    const result = await dispatch(ctx, agent, 'ops_stat')
    assert.notEqual(result.error?.code, 'CAPABILITY_NOT_SELECTED')
  } finally { await shutdown(ctx) }
})

await test('a read-only scope keeps the generic refusal for mutating capabilities', async () => {
  const { ctx, mint } = await setup()
  try {
    const agent = await mint('read-only')
    const result = await dispatch(ctx, agent, 'ops_write_file')
    // Read-only policy can never select a mutating capability, so a select: pointer would be dishonest.
    assert.notEqual(result.error?.code, 'CAPABILITY_NOT_SELECTED')
  } finally { await shutdown(ctx) }
})

report('discovery-deferred-rejection')
