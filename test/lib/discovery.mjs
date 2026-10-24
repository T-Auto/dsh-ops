import * as ptc from '../../lib/ptc/index.js'
/** Real Cordis discovery composition; no registry method replacement. */
import fs from 'node:fs'
import path from 'node:path'
import { createScope } from '@deepseek-ai/dsh-scope'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import * as discovery from '../../lib/components/discovery/index.js'
import { definition } from '../../lib/file/contract.js'
import { publicToolName } from '../../lib/policy.js'
import { DISCOVERY_TOOL_NAME } from '../../lib/capabilities/registry.js'
import { assert, test, waitFor, withTempDir } from './harness.mjs'
import { bootHost, registryHasOwnRegister, scopedToolNames, shutdown } from './host.mjs'

const DISCOVER = publicToolName(DISCOVERY_TOOL_NAME)
async function boot(config = {}) {
  const { ctx } = await bootHost()
  await ctx.plugin(Subprocess)
  await ctx.plugin(Sandbox, {})
  await ctx.plugin(inner => inner.provide('sandboxPolicy', {
    resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: session.header.cwd, sessionId: session.id }),
  }))
  const fiber = await ctx.plugin(discovery, { required: true, ...config })
  await new Promise(resolve => setImmediate(resolve))
  return { ctx, fiber }
}
async function mint(ctx, id, cwd, parent, mode = 'danger-full-access') {
  const agent = { id, session: { id, mode, header: { cwd } } }
  await (parent?.ctx ?? ctx).plugin({ inject: ['tools'], apply(inner) {
    agent.ctx = createScope(inner, agent, parent ? { parent } : undefined).ctx
  } })
  await ctx.serial('agent/created', { agent, source: 'startup' })
  return agent
}
const assemble = (ctx, agent) => ctx.get('systemPrompt').assemble({ scope: agent })
const nextStep = (ctx, agent) => ctx.waterfall('agent/pre-step', { agent, messages: [], turn: 1, step: 2, signal: new AbortController().signal }, async () => ({ kind: 'continue' }))
const call = (ctx, agent, name, args = {}) => ctx.get('tools').execute({ agent, name: publicToolName(name), arguments: args, callId: 'discovery-test', signal: new AbortController().signal })

export async function discoveryMountChecks() {
  await test('BM-04 discovery queues activation until the next model step without performing the action', () => withTempDir('discovery', async dir => {
    const { ctx } = await boot()
    try {
      fs.writeFileSync(path.join(dir, 'file.txt'), 'unchanged')
      const agent = await mint(ctx, 'discover-next-step', dir)
      const first = await assemble(ctx, agent)
      assert.deepEqual(first.tools.map(tool => tool.name), [DISCOVER])
      assert.equal(registryHasOwnRegister(ctx), false)
      assert.deepEqual(ctx.get('tools').schemas(), [])
      const found = await call(ctx, agent, 'discover_tools', { query: 'select:ops_stat' })
      assert.equal(found.isError, false)
      assert.deepEqual(found.value.activated, [publicToolName('stat')])
      assert.equal(scopedToolNames(ctx, agent).includes(publicToolName('stat')), false)
      assert.equal((await call(ctx, agent, 'stat', { path: 'file.txt' })).isError, true)
      assert.deepEqual((await assemble(ctx, agent)).tools.map(tool => tool.name), [DISCOVER], 'diagnostic/current-step assembly cannot activate')
      assert.equal(fs.readFileSync(path.join(dir, 'file.txt'), 'utf8'), 'unchanged')
      await nextStep(ctx, agent)
      assert.deepEqual((await assemble(ctx, agent)).tools.map(tool => tool.name).sort(), [DISCOVER, publicToolName('stat')].sort())
      assert.deepEqual(first.tools.map(tool => tool.name), [DISCOVER], 'previous assembly is immutable with respect to later registration')
      const result = await call(ctx, agent, 'stat', { path: 'file.txt' })
      assert.equal(result.isError, false)
      assert.equal(result.value.bytes, 9)
      assert.equal(result.value.status, 'completed')
    } finally { await shutdown(ctx) }
  }))
  await test('activation stays in its owning scope, including across parent-child inheritance', () => withTempDir('discovery', async dir => {
    const { ctx } = await boot()
    try {
      const parent = await mint(ctx, 'discovery-parent', dir)
      const sibling = await mint(ctx, 'discovery-sibling', dir)
      const child = await mint(ctx, 'discovery-child', dir, parent)
      await call(ctx, parent, 'discover_tools', { query: 'select:ops_stat' })
      await nextStep(ctx, parent)
      for (const other of [sibling, child]) {
        assert.equal(scopedToolNames(ctx, other).includes(publicToolName('stat')), false)
        assert.equal((await call(ctx, other, 'stat', { path: 'any' })).isError, true)
      }
      const cached = ctx.get('tools').get(publicToolName('stat'), parent)
      const foreign = await cached.execute({ path: 'any' }, { agent: child, signal: new AbortController().signal })
      assert.equal(foreign.status, 'rejected')
      await call(ctx, child, 'discover_tools', { query: 'select:ops_diff' })
      await nextStep(ctx, child)
      assert.equal(scopedToolNames(ctx, parent).includes(publicToolName('diff')), false)
      assert.equal(scopedToolNames(ctx, child).includes(publicToolName('diff')), true)
    } finally { await shutdown(ctx) }
  }))
  await test('allowed pool and per-call limits cannot activate unavailable or unselected capabilities', () => withTempDir('discovery', async dir => {
    const { ctx } = await boot({ allowedTools: ['stat', 'diff', 'copy'], maxResults: 1 })
    try {
      const agent = await mint(ctx, 'discovery-pool', dir)
      for (const query of ['select:ops_read_pdf', 'select:ops_remove', 'nonsense']) {
        const result = await call(ctx, agent, 'discover_tools', { query })
        assert.deepEqual(result.value.activated, [])
      }
      const result = await call(ctx, agent, 'discover_tools', { query: 'file content metadata', max_results: 5 })
      assert.equal(result.value.activated.length, 1)
      await nextStep(ctx, agent)
      assert.equal(scopedToolNames(ctx, agent).length, 2)
    } finally { await shutdown(ctx) }
  }))
  await test('disabling only the entry preserves always-loaded choices; unloading removes all ownership', () => withTempDir('discovery', async dir => {
    const { ctx, fiber } = await boot({ enabled: false, allowedTools: ['stat'], alwaysLoaded: ['stat'] })
    try {
      const agent = await mint(ctx, 'discovery-always', dir)
      assert.deepEqual(scopedToolNames(ctx, agent), [publicToolName('stat')])
      const stale = ctx.get('tools').get(publicToolName('stat'), agent)
      await fiber.dispose()
      assert.deepEqual(scopedToolNames(ctx, agent), [])
      const value = await stale.execute({ path: '.' }, { agent, signal: new AbortController().signal })
      assert.equal(value.status, 'rejected')
    } finally { await shutdown(ctx) }
  }))
  await test('read-only scopes cannot discover mutations and live authority changes withdraw them', () => withTempDir('discovery', async dir => {
    const { ctx } = await boot()
    try {
      const readOnly = await mint(ctx, 'discovery-read-only', dir, undefined, 'read-only')
      const writer = await mint(ctx, 'discovery-writer', dir)
      assert.deepEqual((await call(ctx, readOnly, 'discover_tools', { query: 'select:ops_write_file' })).value.activated, [])
      await call(ctx, readOnly, 'discover_tools', { query: 'select:ops_stat' })
      await call(ctx, writer, 'discover_tools', { query: 'select:ops_write_file' })
      await nextStep(ctx, writer)
      const stale = ctx.get('tools').get(publicToolName('write_file'), writer)
      assert.ok(stale)
      writer.session.mode = 'read-only'
      await ctx.serial('session/event', writer.session, { type: 'sandbox/mode', data: { mode: 'read-only' } })
      await waitFor(() => scopedToolNames(ctx, writer).includes(DISCOVER))
      assert.equal(scopedToolNames(ctx, writer).includes(publicToolName('write_file')), false)
      const result = await stale.execute({ path: 'new.txt', content: 'blocked', expectedRevision: 'absent' }, { agent: writer, signal: new AbortController().signal })
      assert.equal(result.status, 'rejected')
      assert.equal(fs.existsSync(path.join(dir, 'new.txt')), false)
      assert.ok(scopedToolNames(ctx, readOnly).includes(DISCOVER))
      await nextStep(ctx, readOnly)
      assert.ok(scopedToolNames(ctx, readOnly).includes(publicToolName('stat')), 'another session change must not discard this pending activation')
    } finally { await shutdown(ctx) }
  }))
  await test('agent disposal discards both pending and active capabilities', () => withTempDir('discovery', async dir => {
    const { ctx } = await boot()
    try {
      const agent = await mint(ctx, 'discovery-disposed', dir)
      await call(ctx, agent, 'discover_tools', { query: 'select:ops_stat' })
      await nextStep(ctx, agent)
      await call(ctx, agent, 'discover_tools', { query: 'select:ops_diff' })
      await ctx.serial('agent/disposed', { agent })
      assert.deepEqual(scopedToolNames(ctx, agent), [])
    } finally { await shutdown(ctx) }
  }))
  await test('discovery and PTC publication converge without rebuilding unchanged scoped tools', () => withTempDir('discovery', async dir => {
    const { ctx } = await boot()
    try {
      ctx.provide('ptcRuntime', { language: 'typescript' })
      await ctx.plugin(ptc, { required: true })
      const native = await mint(ctx, 'discovery-coexist-native', dir)
      const code = await mint(ctx, 'discovery-coexist-ptc', dir)
      const lift = code.ctx.tools.presentAs('ptc')
      await waitFor(() => scopedToolNames(ctx, code).includes(publicToolName('load_sdk')) && scopedToolNames(ctx, native).includes(DISCOVER))
      await call(ctx, native, 'discover_tools', { query: 'select:ops_stat' })
      await nextStep(ctx, native)
      await waitFor(() => scopedToolNames(ctx, code).includes(publicToolName('load_sdk')))
      const stable = ctx.get('tools').get(DISCOVER, native)
      for (let i = 0; i < 3; i++) await assemble(ctx, code)
      assert.equal(ctx.get('tools').get(DISCOVER, native), stable)
      assert.equal(scopedToolNames(ctx, code).includes(publicToolName('stat')), false)
      lift()
    } finally { await shutdown(ctx) }
  }))
  await test('a separate PTC adapter keeps ownership of its same-scope kernel definitions', () => withTempDir('discovery', async dir => {
    const { ctx } = await boot()
    try {
      ctx.provide('ptcRuntime', { language: 'typescript' })
      const native = await mint(ctx, 'discovery-sdk-native', dir)
      const code = await mint(ctx, 'discovery-sdk-code', dir)
      code.ctx.tools.presentAs('ptc')
      const adapter = definition('stat', async () => ({ status: 'completed', owner: 'ptc-adapter' }))
      const dispose = code.ctx.tools.register(adapter)
      const assembly = await assemble(ctx, code)
      assert.deepEqual(assembly.tools.map(tool => tool.name), ['run_code'])
      assert.equal(ctx.get('tools').get(publicToolName('stat'), code), adapter)
      assert.ok(assembly.sections.some(section => section.text.includes(publicToolName('stat'))))
      assert.equal(scopedToolNames(ctx, code).includes(DISCOVER), false)
      assert.ok(scopedToolNames(ctx, native).includes(DISCOVER))
      await call(ctx, native, 'discover_tools', { query: 'select:ops_stat' })
      await nextStep(ctx, native)
      assert.equal(ctx.get('tools').get(publicToolName('stat'), code), adapter)
      dispose()
    } finally { await shutdown(ctx) }
  }))
  await test('pure PTC presentation withdraws Native discovery and advanced registrations', () => withTempDir('discovery', async dir => {
    const { ctx } = await boot()
    try {
      const agent = await mint(ctx, 'discovery-mode', dir)
      await call(ctx, agent, 'discover_tools', { query: 'select:ops_stat' })
      await nextStep(ctx, agent)
      ctx.provide('ptcRuntime', { language: 'typescript' })
      const cached = ctx.get('tools').get(publicToolName('stat'), agent)
      const lift = agent.ctx.tools.presentAs('ptc')
      const immediate = assemble(ctx, agent)
      const cachedCall = cached.execute({ path: '.' }, { agent, signal: new AbortController().signal })
      const immediateResult = await immediate
      assert.ok(immediateResult.sections.every(section => !section.text.includes(publicToolName('stat'))), 'immediate PTC assembly must not expose a stale Native SDK')
      assert.equal((await cachedCall).status, 'rejected', 'cached Native definitions cannot execute during withdrawal')
      await waitFor(() => !scopedToolNames(ctx, agent).includes(DISCOVER))
      const result = await assemble(ctx, agent)
      assert.deepEqual(result.tools.map(tool => tool.name), ['run_code'])
      assert.ok(result.sections.every(section => !section.text.includes(publicToolName('stat'))))
      lift()
      await waitFor(() => scopedToolNames(ctx, agent).includes(DISCOVER))
      assert.ok(scopedToolNames(ctx, agent).includes(publicToolName('stat')))
    } finally { await shutdown(ctx) }
  }))
}

export { boot as bootDiscoveryHost, mint as mintDiscoveryAgent, nextStep as discoveryNextStep }
