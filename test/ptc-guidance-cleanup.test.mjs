/** P4 (#983): hiding official file tools must also retire guidance that still names them. */
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import * as FsTools from '@deepseek-ai/dsh-tool-fs'
import * as SearchTools from '@deepseek-ai/dsh-tool-fs-search'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as OpsPtc from '../lib/components/mode-ops-ptc/index.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { selectExecutor, prepareStep, executeCall } from './lib/executor.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
process.env.DSH_OPS_LEGACY_ROWS = '1'
requireWorker('ptc-guidance-cleanup')

const REPLACED = ['read', 'glob', 'grep']
// Pinned provider texts (@deepseek-ai/dsh-tool-fs / -fs-search): their own guidance
// names its tools, so a scope that hides a name must not keep teaching it.
const DEAD_POINTER = /Use the read tool|Use the glob tool|Use the grep tool|Use read on a matched file/

let serial = 0
/** The real provider pair, not fixture definitions: their tool:* prompt sections are the subject. */
async function fixture(cwd, options, body) {
  const { ctx } = await bootHost()
  try {
    await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem); await ctx.plugin(NodePtc)
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: cwd, sessionId: 'cleanup' }) })
    ctx.provide('agentPresets', { composedPreset: () => undefined })
    await ctx.plugin(FsTools, { read: true, readImage: false, applyPatch: false })
    await ctx.plugin(SearchTools, { sampleOverCapGlobResults: false })
    const agents = []
    ctx.provide('agents', { list: () => agents })
    const row = await ctx.plugin(OpsPtc,
      { required: true, binaryPath: WORKER, bash: false, batchingGuidance: false, ...options })
    const agent = async (presentation = 'ptc', parent) => {
      const id = `cleanup-${++serial}`
      const value = { id, session: { id, mode: 'danger-full-access',
        header: { cwd, agentPreset: presentation === 'ptc' ? 'ops-ptc' : 'native' }, append() {}, read() { return [] } } }
      value.ctx = createScope(parent?.ctx ?? ctx, value).ctx
      await value.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, presentation) } })
      agents.push(value)
      await ctx.serial('agent/created', { agent: value })
      return value
    }
    await body({ ctx, row, agent })
  } finally { await shutdown(ctx) }
}

async function capture(ctx, owner) {
  const step = await prepareStep(ctx, owner)
  try {
    const byName = new Map(step.assembly.sections.map(section => [section.name, section.text]))
    return {
      admitted: ctx.get('tools').definitions(owner, step.toolSet).map(tool => tool.name),
      sdk: byName.get('tools:sdk') ?? '',
      section: name => byName.get(name),
      texts: step.assembly.sections.filter(section => section.text).map(section => section.text),
      wire: JSON.stringify(step.assembly.tools),
    }
  } finally { step.dispose() }
}
// Poll the observable fact instead of sleeping: the replacement shadow registers in its own async inject.
const waitHidden = async (ctx, owner, names) => {
  const deadline = Date.now() + 5000
  while (true) {
    const step = await prepareStep(ctx, owner)
    let admitted
    try { admitted = ctx.get('tools').definitions(owner, step.toolSet).map(tool => tool.name) } finally { step.dispose() }
    if (names.every(name => !admitted.includes(name))) return
    if (Date.now() > deadline) throw new Error('timed out waiting for hidden ' + names.join(', '))
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
const waitPublish = async (ctx, owner, hidden = []) => {
  const deadline = Date.now() + 5000
  while (!ctx.get('tools').definitions(owner).some(tool => tool.name.startsWith('ops_'))) {
    if (Date.now() > deadline) throw new Error('timed out waiting for PTC publication')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (hidden.length) await waitHidden(ctx, owner, hidden)
}
const waitRestored = async (ctx, owner, names) => {
  const deadline = Date.now() + 5000
  for (;;) {
    const step = await prepareStep(ctx, owner)
    try {
      const admitted = ctx.get('tools').definitions(owner, step.toolSet).map(tool => tool.name)
      const sdk = step.assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
      const declared = name => new RegExp('(?:^|\\n)\\s*' + name + ':', 'u').test(sdk)
      if (names.every(name => admitted.includes(name) && declared(name))) return
    } finally { step.dispose() }
    if (Date.now() > deadline) throw new Error('timed out waiting for restored ' + names.join(', '))
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

await test('hidden read, glob and grep retire the provider guidance that names them', () => withTempDir('cleanup-full', async cwd => fixture(cwd, {}, async ({ ctx, agent }) => {
  const owner = await agent()
  await waitPublish(ctx, owner, REPLACED)
  const c = await capture(ctx, owner)
  // One step carries the SDK declaration, the prompt guidance and the admitted surface together.
  for (const name of REPLACED) {
    assert.equal(c.admitted.includes(name), false, name + ' must leave the admitted surface')
    assert.doesNotMatch(c.sdk, new RegExp('(?:^|\\n)\\s*' + name + ':', 'u'), name + ' must leave the SDK declaration')
    assert.equal(c.section('tool:' + name), undefined, 'tool:' + name + ' guidance must not reach a scope that hides it')
  }
  for (const text of c.texts) assert.doesNotMatch(text, DEAD_POINTER, 'a kept section still teaches a hidden official tool')
})))

await test('a kept grep keeps its guidance while the hidden read gains an executable alternative', () => withTempDir('cleanup-partial', async cwd => fixture(cwd, { dynamicTools: false }, async ({ ctx, agent }) => {
  const owner = await agent()
  await waitPublish(ctx, owner, ['read'])
  const c = await capture(ctx, owner)
  assert.equal(c.admitted.includes('read'), false, 'resident inspect still replaces read')
  for (const name of ['glob', 'grep']) {
    assert.ok(c.admitted.includes(name), name + ' stays official without a loader')
    assert.match(c.sdk, new RegExp('(?:^|\\n)\\s*' + name + ':', 'u'), name + ' keeps its SDK declaration')
  }
  assert.match(c.section('tool:glob'), /Use the glob tool/, 'the kept glob guidance survives untouched')
  assert.equal(c.section('tool:read'), undefined, 'tool:read must not reach a scope that hides read')
  // The host grep text cross-references read; its verbatim survival would keep the dead pointer.
  assert.equal(c.section('tool:grep'), undefined, 'the grep cross-reference to the hidden read must not survive verbatim')
  const alternative = c.texts.find(text => /ops_inspect_local_file/.test(text) && /\bread\b/.test(text))
  assert.ok(alternative, 'the hidden read keeps an executable alternative in the assembly')
  // Same step, program bindings: the kept official stays callable, the hidden one is unbound.
  const step = await prepareStep(ctx, owner)
  try {
    const run = await executeCall(ctx, { agent: owner, toolSet: step.toolSet, name: 'run_code', callId: 'cleanup-partial',
      arguments: { description: 'Probe the program bindings', code: 'return { read: typeof tools.read, grep: typeof tools.grep }' },
      signal: new AbortController().signal })
    assert.equal(run.isError, false, JSON.stringify(run))
    assert.deepEqual(run.value.result, { read: 'undefined', grep: 'function' })
  } finally { step.dispose() }
})))

await test('restoring the official entry points restores their guidance verbatim', () => withTempDir('cleanup-restore', async cwd => fixture(cwd, {}, async ({ ctx, row, agent }) => {
  const owner = await agent()
  await waitPublish(ctx, owner, REPLACED)
  await row.dispose()
  await waitRestored(ctx, owner, REPLACED)
  const c = await capture(ctx, owner)
  assert.match(c.section('tool:read'), /Use the read tool/, 'restored read guidance returns with the official entry')
  assert.match(c.section('tool:grep'), /Use read on a matched file/, 'the grep cross-reference returns once read is callable again')
  assert.equal(c.texts.find(text => /Official .* hidden in this scope/.test(text)), undefined, 'no replacement note remains')
})))

await test('the provider guidance stays complete while hiding is off', () => withTempDir('cleanup-off', async cwd => fixture(cwd, { hideOfficialTools: false }, async ({ ctx, agent }) => {
  const owner = await agent()
  await waitPublish(ctx, owner)
  const c = await capture(ctx, owner)
  assert.match(c.section('tool:read'), /Use the read tool/)
  assert.match(c.section('tool:glob'), /Use the glob tool/)
  assert.match(c.section('tool:grep'), /Use the grep tool/)
  assert.match(c.section('tool:grep'), /Use read on a matched file/)
})))

await test('a native child of a hidden PTC parent keeps the official guidance', () => withTempDir('cleanup-tree', async cwd => fixture(cwd, {}, async ({ ctx, agent }) => {
  const parent = await agent()
  await waitPublish(ctx, parent, REPLACED)
  const child = await agent('native', parent)
  const c = await capture(ctx, child)
  for (const name of REPLACED) assert.ok(c.admitted.includes(name), name + ' stays visible to a native child')
  assert.match(c.section('tool:read'), /Use the read tool/, 'native guidance matches the native admission')
})))

await test('byte deltas stay grouped: SDK, provider guidance and the outer wire', () => withTempDir('cleanup-bytes', async cwd => {
  const groups = c => {
    const guidance = REPLACED.map(name => 'tool:' + name).reduce((sum, name) => sum + Buffer.byteLength(c.section(name) ?? ''), 0)
    const all = c.texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0)
    return { sdk: Buffer.byteLength(c.sdk), guidance, otherSections: all - Buffer.byteLength(c.sdk) - guidance, wire: Buffer.byteLength(c.wire) }
  }
  let hidden, off
  await fixture(cwd, {}, async ({ ctx, agent }) => {
    const owner = await agent()
    await waitPublish(ctx, owner, REPLACED)
    hidden = groups(await capture(ctx, owner))
  })
  await fixture(cwd, { hideOfficialTools: false }, async ({ ctx, agent }) => {
    const owner = await agent()
    await waitPublish(ctx, owner)
    off = groups(await capture(ctx, owner))
  })
  const delta = {}
  for (const key of Object.keys(hidden)) delta[key] = hidden[key] - off[key]
  // Relative deltas only (V2 convention); each group counted once, the SDK never re-billed as wire.
  console.log('  byte deltas hidden - off (sections tool:read, tool:glob, tool:grep): ' + JSON.stringify({ hidden, off, delta }))
  assert.ok(delta.sdk < 0, 'hiding shrinks the SDK declaration')
  assert.equal(hidden.guidance, 0, 'the hidden names contribute no provider guidance bytes')
  assert.ok(off.guidance > 0, 'the pinned provider guidance is non-empty when kept')
  assert.equal(delta.wire, 0, 'the outer wire carries only run_code in both states')
}))

report('ptc-guidance-cleanup')
