/** A registered-but-unselected pool API must point at the loader, not a dead end (#968). */
import { createScope } from '@deepseek-ai/dsh-scope'
import { mountPtc } from '../lib/publication/ptc.js'
import { publicToolName } from '../lib/policy.js'
import { assert, test, report, waitFor } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
/** The minimal tool-set view the registry's executable check accepts for one definition. */
const soloView = definition => ({ view: () => new Map([[definition.name, definition]]) })

async function setup(config, gate = { allows: () => true }) {
  const { ctx } = await bootHost({ withWorkingDirectory: true, toolsMode: 'ptc' })
  const agents = []
  ctx.provide('agents', { list: () => agents })
  await ctx.plugin(inner => {
    inner.provide('ptcRuntime', { language: 'typescript' })
    inner.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session?.mode ?? 'danger-full-access', workspaceRoot: process.cwd() }) })
    inner.provide('subprocess', { spawn() { throw new Error('deferred rejection fixtures never spawn') } })
  })
  mountPtc(ctx, { binaryPath: process.execPath, required: true, ...config }, gate)
  const mint = async (mode = 'danger-full-access') => {
    const id = 'deferred-' + mode
    const agent = { id, session: { id, mode, header: { cwd: process.cwd() }, append() {}, read() { return [] } } }
    agent.ctx = createScope(ctx, agent).ctx
    agents.push(agent)
    await ctx.serial('agent/created', { agent })
    await tick()
    return agent
  }
  return { ctx, mint }
}

/** Dispatch the registered definition the way a host that ignores `when` does (#934 shape). */
const dispatch = async (ctx, agent, raw) => {
  const tools = ctx.get('tools')
  const definition = tools.get(publicToolName(raw), agent)
    ?? tools.definitions(agent).find(def => def.name === publicToolName(raw))
  assert.ok(definition, publicToolName(raw) + ' must be registered for this scenario')
  return definition.execute({}, { agent, signal: new AbortController().signal, toolSet: soloView(definition) })
}

await test('an unselected shared-file pool API answers with the loader path, not a retry-never dead end', async () => {
  const { ctx, mint } = await setup({ allowedTools: ['grep', 'batch', 'write_file'] })
  try {
    const agent = await mint()
    await waitFor(() => ctx.get('tools').get(publicToolName('grep'), agent), { what: 'PTC pool registration' })
    const result = await dispatch(ctx, agent, 'grep')
    assert.equal(result.error?.code, 'SDK_NOT_LOADED')
    assert.match(result.error.message, /grep/)
    assert.match(result.error.nextAction ?? '', /ops_load_sdk/)
    assert.match(result.error.nextAction ?? '', /next model step/)
  } finally { await shutdown(ctx) }
})

await test('an unselected PTC-only pool API answers with the same loader path', async () => {
  const { ctx, mint } = await setup({ allowedTools: ['grep', 'batch', 'write_file'] })
  try {
    const agent = await mint()
    await waitFor(() => ctx.get('tools').get(publicToolName('batch'), agent), { what: 'PTC pool registration' })
    const result = await dispatch(ctx, agent, 'batch')
    assert.equal(result.error?.code, 'SDK_NOT_LOADED')
    assert.match(result.error.message, /batch/)
    assert.match(result.error.nextAction ?? '', /ops_load_sdk/)
  } finally { await shutdown(ctx) }
})

await test('a pool API the current policy cannot load keeps the generic refusal', async () => {
  const { ctx, mint } = await setup({ allowedTools: ['grep', 'batch', 'write_file'] })
  try {
    const agent = await mint('read-only')
    await waitFor(() => ctx.get('tools').get(publicToolName('write_file'), agent), { what: 'PTC pool registration' })
    const result = await dispatch(ctx, agent, 'write_file')
    // Read-only policy can never load a mutating API, so pointing at the loader would be dishonest.
    assert.notEqual(result.error?.code, 'SDK_NOT_LOADED')
  } finally { await shutdown(ctx) }
})

await test('a loader-less scope keeps registering nothing from the pool', async () => {
  const { ctx, mint } = await setup({ allowedTools: ['grep'] }, { allows: () => true, dynamic: false })
  try {
    const agent = await mint()
    await tick(); await tick()
    assert.equal(ctx.get('tools').get(publicToolName('grep'), agent), undefined)
  } finally { await shutdown(ctx) }
})

report('ptc-deferred-rejection')
