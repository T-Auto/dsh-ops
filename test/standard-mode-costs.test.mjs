/**
 * The name-only read this branch introduces: `visibleNames` must not deep-copy schemas.
 *
 * `visibleTools` and the host-shell denial gate used `schemas()`, which deep-copies every
 * visible definition's parameters — on the published host 34.2 ms for 258 tools at the
 * issue's own surface shape — just to keep the names. The view reports the same names,
 * in the same order, for ~0.043 ms. These checks pin the shape rather than a wall-clock
 * number, so they hold on any host.
 *
 * The discovery pre-step probe is deliberately NOT memoized and stays out of this file: it
 * is the path by which a presentation that flips without the names moving corrects itself
 * (see `test/ptc-sdk.test.mjs`, the same-layer handoff case), so its assembly per step is
 * load-bearing, not overhead.
 */
import { createScope } from '@deepseek-ai/dsh-scope'
import { bootHost, shutdown } from './lib/host.mjs'
import { assert, test, report, waitFor } from './lib/harness.mjs'
import { applyComponent } from '../lib/index.js'
import { visibleNames } from '../lib/surface.js'

/** A registered tool whose schema is big enough that a deep copy is measurable. */
const tool = name => ({
  name,
  description: `visible names fixture ${name}`,
  parameters: {
    type: 'object',
    properties: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`field_${index}`, {
      type: 'object',
      description: `nested option group ${index} of ${name}, long enough that a deep copy shows up`,
      properties: { mode: { type: 'string', enum: ['fast', 'safe', 'strict'] } }
    }]))
  },
  output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } } }, render: () => [] },
  execute: async () => ({ content: 'ok' })
})

await test('a name-only read does not project schemas', () => withRegistry(async ({ tools, key, calls }) => {
  calls.count = 0
  const names = visibleNames(tools, key)
  assert.equal(calls.count, 0, 'reading visible names must not deep-copy schemas; the tooling sections pay this per assembly')
  assert.deepEqual(names, ['alpha', 'beta'], 'the names come back in view order')
}))

await test('a name-only read matches the schemas() projection for every scope shape', () => withRegistry(async ({ tools, key }) => {
  for (const scope of [key, undefined]) {
    const projected = tools.schemas(scope).map(schema => schema.name)
    assert.deepEqual(visibleNames(tools, scope), projected, `names must match the projection for ${scope === undefined ? 'the global layer' : 'a scoped key'}`)
  }
}))

await test('a host without a reachable view still names the tools', () => withRegistry(async ({ tools, key }) => {
  // The fallback is the correctness branch: a host whose view this module cannot reach
  // must still produce the same names, paying the copy rather than returning nothing.
  const projected = tools.schemas(key).map(schema => schema.name)
  const noView = { schemas: scope => tools.schemas(scope) }
  assert.deepEqual(visibleNames(noView, key), projected, 'the fallback names exactly what schemas() projects')
}))

await test('a tooling section renders from view names, not a projection', () => withRegistry(async ({ ctx, tools, key }) => {
  // The shell/file tooling sections run on every assembly. Reading them through the
  // projection deep-copies every schema to keep a handful of owned names; a revert to
  // `schemas()` makes `projected` non-zero here.
  let projected = 0
  const original = tools.schemas
  tools.schemas = function (...args) { ++projected; return original.apply(this, args) }
  const dispose = ctx.systemPrompt.section({
    name: 'tooling:shell', order: 100, interpolate: false,
    text: context => visibleNames(tools, context.scope).filter(name => name === 'alpha').join(', ') || '(none)'
  })
  try {
    const first = await ctx.systemPrompt.assemble({ scope: key })
    const second = await ctx.systemPrompt.assemble({ scope: key })
    assert.equal(projected, 0, 'a name-only section must not project schemas, at any assembly')
    assert.ok(first.sections.some(each => each.name === 'tooling:shell' && each.text.includes('alpha')), 'the section names the owned tool')
    assert.ok(second.sections.some(each => each.name === 'tooling:shell' && each.text.includes('alpha')), 'and keeps naming it on the next assembly')
  } finally { dispose(); tools.schemas = original }
}))


await test('the host-shell denial gate restricts without projecting schemas', () => withRegistry(async ({ ctx }) => {
  // `installHostShellDenial` names the host's shell tools to deny them for each agent.
  // It shares the name-only read, so it must not deep-copy either: a revert to `schemas()`
  // makes `projected` non-zero here while the restriction itself keeps working either way.
  ctx.get('tools').register({
    name: 'bash', description: 'foreign host shell fixture', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({ content: 'ok' }),
  })
  let projected = 0
  const tools = ctx.get('tools')
  const original = tools.schemas
  tools.schemas = function (...args) { ++projected; return original.apply(this, args) }
  let fiber
  try {
    fiber = await applyComponent(ctx, { shellPolicy: 'deny-host-shell', publishBashTool: false }, 'shell')
    const target = { id: 'denied-' + Math.random(), session: { id: 'denied', mode: 'danger-full-access', header: { cwd: process.cwd() } } }
    await ctx.plugin({ inject: ['tools'], apply(inner) { target.ctx = createScope(inner, target).ctx } })
    await ctx.serial('agent/created', { agent: target, source: 'startup' })
    // The wait itself must read through the view: `scopedToolNames` projects, and the
    // wait's own projection would be indistinguishable from the gate's.
    await waitFor(() => !visibleNames(tools, target).includes('bash'), { timeoutMs: 5000, what: 'bash denied' })
    assert.equal(projected, 0, 'denying the host shell must not project schemas; the gate runs per agent')
    assert.ok(original.call(tools).map(schema => schema.name).includes('bash'), 'the host layer keeps the tool; only the scope is denied')
  } finally {
    tools.schemas = original
    await fiber?.dispose()
  }
}))

/**
 * Boot a host with the fixture tools registered and one scoped key.
 * @param {Function} body - the check to run against that host.
 */
async function withRegistry (body) {
  const { ctx } = await bootHost()
  try {
    const tools = ctx.get('tools')
    tools.register(tool('alpha'))
    tools.register(tool('beta'))
    const key = { id: 'names-' + Math.random() }
    createScope(ctx, key)
    const original = tools.schemas
    const calls = { count: 0 }
    tools.schemas = function (...args) { ++calls.count; return original.apply(this, args) }
    try { await body({ ctx, tools, key, calls }) } finally { tools.schemas = original }
  } finally { await shutdown(ctx) }
}

report('standard-mode-costs')
