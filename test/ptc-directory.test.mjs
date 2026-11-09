import { selectExecutor, executeCall, prepareStep } from './lib/executor.mjs'
/** Real host/PTC loader integration; no native file operation is exercised here. */
import { createScope } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import { mountPtc } from '../lib/publication/ptc.js'
import { publicToolName } from '../lib/policy.js'
import { renderSdkDirectory } from '../lib/projections/ptc/directory.js'
import { assert, test, report, waitFor, withTempDir } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'

let sequence = 0
const loader = publicToolName('load_sdk')
const section = 'dsh-ops:repository-tooling:mode-ptc'
const step = (ctx, agent) => ctx.serial('session/event', agent.session, { type: 'step/end' })
async function assemblyFor(ctx, agent) { const step = await prepareStep(ctx, agent); try { return step.assembly } finally { step.dispose() } }
const text = async (ctx, agent) => (await assemblyFor(ctx, agent)).sections.filter(row => row.name.startsWith(section)).map(row => row.text).join('\n')
const configured = (ctx, agent) => ctx.get('tools').get(loader, agent)?.description.split('): ')[1]?.replace(/\.$/, '').split(', ') ?? []
async function setup(root, config = {}, gate = { allows: () => true }) {
  const { ctx } = await bootHost()
  const agents = []; ctx.provide('agents', { list: () => agents })
  const state = { available: true }
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem)
  await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: ({ session } = {}) => {
    if (!state.available) throw new Error('policy unavailable')
    return { mode: session?.mode ?? 'danger-full-access', workspaceRoot: root, sessionId: session?.id }
  } }))
  await ctx.plugin(NodePtc)
  const mount = () => ctx.plugin({ name: 'ptc-directory-fixture', apply(inner) {
    mountPtc(inner, { binaryPath: process.execPath, required: true, ...config }, gate)
  } })
  const component = await mount()
  // Cordis publishes asynchronous injected scopes after the plugin mount resolves.
  await new Promise(resolve => setImmediate(resolve))
  const mint = async (mode = 'ptc') => {
    const id = 'directory-' + ++sequence
    const agent = { id, session: { id, mode: 'danger-full-access', header: { cwd: root }, append() {}, read() { return [] } } }
    agent.ctx = createScope(ctx, agent).ctx
    agent.presentation = await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, mode) } })
    agents.push(agent); await ctx.serial('agent/created', { agent })
    return agent
  }
  return { ctx, component, mint, mount, state }
}
async function code(ctx, agent, body) {
  const result = await executeCall(ctx, { name: 'run_code', callId: 'directory-call-' + ++sequence,
    agent, arguments: { description: 'Exercise PTC SDK selection', code: body } })
  assert.equal(result.isError, false, JSON.stringify(result))
  return result.value.result
}
const callable = (ctx, agent, raw) => code(ctx, agent, `return typeof tools.${publicToolName(raw)}==='function';`)
const load = (ctx, agent, tools) => code(ctx, agent, `return await tools.${loader}({tools:${JSON.stringify(tools)}});`)

await test('resident directory is at most one pointer; the loader schema owns names and selection semantics', () => {
  assert.equal(renderSdkDirectory([], new Set()), '')
  assert.equal(renderSdkDirectory(['grep'], new Set([publicToolName('grep')])), '')
  const value = renderSdkDirectory(['grep', 'batch'], new Set())
  assert.match(value, /tools\.ops_load_sdk/)
  assert.equal(value.split('\n').length, 1)
  assert.doesNotMatch(value, /- grep:|- batch:|discover_tools|select:/)
})
await test('loader names replace the directory; Node dispatch preserves next-step selection and isolation', () => withTempDir('ptc-directory', async root => {
  const { ctx, mint } = await setup(root, { allowedTools: ['grep', 'stat'], alwaysLoaded: ['stat'] })
  try {
    const a = await mint(), b = await mint(), native = await mint('native')
    assert.deepEqual(configured(ctx, a), ['grep', 'stat', 'result'])
    assert.match(await text(ctx, a), /tools\.ops_load_sdk/)
    assert.equal(await text(ctx, native), '')
    assert.equal(await callable(ctx, a, 'stat'), true)
    assert.equal(await callable(ctx, a, 'result'), false)
    assert.equal((await load(ctx, a, ['batch'])).error.code, 'INVALID_ARGUMENT')
    const selected = await load(ctx, a, ['grep', 'result'])
    assert.equal(selected.status, 'completed'); assert.equal(selected.data.nextTurn, true)
    assert.equal(await callable(ctx, a, 'grep'), false)
    assert.equal(await callable(ctx, a, 'result'), false)
    await text(ctx, a) // assembly cannot commit pending requests
    assert.equal(await callable(ctx, a, 'grep'), false)
    await step(ctx, a)
    assert.equal(await callable(ctx, a, 'grep'), true)
    assert.equal(await callable(ctx, a, 'result'), true)
    assert.equal(await callable(ctx, b, 'grep'), false)
    assert.equal(await callable(ctx, b, 'result'), false)
    assert.doesNotMatch(await text(ctx, a), /For on-demand APIs/)
    assert.match(await text(ctx, b), /For on-demand APIs/)
    const sdk = (await assemblyFor(ctx, a)).sections.find(row => row.name === 'tools:sdk').text
    assert.match(sdk, /ops_result/); assert.match(sdk, /ttlMs/); assert.match(sdk, /maxBytes/)
  } finally { await shutdown(ctx) }
}))
for (const resident of [true, false]) for (const allowedTools of [[], ['stat'], ['read_files']]) {
  await test(`resident=${resident} preserves configured pool ${JSON.stringify(allowedTools)} plus deferred result`, () => withTempDir('ptc-directory-pool', async root => {
    const { ctx, mint } = await setup(root, { allowedTools }, { allows: () => true, resident })
    try {
      const agent = await mint(), eligible = [...allowedTools, 'result']
      assert.deepEqual(configured(ctx, agent), eligible)
      assert.equal(await callable(ctx, agent, 'inspect_local_file'), resident)
      assert.equal(await callable(ctx, agent, 'result'), false)
      for (const raw of eligible) assert.equal(await callable(ctx, agent, raw), false)
      assert.equal((await load(ctx, agent, ['grep'])).error.code, 'INVALID_ARGUMENT')
      assert.equal((await load(ctx, agent, eligible)).status, 'completed')
      await step(ctx, agent)
      for (const raw of eligible) assert.equal(await callable(ctx, agent, raw), true)
      assert.doesNotMatch(await text(ctx, agent), /For on-demand APIs/)
    } finally { await shutdown(ctx) }
  }))
}
await test('current authority narrows configured names; unavailable policy does not publish a stale SDK', () => withTempDir('ptc-directory-policy', async root => {
  const { ctx, mint, state } = await setup(root, { allowedTools: ['grep', 'write_file', 'batch'] })
  try {
    const agent = await mint()
    agent.session.mode = 'read-only'; await ctx.serial('session/event', agent.session, { type: 'sandbox/mode' })
    assert.equal((await load(ctx, agent, ['write_file'])).error.code, 'INVALID_ARGUMENT')
    assert.equal((await load(ctx, agent, ['batch'])).error.code, 'INVALID_ARGUMENT')
    assert.equal((await load(ctx, agent, ['grep', 'result'])).status, 'completed')
    state.available = false
    await assert.rejects(() => text(ctx, agent), error => error.name === 'ToolActivationError' && error.cause?.message === 'policy unavailable')
    state.available = true
    await step(ctx, agent)
    assert.equal(await callable(ctx, agent, 'grep'), true)
  } finally { await shutdown(ctx) }
}))
await test('revocation before commit and ownership withdrawal discard pending selections; reload resets result', () => withTempDir('ptc-directory-life', async root => {
  let permitted = true, notify
  const gate = { allows: () => permitted, watch(callback) { notify = callback; return () => { notify = undefined } } }
  const { ctx, component, mint, mount } = await setup(root, { allowedTools: ['write_file'] }, gate)
  try {
    const agent = await mint()
    await load(ctx, agent, ['write_file', 'result'])
    agent.session.mode = 'read-only'; await step(ctx, agent)
    assert.equal(await callable(ctx, agent, 'write_file'), false)
    assert.equal(await callable(ctx, agent, 'result'), true)
    permitted = false; notify()
    assert.equal(await text(ctx, agent), '')
    await waitFor(() => ctx.get('tools').get(loader, agent) === undefined)
    await component.dispose()
    permitted = true
    const reloaded = await mount()
    await waitFor(() => ctx.get('tools').get(loader, agent) !== undefined)
    assert.equal(await callable(ctx, agent, 'result'), false)
    await reloaded.dispose()
  } finally { await shutdown(ctx) }
}))
await test('nearer scoped loader replaces only its agent pool and unload restores outer names', () => withTempDir('ptc-directory-scope', async root => {
  const { ctx, mint } = await setup(root, { allowedTools: ['grep'] })
  try {
    const owner = await mint(), other = await mint()
    const nearer = await owner.ctx.plugin({ name: 'scoped-directory-fixture', apply(inner) {
      mountPtc(inner, { binaryPath: process.execPath, required: true, allowedTools: ['stat'] })
    } })
    await waitFor(() => configured(ctx, owner).includes('stat'))
    assert.deepEqual(configured(ctx, owner), ['stat', 'result'])
    assert.deepEqual(configured(ctx, other), ['grep', 'result'])
    await nearer.dispose(); await waitFor(() => configured(ctx, owner).includes('grep'))
    assert.deepEqual(configured(ctx, owner), ['grep', 'result'])
  } finally { await shutdown(ctx) }
}))
await test('disabled guidance, dynamic selection and unavailable worker publish no directory', () => withTempDir('ptc-directory-off', async root => {
  for (const [config, gate] of [[{ binaryPath: root + '/missing', required: false }, { allows: () => true }], [{}, { allows: () => true, guidance: false }], [{}, { allows: () => true, dynamic: false }]]) {
    const { ctx, mint } = await setup(root, config, gate)
    try {
      const agent = await mint()
      assert.doesNotMatch(await text(ctx, agent), /For on-demand APIs/)
      if (gate.guidance === false) assert.equal(await text(ctx, agent), '')
      else assert.equal(ctx.get('tools').get(loader, agent), undefined)
    } finally { await shutdown(ctx) }
  }
}))
report('ptc-directory')
