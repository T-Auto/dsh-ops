/** D5 (#989): the settings-page choice reaches the real first round, end to end.
 *
 * The chain is the production one, twice over: the disclosure card's write
 * operations go through the real host settings writer (profileFixture) and
 * persist to the profile's cordis.patch.yml; the saved value then boots a
 * fresh OPS-PTC session through the shipped apply with the real native
 * worker, where the assertions read the settled first-round surface and run
 * one real binding call. The full leg proves the first program can call the
 * permitted business APIs with no loader; the untouched old profile keeps
 * the two-step on-demand path letter for letter; switching the tier between
 * saves applies to the next session.
 */
import { createScope, scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import fs from 'node:fs'
import path from 'node:path'
import { apply } from '../lib/index.js'
import { disclosureOps } from '../lib/client/row-schema.js'
import { profileFixture } from './lib/settings-profile.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { prepareStep, executeCall, selectExecutor } from './lib/executor.mjs'
import { assert, test, report, wait, waitFor, withTempDir } from './lib/harness.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'

requireWorker('settings-disclosure-e2e')

let sequence = 0
const names = (ctx, agent) => ctx.get('tools').definitions(agent, agent.prepared?.toolSet).map(tool => tool.name).sort()
const opsNames = (ctx, agent) => names(ctx, agent).filter(name => name.startsWith('ops_'))

/** One turn boundary, the way the loop issues it. */
async function step(ctx, agent) {
  ctx.emit('session/event', agent.session, { type: 'step/end', turn: 1, step: ++sequence })
  agent.prepared?.dispose(); agent.prepared = await prepareStep(ctx, agent)
}

async function scoped(parent, key, parentKey) {
  let result
  await parent.plugin({ inject: ['tools'], apply(inner) {
    result = createScope(inner, key, parentKey ? { parent: parentKey } : undefined).ctx
  } })
  return result
}

/** A saved settings value for an ops-ptc-only deployment of the merged row. */
const savedBase = () => ({
  global: {},
  discovery: { binaryPath: WORKER, required: true },
  minimal: { enabled: false }, standard: { enabled: false }, ptc: { enabled: false }, cordis: { enabled: false },
  'ops-ptc': { enabled: true, binaryPath: WORKER, required: true, allowedTools: ['grep', 'stat'] },
})

/**
 * The real settings writer for one profile; the card's saves go through it.
 *
 * `value()` is the host settings view (the editable surface, volatile keys
 * only); `applied()` is the config the loader hands the row after the save —
 * the profile layers merged, YAML-only keys (the `allowedTools` cap, the
 * worker path) included. Sessions boot from `applied()` because that is the
 * production chain; the settings view alone would silently drop the pool cap.
 */
async function writer(label, base) {
  let applied
  const fixture = await profileFixture(label, {
    Config: (await import('../lib/settings/merged.js')).Config, apply(_ctx, config) { applied = config },
  }, base)
  return {
    value: () => fixture.snapshot().value,
    applied: () => applied,
    save: async operations => {
      const snapshot = fixture.snapshot()
      await fixture.mutate(operations, snapshot.revision)
      await fixture.ctx.loader.await()
      return fixture.snapshot().value
    },
    close: () => shutdown(fixture.ctx),
  }
}

/** Boot the shipped merged row from a saved settings value, then one session. */
async function session(saved, cwd) {
  const { ctx } = await bootHost({ withWorkingDirectory: true })
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem); await ctx.plugin(NodePtc)
  ctx.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: session?.mode ?? 'danger-full-access', workspaceRoot: cwd, sessionId: session?.id }) })
  const presets = new Map(), agents = []
  ctx.provide('agents', { list: () => [...agents] })
  ctx.provide('agentPresets', { composedPreset: inner => presets.get(scopeParentOf(scopeOf(inner))) })
  await ctx.plugin({ name: 'disclosure-e2e-fixture', apply: inner => apply(inner, saved) })
  const id = 'disclosure-' + ++sequence, preset = await scoped(ctx, { preset: id })
  presets.set(scopeOf(preset), 'ops-ptc')
  for (const name of ['read', 'glob', 'grep']) preset.tools.register({ name, description: name,
    parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) })
  const agent = { id, session: { id, mode: 'danger-full-access', header: { cwd }, append() {}, read() { return [] } } }
  agent.ctx = await scoped(preset, agent, scopeOf(preset))
  await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply: inner => { selectExecutor(inner, 'ptc') } })
  agents.push(agent)
  await ctx.serial('agent/created', { agent })
  await step(ctx, agent)
  return { ctx, agent }
}

/** One real run_code program through the prepared step, as the loop issues it. */
async function program(ctx, agent, code, label) {
  const result = await executeCall(ctx, { agent, toolSet: agent.prepared.toolSet, name: 'run_code',
    arguments: { description: label, code }, callId: 'disclosure-' + ++sequence, signal: new AbortController().signal })
  assert.equal(result.isError, false, JSON.stringify(result))
  return result.value.result
}

/** Wait for the first round to settle, then return its ops_* names. */
async function settled(ctx, agent, anchor) {
  await waitFor(() => opsNames(ctx, agent).includes(anchor), { what: anchor + ' published' })
  await wait(100)
  return opsNames(ctx, agent)
}

/** The on-demand first round: resident inspect plus the loader, nothing else. */
const ON_DEMAND_FIRST = ['ops_inspect_local_file', 'ops_load_sdk']
/** The full first round for allowedTools=[grep,stat]: the pool plus result, no loader. */
const FULL_FIRST = ['ops_grep', 'ops_inspect_local_file', 'ops_result', 'ops_stat']

await test('a full choice saved through the real writer boots a loader-less first round', () => withTempDir('disclosure-full', async cwd => {
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'needle in haystack\nplain second line\n')
  const store = await writer('disclosure-e2e-full', savedBase())
  try {
    assert.equal('disclosurePolicy' in store.value()['ops-ptc'], false, 'the profile starts old: no key')
    // Exactly the operations the card's save submits, through the real host writer.
    const stored = await store.save(disclosureOps(store.value(), 'full'))
    assert.equal(stored.ptc.disclosurePolicy, 'full')
    assert.equal(stored['ops-ptc'].disclosurePolicy, 'full')
    // The save keeps the YAML-only pool cap the tier must never widen (#989).
    assert.deepEqual(store.applied()['ops-ptc'].allowedTools, ['grep', 'stat'])
    const { ctx, agent } = await session(store.applied(), cwd)
    try {
      assert.deepEqual(await settled(ctx, agent, 'ops_grep'), FULL_FIRST, 'the whole permitted pool in the first round')
      assert.equal(opsNames(ctx, agent).includes('ops_load_sdk'), false, 'the full tier publishes no loader')
      const value = await program(ctx, agent, "const stat = await tools.ops_stat({ path: 'fixture.txt' })\n"
        + "const grep = await tools.ops_grep({ pattern: 'needle', path: '.' })\n"
        + "return { statStatus: stat.status, grepStatus: grep.status, grepText: JSON.stringify(grep), loader: typeof tools.ops_load_sdk }",
        'First-program business calls')
      assert.equal(value.statStatus, 'completed', JSON.stringify(value))
      assert.equal(value.grepStatus, 'completed', JSON.stringify(value))
      assert.match(value.grepText, /needle/, 'the real worker answered the first-program call')
      assert.equal(value.loader, 'undefined')
    } finally { await shutdown(ctx) }
  } finally { await store.close() }
}))

await test('the untouched old profile keeps the two-step on-demand path', () => withTempDir('disclosure-on-demand', async cwd => {
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'needle in haystack\n')
  const store = await writer('disclosure-e2e-on-demand', savedBase())
  try {
    const stored = store.value()
    assert.equal('disclosurePolicy' in stored['ops-ptc'], false, 'an old profile is never migrated to full')
    const { ctx, agent } = await session(stored, cwd)
    try {
      assert.deepEqual(await settled(ctx, agent, 'ops_load_sdk'), ON_DEMAND_FIRST, 'resident plus loader, two steps before the pool')
      const value = await program(ctx, agent, "const picked = await tools.ops_load_sdk({ tools: ['grep', 'stat', 'result'] })\n"
        + "return { picked: picked.status, earlyGrep: typeof tools.ops_grep }", 'Load the business set')
      assert.equal(value.picked, 'completed', JSON.stringify(value))
      assert.equal(value.earlyGrep, 'undefined', 'a loaded API is callable only in the next program')
      await step(ctx, agent)
      await wait(100)
      assert.deepEqual(opsNames(ctx, agent).filter(name => name !== 'ops_load_sdk'), FULL_FIRST,
        'after the loader step the set equals the full first round')
    } finally { await shutdown(ctx) }
  } finally { await store.close() }
}))

await test('switching the tier between saves applies to the next session', () => withTempDir('disclosure-switch', async cwd => {
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'needle in haystack\n')
  const store = await writer('disclosure-e2e-switch', savedBase())
  try {
    await store.save(disclosureOps(store.value(), 'full'))
    const first = await session(store.applied(), cwd)
    try {
      assert.deepEqual(await settled(first.ctx, first.agent, 'ops_grep'), FULL_FIRST, 'the full save reaches the session')
    } finally { await shutdown(first.ctx) }
    const back = await store.save(disclosureOps(store.value(), 'on-demand'))
    assert.equal('disclosurePolicy' in back.ptc, false, 'switching back returns to the absent default')
    assert.equal('disclosurePolicy' in back['ops-ptc'], false)
    const second = await session(store.applied(), cwd)
    try {
      assert.deepEqual(await settled(second.ctx, second.agent, 'ops_load_sdk'), ON_DEMAND_FIRST, 'the next session runs the new tier')
      const value = await program(second.ctx, second.agent, "return { loader: typeof tools.ops_load_sdk, grep: typeof tools.ops_grep }", 'Probe the switched surface')
      assert.equal(value.loader, 'function')
      assert.equal(value.grep, 'undefined', 'the pool is back behind the loader')
    } finally { await shutdown(second.ctx) }
  } finally { await store.close() }
}))

report('settings-disclosure-e2e')
