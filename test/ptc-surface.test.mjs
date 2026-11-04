/**
 * The probe's memo key must cost less than the assembly it skips.
 *
 * `surfaceOf` names the tools a scope can see, and both PTC rows use that name list to
 * decide whether a presentation verdict is still current. The key is therefore read once
 * per tracked agent per reconcile, while the work it skips is one prompt assembly. Reading
 * it through `schemas()` deep-copies every visible schema, which on this host costs more
 * than the assembly: the memo then loses time on every pass instead of saving any.
 *
 * These checks pin the shape rather than a wall-clock number, so they hold on any host.
 */
import { createScope } from '@deepseek-ai/dsh-scope'
import { bootHost, shutdown } from './lib/host.mjs'
import { assert, test, report } from './lib/harness.mjs'
import { readableSurface, surfaceOf, surfaceNames } from '../lib/surface.js'

/** A registered tool whose schema is big enough that a deep copy is measurable. */
const tool = name => ({
  name,
  description: `surface probe fixture ${name}`,
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

/**
 * Wrap `schemas` so a call is counted, leaving `this` bound to the real registry.
 *
 * The registry reaches its own methods through a scoped proxy that rebinds `this` only
 * for a call arriving on the proxy itself, so an arrow replacement would break every
 * internal call as well and count nothing.
 * @param tools - the registry to observe.
 * @returns the running count of `schemas` calls.
 */
function countSchemas (tools) {
  const calls = { count: 0 }
  const original = tools.schemas
  tools.schemas = function (...args) { ++calls.count; return original.apply(this, args) }
  return calls
}

/**
 * Wrap `view` so a call is counted, with the same `this` care as {@link countSchemas}.
 * @param tools - the registry to observe.
 * @returns the running count of `view` calls.
 */
function countViews (tools) {
  const views = { count: 0 }
  const original = tools.view
  tools.view = function (...args) { ++views.count; return original.apply(this, args) }
  return views
}

await test('a surface read does not deep-copy schemas', () => withScope(async ({ tools, key, calls }) => {
  calls.count = 0
  const surface = surfaceOf(tools, key)
  assert.equal(calls.count, 0, 'reading the surface must not project schemas; a deep copy per agent per pass is the cost this memo exists to avoid')
  assert.deepEqual(surfaceNames(surface).sort(), ['alpha', 'beta'], 'the surface names every visible tool')
}))

await test('a surface read does not re-read the view once per name', () => withScope(async ({ tools, key, views }) => {
  // `tools.get()` and `tools.schemas()` each rebuild the whole scope view, so pairing them
  // per name would make the key O(names²) — the shape main shipped, and the reason this
  // module reads one view and takes identity off the objects it already holds.
  views.count = 0
  const surface = surfaceOf(tools, key)
  assert.equal(views.count, 1, 'one view read must produce both the names and their identities')
  assert.equal(surfaceNames(surface).length, 2, 'the surface still describes every visible tool')
}))

await test('a surface read agrees with schemas() for the same scope', () => withScope(async ({ tools, key }) => {
  const projected = tools.schemas(key).map(schema => schema.name)
  assert.deepEqual(surfaceNames(surfaceOf(tools, key)), projected, 'the memo key must name exactly what schemas() projects, in the same order')
}))

await test('a surface read follows the tools a scope gains and loses', () => withScope(async ({ tools, key }) => {
  const before = surfaceOf(tools, key)
  const dispose = tools.register(tool('gamma'))
  try {
    assert.notEqual(surfaceOf(tools, key), before, 'a new registration changes the surface, so the verdict is re-probed')
    assert.ok(surfaceNames(surfaceOf(tools, key)).includes('gamma'), 'the new tool is named')
  } finally { dispose() }
  assert.equal(surfaceOf(tools, key), before, 'disposing the registration restores the previous surface')
}))

await test('a same-named replacement moves the surface', () => withScope(async ({ tools, key, agent }) => {
  // A scoped registration shadows the global definition of the same name. The name set is
  // unchanged, yet the definition a publish captures in its shadow closure is a different
  // object, so the key has to move: a names-only key caches a verdict for a surface that no
  // longer exists and publishes nothing on the change that owed a republish.
  const before = surfaceOf(tools, key)
  const fiber = await scoped(agent, scopedTools => scopedTools.register(tool('alpha')))
  try {
    assert.notEqual(surfaceOf(tools, key), before, 'a same-named shadow replaces the definition, which is a surface change')
    assert.deepEqual(surfaceNames(surfaceOf(tools, key)), surfaceNames(before), 'and it is not a name change — the names alone would have missed it')
  } finally { await fiber.dispose() }
  assert.equal(surfaceOf(tools, key), before, 'lifting the shadow restores the previous surface')
}))

await test('a host without a reachable view still names the surface', () => withScope(async ({ tools, key }) => {
  // The fallback is the correctness branch: a host whose view this module cannot reach must
  // still produce the same key, paying the deep copy rather than returning a wrong verdict.
  // Run against a stand-in registry, since deleting `view` from the real one is not possible.
  const projected = tools.schemas(key).map(schema => schema.name)
  const noView = { schemas: scope => tools.schemas(scope) }
  assert.deepEqual(surfaceNames(surfaceOf(noView, key)), projected, 'the fallback names exactly what schemas() projects')
  // The projection has already detached every parameter schema, so the fallback pairs each
  // name with the description it already holds: a concat, not a copy. That is enough to see a
  // same-named swap that ships a new description, without a second pass over the tree.
  const swapped = { schemas: scope => tools.schemas(scope).map(schema => ({ ...schema, description: `swapped ${schema.name}` })) }
  assert.notEqual(surfaceOf(swapped, key), surfaceOf(noView, key), 'a same-named swap with a new description moves the fallback key')
  assert.deepEqual(surfaceNames(surfaceOf(noView, key)), projected, 'the description suffix never leaks into a name')
}))

/**
 * Mount a plugin on the agent's scope and act on the registry from inside it.
 *
 * A scoped registration or restriction refuses the host's unscoped context, and the
 * registry's scope tag lives on the context a plugin receives — not on the service object
 * `ctx.get('tools')` returns, whose `scopeOf` is undefined. Going through a plugin is
 * therefore the only way to reach a scoped registry.
 * @param agent - the scoped context to mount on.
 * @param act - receives that context's scoped registry.
 * @returns the plugin's disposable fiber.
 */
async function scoped (agent, act) {
  return agent.plugin({ inject: ['tools'], apply (inner) { act(inner.tools) } })
}

/**
 * Boot a host with the fixture tools registered and one scoped agent.
 * @param {Function} body - the check to run against that host.
 */
async function withScope (body) {
  const { ctx } = await bootHost()
  try {
    const tools = ctx.get('tools')
    tools.register(tool('alpha'))
    tools.register(tool('beta'))
    // `key` is what `view()` takes; the context only carries it. Passing the context
    // silently reads the global layer, which is how a scoped shadow can go unseen.
    const key = { id: 'surface-' + Math.random() }
    const scope = createScope(ctx, key)
    await body({ ctx, tools, key, agent: scope.ctx, calls: countSchemas(tools), views: countViews(tools) })
  } finally { await shutdown(ctx) }
}
await test('a surface read without a scope describes the global layer', () => withScope(async ({ tools, calls }) => {
  // The memo key is also read for the global layer (official-tool-hiding does that before
  // any agent exists), so the optional scope must reach the same cheap view path instead of
  // falling back to a projection for the largest surface of all.
  calls.count = 0
  const surface = surfaceOf(tools)
  assert.equal(calls.count, 0, 'the global layer must be read through the view as well')
  assert.deepEqual(surfaceNames(surface).sort(), ['alpha', 'beta'], 'a scope-less read names the global registrations')
}))
await test('a registry that serves a view alone is still readable', () => withScope(async ({ tools }) => {
  // The replacement planner used to gate its whole name list on `schemas` being callable, so a
  // host serving a view without the projection had every selected replacement reported absent
  // instead of planned. Either reader is enough: both fall back to the other one.
  const viewOnly = { view: scope => tools.view(scope) }
  assert.equal(readableSurface(viewOnly), true, 'a view without the projection can describe a surface')
  assert.equal(readableSurface({}), false, 'a registry that offers neither cannot be planned against')
}))
await test('a description carrying a separator cannot forge an entry', () => withScope(async ({ tools, key }) => {
  // Entries are NUL-joined and a name is split from its payload with SOH. Off the view path the
  // description is the only payload `schemas()` hands over, so it is the only place one of those
  // characters could smuggle in and make two registrations read back as three names.
  for (const description of ['before\u0000after', 'x\u0000y\u0001z', 'plain', '\\u0000 literal']) {
    const stand = { schemas: () => tools.schemas(key).map(schema => ({ ...schema, description })) }
    assert.deepEqual(surfaceNames(surfaceOf(stand, key)).sort(), ['alpha', 'beta'],
      'a separator in the description stays inside its own entry: ' + JSON.stringify(description))
  }
  // `tools.register()` validates the output schema and the timeout, not the type of
  // `description`, and `schemaOf` forwards it unchanged: this key is read on the dispatch path,
  // so a host that hands over a number must not turn it into a throw.
  for (const description of [42, null, { toString: () => 'object description' }]) {
    const stand = { schemas: () => tools.schemas(key).map(schema => ({ ...schema, description })) }
    assert.doesNotThrow(() => surfaceOf(stand, key), 'a non-string description must not throw: ' + String(description))
    assert.deepEqual(surfaceNames(surfaceOf(stand, key)).sort(), ['alpha', 'beta'], 'and the names survive')
  }
}))
report('ptc-surface')
