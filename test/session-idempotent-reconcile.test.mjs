/**
 * Session bash layers stay idempotent under concurrency and turn boundaries.
 *
 * The suite drives the real Cordis host, the real tool registry and the real
 * SessionStore append guard against `mountSessionBash`, covering #579, #842
 * and #873: two preset consumers may briefly both believe they own one agent,
 * a publication that lost a same-layer name conflict must not retry forever
 * or re-register the identical conflicting name, and a turn boundary
 * re-asserts authority so a new turn never starts on stale bash state.
 */
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { mountSessionBash } from '../lib/session-shells.js'
import { prepareStep } from './lib/executor.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { assert, test, report, TEST_HOME } from './lib/harness.mjs'

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)) }

/** The bash resolution one row publishes, as `mountSessionBash` accepts it. */
const layerOf = file => ({ bash: { available: true, file, source: 'explicit' } })

/** Boot the real host with the authority services the rows resolve through. */
async function setup() {
  const host = await bootHost()
  const agents = []
  host.ctx.provide('agents', { list: () => agents })
  host.agents = agents
  await host.ctx.plugin(inner => {
    inner.provide('subprocess', { spawn() { throw new Error('publication tests must not execute') } })
    inner.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: TEST_HOME }) })
  })
  return host
}

/** Mount one preset consumer row; its gate names the agents it serves. */
function mountRow(ctx, gate, file) {
  return ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) {
    mountSessionBash(inner, { publishBashTool: true }, layerOf(file), gate)
  } })
}

/** Bind a real session to a fresh agent the way the host creates one. */
function mint(ctx, session) {
  const agent = { id: session.id, session }
  agent.ctx = createScope(ctx, agent).ctx
  return agent
}

/** Register a foreign `ops_bash` in the agent's own layer, as another plugin would. */
async function registerForeign(agent) {
  let undo
  await agent.ctx.plugin({ inject: ['tools'], apply(inner) {
    undo = inner.tools.register({ name: 'ops_bash', description: 'foreign bash',
      parameters: { type: 'object' }, output: { schema: { type: 'string' }, render: () => [] },
      execute: async () => 'foreign' })
  } })
  return () => undo()
}

await test('two rows that both claim one agent converge without duplicate failures (#842)', async () => {
  const { ctx, tools, agents } = await setup()
  const warnings = []
  ctx.logger.warn = message => { warnings.push(String(message)) }
  const gateA = { allows: () => true }
  const gateB = { allows: () => true }
  try {
    await ctx.plugin(SessionStore)
    const rowA = await mountRow(ctx, gateA, process.execPath)
    await mountRow(ctx, gateB, 'Z:\\row-b-bash.exe')
    const session = ctx.get('sessions').create('contested', { meta: { cwd: TEST_HOME } })
    session.mode = 'danger-full-access'
    const agent = mint(ctx, session)
    agents.push(agent)
    await ctx.serial('agent/created', { agent }); await flush()
    assert.ok(tools.get('ops_bash', agent), 'the first row owns the bash layer')
    // Every pass while both gates allow must stand by instead of re-registering.
    session.append('sandbox/mode', { mode: session.mode }); await flush()
    session.append('sandbox/mode', { mode: session.mode }); await flush()
    assert.deepEqual(warnings.filter(w => /bash (publication|restoration) failed/.test(w)), [],
      'a contested agent never re-registers the name another of this plugin\'s rows already holds')
    // The owner unloads while the other row still claims the agent: only the
    // turn boundary can hand the layer over, without any mode event (#873).
    await rowA.dispose(); await flush()
    assert.equal(tools.get('ops_bash', agent), undefined, 'the owner\'s unload withdraws the contested layer')
    session.append('turn/start', { turn: 1 }); await flush()
    assert.ok(tools.get('ops_bash', agent), 'the turn boundary lets the standing row take over')
    assert.deepEqual(warnings.filter(w => /bash (publication|restoration) failed/.test(w)), [],
      'the whole contested lifecycle stays free of duplicate-registration failures')
  } finally { await shutdown(ctx) }
})

await test('a lost name conflict is reported once and recovers at the turn boundary (#579, #873)', async () => {
  const { ctx, tools, agents } = await setup()
  const warnings = []
  ctx.logger.warn = message => { warnings.push(String(message)) }
  const gate = { allows: () => true }
  try {
    await ctx.plugin(SessionStore)
    const row = await mountRow(ctx, gate, process.execPath)
    const session = ctx.get('sessions').create('conflict', { meta: { cwd: TEST_HOME } })
    session.mode = 'danger-full-access'
    const agent = mint(ctx, session)
    agents.push(agent)
    await ctx.serial('agent/created', { agent }); await flush()
    assert.ok(tools.get('ops_bash', agent), 'the layer is live before the conflict')
    // The owner withdraws; a foreign same-layer registration takes the name.
    gate.allows = () => false
    session.append('sandbox/mode', { mode: session.mode }); await flush()
    assert.equal(tools.get('ops_bash', agent), undefined, 'the owner withdrew')
    const undoForeign = await registerForeign(agent)
    gate.allows = () => true
    session.append('sandbox/mode', { mode: session.mode }); await flush()
    const conflicts = () => warnings.filter(w => /bash publication failed/.test(w)).length
    const restorations = () => warnings.filter(w => /bash restoration failed/.test(w)).length
    assert.equal(restorations(), 0, 'a same-name conflict never re-registers the identical conflicting name')
    assert.equal(conflicts(), 1, 'one lost conflict is reported once')
    // Passes at the same generation must not re-attempt the failed registration.
    session.append('sandbox/mode', { mode: session.mode }); await flush()
    session.append('sandbox/mode', { mode: session.mode }); await flush()
    assert.equal(conflicts(), 1, 'later passes do not storm the registry with the same failure')
    // A turn boundary retries: the conflicting foreign layer may be gone by then.
    undoForeign()
    session.append('turn/start', { turn: 1 }); await flush()
    assert.ok(tools.get('ops_bash', agent), 'the turn boundary republishes the lost layer')
    assert.deepEqual(warnings.filter(w => /append cannot reenter/.test(w)), [],
      'no reentry escapes into the host')
  } finally { await shutdown(ctx) }
})

await test('a turn boundary re-asserts bash authority without a mode event (#873)', async () => {
  const { ctx, tools, agents } = await setup()
  const warnings = []
  ctx.logger.warn = message => { warnings.push(String(message)) }
  try {
    await ctx.plugin(SessionStore)
    await mountRow(ctx, { allows: () => true }, process.execPath)
    const session = ctx.get('sessions').create('turn-boundary', { meta: { cwd: TEST_HOME } })
    session.mode = 'danger-full-access'
    const agent = mint(ctx, session)
    agents.push(agent)
    await ctx.serial('agent/created', { agent }); await flush()
    assert.ok(tools.get('ops_bash', agent), 'the layer is live under permissive authority')
    // Authority changed silently: the layer is stale until the next turn begins.
    session.mode = 'read-only'
    assert.ok(tools.get('ops_bash', agent), 'without an event nothing reconciles yet')
    session.append('turn/start', { turn: 1 }); await flush()
    assert.equal(tools.get('ops_bash', agent), undefined,
      'the turn boundary withdraws a layer whose authority is gone')
    // turn/end is a closing edge, not one that grants authority.
    session.mode = 'danger-full-access'
    session.append('turn/end', { turn: 1, reason: { kind: 'stop' } }); await flush()
    assert.equal(tools.get('ops_bash', agent), undefined, 'turn/end alone does not republish')
    session.append('turn/start', { turn: 2 }); await flush()
    assert.ok(tools.get('ops_bash', agent), 'the next turn boundary republishes under restored authority')
    // The first request of the new turn sees the tool the boundary just restored.
    const step = await prepareStep(ctx, agent)
    try {
      assert.ok(step.assembly.tools.some(tool => tool.name === 'ops_bash'),
        'the first request of the new turn includes ops_bash')
    } finally { step.dispose() }
    assert.deepEqual(warnings, [], 'the boundary repair reports no failure')
  } finally { await shutdown(ctx) }
})

await test('creating several agents inside append windows defers every layer and lands them all (#579)', async () => {
  const { ctx, tools, agents } = await setup()
  const warnings = []
  ctx.logger.warn = message => { warnings.push(String(message)) }
  try {
    await ctx.plugin(SessionStore)
    const component = await mountRow(ctx, { allows: () => true }, process.execPath)
    const session = ctx.get('sessions').create('burst', { meta: { cwd: TEST_HOME } })
    session.mode = 'danger-full-access'
    const created = []
    let writes = 0
    // A real registry notification appends a valid session event, as host observers can.
    ctx.on('tools/change', () => { session.append('turn/start', { turn: ++writes }) })
    ctx.on('session/event', (seen, event) => {
      if (seen !== session || event.type !== 'sandbox/mode') return
      assert.throws(() => session.append('turn/start', { turn: 99 }), /append cannot reenter/)
      const agent = mint(ctx, session)
      agents.push(agent)
      created.push(ctx.serial('agent/created', { agent }))
      return new Promise(resolve => setImmediate(resolve))
    })
    session.append('sandbox/mode', { mode: session.mode })
    session.append('sandbox/mode', { mode: session.mode })
    session.append('sandbox/mode', { mode: session.mode })
    await Promise.all(created); await flush()
    assert.equal(agents.length, 3, 'three agents were created inside append windows')
    for (const agent of agents) assert.ok(tools.get('ops_bash', agent), 'every deferred layer landed')
    assert.equal(writes, 3, 'each deferred publication appends exactly once, after its window')
    assert.deepEqual(warnings.filter(w => /failed|reenter/.test(w)), [], 'no failure escapes the burst')
    await component.dispose(); await flush()
    for (const agent of agents) assert.equal(tools.get('ops_bash', agent), undefined,
      'unload withdraws every deferred layer')
  } finally { await shutdown(ctx) }
})

report('session-idempotent-reconcile')
