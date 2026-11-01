/** Real host/PTC loader integration; no native file operation is exercised by this suite. */
import { createScope } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import { mountPtc } from '../lib/publication/ptc.js'
import { publicToolName } from '../lib/policy.js'
import { isPresentationProbe } from '../lib/publication/presentation.js'
import { renderSdkDirectory } from '../lib/projections/ptc/directory.js'
import { assert, test, report, waitFor, withTempDir } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'

let sequence = 0
const loader = publicToolName('load_sdk')
const section = 'dsh-ops:repository-tooling:mode-ptc'
const step = (ctx, agent) => ctx.waterfall('agent/pre-step', {
  agent, messages: [], turn: 1, step: ++sequence, signal: new AbortController().signal,
}, () => Promise.resolve({ kind: 'continue' }))
const text = async (ctx, agent) => (await ctx.get('systemPrompt').assemble({ scope: agent })).sections
  .filter(row => row.name.startsWith(section)).map(row => row.text).join('\n')
const hasEntry = (text, raw) => text.includes(`- ${raw}: `)
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
  // Explicit existing executable only satisfies publication resolution. Native
  // work is never dispatched: these tests assert the real Node loader/snapshot.
  const mount = () => ctx.plugin({ name: 'ptc-directory-fixture', apply(inner) {
    mountPtc(inner, { binaryPath: process.execPath, required: true, ...config }, gate)
  } })
  const component = await mount()
  const mint = async (mode = 'ptc') => {
    const id = 'directory-' + ++sequence
    const agent = { id, session: { id, mode: 'danger-full-access', header: { cwd: root }, append() {}, read() { return [] } } }
    agent.ctx = createScope(ctx, agent).ctx
    agent.presentation = await agent.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.presentAs(mode) } })
    agents.push(agent)
    await ctx.serial('agent/created', { agent })
    return agent
  }
  return { ctx, component, mint, mount, state }
}
async function code(ctx, agent, body) {
  const result = await ctx.get('tools').execute({ name: 'run_code', callId: 'directory-call-' + ++sequence,
    agent, signal: new AbortController().signal, arguments: { description: 'Exercise PTC SDK selection', code: body } })
  assert.equal(result.isError, false, JSON.stringify(result))
  return result.value.result
}

await test('directory derives PTC metadata, omits callable entries and names only actual loader APIs', () => {
  assert.equal(renderSdkDirectory([], new Set()), '')
  assert.equal(renderSdkDirectory(['grep'], new Set([publicToolName('grep')])), '')
  const value = renderSdkDirectory(['grep', 'batch'], new Set())
  assert.ok(hasEntry(value, 'grep')); assert.ok(hasEntry(value, 'batch'))
  assert.match(value, /tools\.ops_load_sdk\(\{tools:/)
  assert.match(value, /next model step/); assert.match(value, /resident\/callable/)
  assert.match(value, /No matching entry/); assert.match(value, /grants no permission/)
  assert.doesNotMatch(value, /discover_tools|select:|authorize\(/)
})
await test('actual assembly and Node PTC dispatch preserve next-step selection and two-agent isolation', () => withTempDir('ptc-directory', async root => {
  const { ctx, mint } = await setup(root, { allowedTools: ['grep', 'stat'], alwaysLoaded: ['stat'] })
  try {
    const a = await mint(), b = await mint(), native = await mint('native'), both = await mint('both')
    const prompt = ctx.get('systemPrompt'), assemble = prompt.assemble.bind(prompt)
    let probes = 0, events = 0, spawns = 0
    prompt.assemble = context => { if (isPresentationProbe(context)) probes++; return assemble(context) }
    ctx.on('tools/change', () => { events++ })
    const subprocess = ctx.get('subprocess'), spawn = subprocess.spawn
    subprocess.spawn = function (...args) { spawns++; return spawn.apply(this, args) }
    try {
      const first = await text(ctx, a)
      assert.ok(hasEntry(first, 'grep')); assert.equal(hasEntry(first, 'stat'), false)
      assert.equal(hasEntry(first, 'batch'), false); assert.equal(hasEntry(first, 'inspect_local_file'), false)
      assert.equal(await text(ctx, native), ''); assert.equal(await text(ctx, both), '')
      const frozen = { probes, events, spawns }
      for (let i = 0; i < 6; i++) await text(ctx, a)
      assert.deepEqual({ probes, events, spawns }, frozen, 'directory assembly adds no probes, registry feedback or process work')
      const selected = await code(ctx, a, `const invalid = await tools.${loader}({tools:['batch']});
        const loaded = await tools.${loader}({tools:['grep']});
        return {invalid,loaded,callable:typeof tools.${publicToolName('grep')}==='function'};`)
      assert.equal(selected.invalid.error.code, 'INVALID_ARGUMENT')
      assert.equal(selected.loaded.status, 'completed'); assert.equal(selected.loaded.data.nextTurn, true)
      assert.equal(selected.callable, false)
      assert.ok(hasEntry(await text(ctx, a), 'grep'), 'assembly cannot commit the pending request')
      await ctx.serial('session/event', a.session, { type: 'step/end' })
      const after = await text(ctx, a)
      assert.equal(hasEntry(after, 'grep'), false)
      assert.doesNotMatch(after, /On-demand PTC SDK directory/, 'all eligible names already callable: no directory')
      assert.ok(hasEntry(await text(ctx, b), 'grep'))
      assert.equal(await code(ctx, a, `return typeof tools.${publicToolName('grep')}==='function';`), true)
      assert.equal(await code(ctx, b, `return typeof tools.${publicToolName('grep')}==='function';`), false)
      assert.equal(Object.hasOwn(ctx.get('tools'), 'register'), false)
    } finally { prompt.assemble = assemble; subprocess.spawn = spawn }
  } finally { await shutdown(ctx) }
}))
for (const allowedTools of [[], ['stat'], ['read_files']]) {
  await test('resident=false honors configured pool ' + JSON.stringify(allowedTools) + ' plus result only', () => withTempDir('ptc-directory-nonresident', async root => {
    const { ctx, mint } = await setup(root, { allowedTools }, { allows: () => true, resident: false })
    try {
      const agent = await mint(), eligible = [...allowedTools, 'result']
      const blocked = ['inspect_local_file', 'read_files', 'grep'].filter(raw => !allowedTools.includes(raw))
      const directory = await text(ctx, agent)
      assert.deepEqual([...directory.matchAll(/^- (\w+): /gm)].map(match => match[1]), eligible)
      const def = ctx.get('tools').get(loader, agent)
      assert.ok(def.description.endsWith('Allowed raw names: ' + eligible.join(', ') + '.'))
      for (const raw of [...eligible, ...blocked]) assert.equal(ctx.get('tools').get(publicToolName(raw), agent), undefined)
      const selected = await code(ctx, agent, `const rejected = [];
        for (const raw of ${JSON.stringify(blocked)}) rejected.push(await tools.${loader}({tools:[raw]}));
        const loaded = await tools.${loader}({tools:${JSON.stringify(eligible)}});
        return {rejected,loaded,callable:${JSON.stringify(eligible.map(publicToolName))}.map(name=>typeof tools[name]==='function')};`)
      for (const rejection of selected.rejected) assert.equal(rejection.error.code, 'INVALID_ARGUMENT')
      assert.equal(selected.loaded.status, 'completed'); assert.equal(selected.loaded.data.nextTurn, true)
      assert.deepEqual(selected.loaded.data.tools, eligible)
      assert.deepEqual(selected.callable, eligible.map(() => false), 'selection does not change the current SDK snapshot')
      assert.deepEqual(await text(ctx, agent), directory, 'assembly does not commit selection')
      await step(ctx, agent)
      assert.doesNotMatch(await text(ctx, agent), /On-demand PTC SDK directory/)
      assert.deepEqual(await code(ctx, agent, `return ${JSON.stringify(eligible.map(publicToolName))}.map(name=>typeof tools[name]==='function');`), eligible.map(() => true))
      for (const raw of blocked) assert.equal(ctx.get('tools').get(publicToolName(raw), agent), undefined, raw + ' stays unpublished')
    } finally { await shutdown(ctx) }
  }))
}
await test('resident-on empty dynamic pool preserves ordinary resident SDK baseline', () => withTempDir('ptc-directory-resident', async root => {
  const { ctx, mint } = await setup(root, { allowedTools: [] })
  try {
    const agent = await mint()
    assert.doesNotMatch(await text(ctx, agent), /On-demand PTC SDK directory/)
    assert.deepEqual(await code(ctx, agent, `return ${JSON.stringify(['inspect_local_file', 'result', 'read_files'].map(publicToolName))}.map(name=>typeof tools[name]==='function');`), [true, true, false])
    const rejected = await code(ctx, agent, `return await tools.${loader}({tools:['read_files']});`)
    assert.equal(rejected.error.code, 'INVALID_ARGUMENT')
  } finally { await shutdown(ctx) }
}))
await test('disabled and empty pools do not advertise loading; availability and read-only filter the real allowed pool', () => withTempDir('ptc-directory-policy', async root => {
  const { ctx, mint, state } = await setup(root, { allowedTools: ['grep', 'write_file', 'batch'] })
  try {
    const agent = await mint()
    assert.ok(hasEntry(await text(ctx, agent), 'write_file'))
    agent.session.mode = 'read-only'
    await ctx.serial('session/event', agent.session, { type: 'sandbox/mode' })
    const readonly = await text(ctx, agent)
    assert.ok(hasEntry(readonly, 'grep')); assert.equal(hasEntry(readonly, 'write_file'), false); assert.equal(hasEntry(readonly, 'batch'), false)
    const def = ctx.get('tools').get(loader, agent)
    assert.doesNotMatch(def.description, /Allowed raw names:.*write_file/)
    const denied = await def.execute({ tools: ['write_file'] }, { agent, signal: new AbortController().signal })
    assert.equal(denied.error.code, 'INVALID_ARGUMENT')
    state.available = false
    assert.doesNotMatch(await text(ctx, agent), /On-demand PTC SDK directory/)
    state.available = true
    assert.ok(hasEntry(await text(ctx, agent), 'grep'))
  } finally { await shutdown(ctx) }
  for (const [config, gate] of [[{ allowedTools: [] }, { allows: () => true }], [{}, { allows: () => true, dynamic: false }]]) {
    const host = await setup(root, config, gate)
    try {
      const agent = await host.mint()
      assert.doesNotMatch(await text(host.ctx, agent), /On-demand PTC SDK directory/)
      if (gate.dynamic === false) assert.equal(host.ctx.get('tools').get(loader, agent), undefined)
    } finally { await shutdown(host.ctx) }
  }
}))
await test('permission revocation before commit removes pending mutations, ownership withdrawal and reload refresh the directory', () => withTempDir('ptc-directory-lifecycle', async root => {
  let permitted = true, notify
  const gate = { allows: () => permitted, watch(callback) { notify = callback; return () => { notify = undefined } } }
  const { ctx, component, mint, mount } = await setup(root, { allowedTools: ['grep', 'write_file'] }, gate)
  try {
    const agent = await mint(), sibling = await mint()
    const retained = ctx.get('tools').get(loader, agent)
    await retained.execute({ tools: ['write_file'] }, { agent, signal: new AbortController().signal })
    agent.session.mode = 'read-only' // revocation even without a sandbox event
    await step(ctx, agent)
    assert.equal(ctx.get('tools').get(publicToolName('write_file'), agent), undefined)
    assert.equal(hasEntry(await text(ctx, agent), 'write_file'), false)
    permitted = false; notify()
    assert.equal(await text(ctx, agent), '')
    await waitFor(() => ctx.get('tools').get(loader, agent) === undefined)
    assert.equal((await retained.execute({ tools: ['grep'] }, { agent, signal: new AbortController().signal })).error.code, 'POLICY_DENIED')
    permitted = true; notify(); await step(ctx, sibling)
    assert.ok(hasEntry(await text(ctx, sibling), 'grep'))
    await sibling.presentation.dispose()
    sibling.presentation = await sibling.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.presentAs('native') } })
    assert.equal(await text(ctx, sibling), '', 'withdrawal assembly must remove stale PTC guidance')
    await component.dispose()
    assert.equal(await text(ctx, agent), '')
    const reloaded = await mount()
    await waitFor(() => ctx.get('tools').get(loader, agent) !== undefined)
    assert.ok(hasEntry(await text(ctx, agent), 'grep'))
    const assembly = await ctx.get('systemPrompt').assemble({ scope: agent })
    assert.equal(assembly.sections.filter(row => row.name.startsWith(section) && row.text).length, 1)
    await ctx.serial('agent/disposed', { agent })
    assert.equal(await text(ctx, agent), '')
    await reloaded.dispose()
  } finally { await shutdown(ctx) }
}))
await test('nearer scoped config replaces only its agents directory and unload restores the outer pool', () => withTempDir('ptc-directory-scope', async root => {
  const { ctx, mint } = await setup(root, { allowedTools: ['grep'] })
  try {
    const owner = await mint(), other = await mint()
    const nearer = await owner.ctx.plugin({ name: 'scoped-directory-fixture', apply(inner) {
      mountPtc(inner, { binaryPath: process.execPath, required: true, allowedTools: ['stat'] })
    } })
    await waitFor(() => ctx.get('tools').get(loader, owner)?.description.includes('Allowed raw names: stat.'))
    assert.ok(hasEntry(await text(ctx, owner), 'stat'))
    assert.equal(hasEntry(await text(ctx, owner), 'grep'), false)
    assert.ok(hasEntry(await text(ctx, other), 'grep'))
    assert.equal(hasEntry(await text(ctx, other), 'stat'), false)
    await nearer.dispose()
    await waitFor(() => ctx.get('tools').get(loader, owner)?.description.includes('Allowed raw names: grep.'))
    assert.ok(hasEntry(await text(ctx, owner), 'grep'))
    assert.equal(hasEntry(await text(ctx, owner), 'stat'), false)
  } finally { await shutdown(ctx) }
}))
await test('unavailable worker and guidance-disabled row cannot advertise a directory', () => withTempDir('ptc-directory-unavailable', async root => {
  for (const [config, gate] of [[{ binaryPath: root + '/missing-worker', required: false }, { allows: () => true }], [{}, { allows: () => true, guidance: false }]]) {
    const { ctx, mint } = await setup(root, config, gate)
    try {
      const agent = await mint()
      assert.equal(await text(ctx, agent), '')
      if (config.required === false) assert.equal(ctx.get('tools').get(loader, agent), undefined)
    } finally { await shutdown(ctx) }
  }
}))
report('ptc-directory')
