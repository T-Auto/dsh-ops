/** Real registry ownership transfer when an earlier preset takes over Bash (#489). */
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { createScope } from '@deepseek-ai/dsh-scope'
import { mountSessionBash } from '../lib/session-shells.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { assert, report, test, withTempDir } from './lib/harness.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const settle = async () => { await tick(); await tick(); await tick() }
const fixture = { available: true, file: process.execPath, source: 'explicit', detail: 'publication-only fixture' }

async function setup(cwd) {
  const { ctx, tools } = await bootHost()
  await ctx.plugin(Subprocess)
  ctx.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: 'danger-full-access', workspaceRoot: cwd, sessionId: session.id }) })
  const modes = new Map(), agents = [], fibers = new Map(), warnings = []
  ctx.provide('agents', { list: () => agents })
  ctx.logger.exporter({ colors: 0, levels: { default: 4 }, export: message => warnings.push(message.args.map(String).join(' ')) })
  for (const mode of ['minimal', 'standard', 'ptc', 'cordis']) {
    fibers.set(mode, await ctx.plugin({ inject: ['tools'], apply(inner) {
      mountSessionBash(inner, { publishBashTool: true }, { bash: fixture }, { allows: agent => modes.get(agent) === mode })
    } }))
  }
  const mint = async (id, mode) => {
    const agent = { id, session: { id, header: { cwd } } }
    await ctx.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
    modes.set(agent, mode); agents.push(agent)
    await ctx.serial('agent/created', { agent, source: 'startup' })
    await settle()
    return agent
  }
  const select = async (agent, mode) => {
    modes.set(agent, mode)
    ctx.emit('session/event', agent.session, { type: 'agent-preset/selected', data: { agentPreset: mode } })
    await settle()
  }
  return { ctx, tools, mint, select, fibers, warnings }
}

await test('PTC hands Bash to every earlier and later preset without duplicate registration', () => withTempDir('bash-preset-handoff', async cwd => {
  const { ctx, tools, mint, select, warnings } = await setup(cwd)
  try {
    const owner = await mint('switching', 'ptc')
    assert.ok(tools.get('ops_bash', owner), 'PTC starts with a published Bash')
    for (const mode of ['cordis', 'ptc', 'standard', 'ptc', 'minimal', 'cordis', 'standard', 'ptc']) {
      await select(owner, mode)
      assert.ok(tools.get('ops_bash', owner), `Bash must be published after selecting ${mode}: ${warnings.join('; ')}`)
      const assembly = await ctx.systemPrompt.assemble({ scope: owner, agent: owner })
      assert.ok(assembly.tools.some(tool => tool.name === 'ops_bash'), `the provider snapshot includes Bash for ${mode}`)
    }
    assert.equal(warnings.some(line => /publication failed|restoration failed/.test(line)), false, warnings.join('\n'))
  } finally { await shutdown(ctx) }
}))

await test('handoff retires old callbacks and old-owner disposal cannot remove the successor', () => withTempDir('bash-preset-retire', async cwd => {
  const { ctx, tools, mint, select, fibers } = await setup(cwd)
  try {
    const owner = await mint('retiring', 'ptc')
    const old = tools.get('ops_bash', owner)
    await select(owner, 'standard')
    const current = tools.get('ops_bash', owner)
    assert.ok(current); assert.notEqual(current, old)
    const subprocess = ctx.get('subprocess'), spawn = subprocess.spawn.bind(subprocess)
    let spawns = 0
    subprocess.spawn = (...args) => { ++spawns; return spawn(...args) }
    const denied = await old.execute({ command: 'echo MUST_NOT_RUN', description: 'Check revoked callback' }, { agent: owner, signal: new AbortController().signal })
    assert.equal(denied.status, 'failed')
    assert.equal(spawns, 0, 'a stale callback cannot launch any process')
    assert.equal(denied.stdout.text, '')
    await fibers.get('ptc').dispose(); await settle()
    assert.equal(tools.get('ops_bash', owner), current, 'retired publisher cleanup preserves its successor')
    await select(owner, 'unlisted')
    assert.equal(tools.get('ops_bash', owner), undefined, 'an ineligible preset receives no Bash')
    await select(owner, 'standard')
    assert.ok(tools.get('ops_bash', owner), 'returning to an eligible preset restores Bash')
  } finally { await shutdown(ctx) }
}))

await test('returning to the original preset does not revive its retained Bash callback', () => withTempDir('bash-preset-roundtrip', async cwd => {
  const { ctx, tools, mint, select } = await setup(cwd)
  try {
    const owner = await mint('roundtrip', 'ptc'), old = tools.get('ops_bash', owner)
    await select(owner, 'standard'); await select(owner, 'ptc')
    assert.notEqual(tools.get('ops_bash', owner), old)
    const subprocess = ctx.get('subprocess'), spawn = subprocess.spawn.bind(subprocess)
    let spawns = 0
    subprocess.spawn = (...args) => { ++spawns; return spawn(...args) }
    const denied = await old.execute({ command: 'echo MUST_NOT_RUN', description: 'Check retired publication' }, { agent: owner, signal: new AbortController().signal })
    assert.equal(denied.status, 'failed')
    assert.equal(spawns, 0, 'reselecting a preset cannot reactivate its retired callback')
  } finally { await shutdown(ctx) }
}))

await test('a preset that does not own Bash never attempts a restriction it cannot apply', () => withTempDir('bash-preset-boundary', async cwd => {
  const { ctx, tools, mint, select, warnings } = await setup(cwd)
  try {
    const owner = await mint('boundary', 'ptc')
    assert.ok(tools.get('ops_bash', owner))
    warnings.length = 0
    await select(owner, 'standard')
    assert.ok(tools.get('ops_bash', owner), 'the eligible preset still publishes Bash')
    const boundary = warnings.filter(line => line.includes('inherited bash restriction failed'))
    assert.deepEqual(boundary, [], 'a scope-local Bash is not a global tool to mask')
  } finally { await shutdown(ctx) }
}))

await test('handoff never withdraws an unrelated same-name provider', () => withTempDir('bash-preset-foreign', async cwd => {
  const { ctx, tools, mint, select } = await setup(cwd)
  try {
    const owner = await mint('foreign', 'unlisted')
    const foreign = { name: 'ops_bash', description: 'Independent provider fixture', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({ foreign: true }) }
    let release
    await owner.ctx.plugin({ inject: ['tools'], apply(inner) { release = inner.tools.register(foreign) } })
    const visible = tools.get('ops_bash', owner)
    await select(owner, 'standard')
    assert.equal(tools.get('ops_bash', owner), visible, 'a foreign registration is never retired for OPS')
    release()
  } finally { await shutdown(ctx) }
}))

report('shells-preset-handoff')
