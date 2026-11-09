/** Replacement declarations share the source's exact DSH step admission. */
import { createScope } from '@deepseek-ai/dsh-scope'
import { mountReplacements } from '../lib/publication/replacements.js'
import { acquire } from '../lib/publication/registrar.js'
import { OFFICIAL_REPLACEMENTS } from '../lib/official-tool-catalog.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { assert, test, report, wait } from './lib/harness.mjs'
import { prepareStep, executeCall } from './lib/executor.mjs'
const targets = new Map(Object.entries(OFFICIAL_REPLACEMENTS))
const tool = name => ({ name, description: `fixture ${name}`, parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({ ran: name }) })
async function fixture(body, { unboundProbe = false } = {}) {
  const { ctx, tools } = await bootHost()
  let allowed = true, keep = false
  const agent = { id: 'replacement', session: { id: 'replacement' } }
  agent.ctx = createScope(ctx, agent).ctx
  const warnings = []
  ctx.logger.exporter({ levels: { default: 4 }, export(message) {
    if (message.type === 'warn') warnings.push(message.args.join(' '))
  } })
  if (unboundProbe) {
    // A second dsh-scope copy binds a private WeakMap the host cannot see: probes
    // then read the root view, exactly as if bindScopeParent were a no-op.
    const get = tools.get.bind(tools)
    tools.get = (name, scope, toolSet) => get(name, scope && scope !== agent ? undefined : scope, toolSet)
  }
  const live = []
  ctx.provide('agents', { list: () => live })
  const officials = new Map([...targets.keys()].map(name => [name, tool(name)]))
  const removeOfficials = new Map([...officials].map(([name, definition]) => [name, tools.register(definition)]))
  await ctx.plugin({ apply(inner) { mountReplacements(inner, { id: 'fixture', targets,
    gate: { allows: () => allowed }, keepOfficial: () => keep }) } })
  const leases = []
  const publish = async present => {
    for (const name of targets.values()) {
      const { execute, name: _name, ...canonical } = tool(name)
      const lease = await acquire(ctx, undefined, name, canonical)
      lease.grant({ consumer: {}, agent, token: {}, entitled: true, dispatch: execute, present })
      leases.push(lease)
    }
  }
  try {
    // Cordis inject callbacks load scope helpers asynchronously, outside plugin readiness.
    await new Promise(resolve => setImmediate(resolve))
    live.push(agent)
    await ctx.serial('agent/created', { agent })
    await body({ ctx, tools, agent, officials, removeOfficials, publish, leases, warnings,
      revokeAuthority: () => { allowed = false }, keepOfficial: () => { keep = true } })
  } finally { leases.forEach(lease => lease.dispose()); await shutdown(ctx) }
}
const dispatch = (ctx, agent, step, name) => executeCall(ctx, { agent, name, arguments: {}, callId: name,
  signal: new AbortController().signal, toolSet: step.toolSet })
const names = step => step.assembly.tools.map(t => t.name).sort()

await test('conditional read/glob/grep replacements are mutually exclusive with official declarations', () => fixture(async ({ ctx, tools, agent, officials, publish }) => {
  let enabled = false
  await publish(() => enabled)
  const held = await prepareStep(ctx, agent)
  try {
    assert.deepEqual(names(held), [...targets.keys()].sort())
    for (const name of targets.keys()) {
      const fallback = tools.get(name, agent)
      assert.deepEqual(fallback, officials.get(name), 'the fallback preserves every official schema and callback')
      assert.equal(fallback.execute, officials.get(name).execute)
    }
    enabled = true
    // Inspecting a prompt must not change shared registrations or the held admission.
    let changes = 0
    const unwatch = ctx.on('tools/change', () => { ++changes }, { global: true })
    await ctx.get('systemPrompt').assemble({ scope: agent })
    unwatch()
    assert.equal(changes, 0)
    for (const name of targets.keys()) {
      const result = await dispatch(ctx, agent, held, name)
      assert.equal(result.isError, false); assert.equal(result.value.ran, name)
    }
    const next = await prepareStep(ctx, agent)
    try {
      assert.deepEqual(names(next), [...targets.values()].sort())
      for (const [official, counterpart] of targets) {
        assert.equal(tools.executable(official, agent, next.toolSet), undefined)
        const absent = await dispatch(ctx, agent, next, official)
        assert.equal(absent.error.info.code, 'UNKNOWN_TOOL', 'no pre-execute replacement refusal remains')
        assert.equal((await dispatch(ctx, agent, next, counterpart)).isError, false)
      }
    } finally { next.dispose() }
    enabled = false
    const fallback = await prepareStep(ctx, agent)
    try {
      assert.deepEqual(names(fallback), [...targets.keys()].sort())
      for (const name of targets.keys()) assert.equal((await dispatch(ctx, agent, fallback, name)).value.ran, name)
    } finally { fallback.dispose() }
  } finally { held.dispose() }
}))

await test('each condition is evaluated once even when the official shadow resolves first', () => fixture(async ({ ctx, agent, publish }) => {
  let evaluations = 0
  await publish(() => { ++evaluations; return evaluations % 2 === 1 })
  for (let i = 0; i < 2; ++i) {
    const before = evaluations
    const step = await prepareStep(ctx, agent)
    try {
      assert.equal(evaluations - before, targets.size)
      const selected = new Set(names(step))
      for (const [official, counterpart] of targets) assert.notEqual(selected.has(official), selected.has(counterpart))
    } finally { step.dispose() }
  }
}))

await test('an unloaded conditional counterpart restores official tools on the next step', () => fixture(async ({ ctx, agent, publish, leases }) => {
  await publish(() => true)
  const step = await prepareStep(ctx, agent)
  try {
    assert.deepEqual(names(step), [...targets.values()].sort())
    leases.forEach(lease => lease.dispose())
    await wait(30)
    const fallback = await prepareStep(ctx, agent)
    try {
      assert.deepEqual(names(fallback), [...targets.keys()].sort())
      for (const name of targets.keys()) assert.equal((await dispatch(ctx, agent, fallback, name)).value.ran, name)
    } finally { fallback.dispose() }
  } finally { step.dispose() }
}))

await test('official restrictions before and after shadow installation are never bypassed', () => fixture(async ({ ctx, agent, publish }) => {
  const liftBefore = agent.ctx.get('tools').restrict({ deny: ['read'] })
  await publish(() => false)
  for (const denied of ['read', 'glob']) {
    const liftAfter = denied === 'glob' ? agent.ctx.get('tools').restrict({ deny: [denied] }) : () => {}
    const step = await prepareStep(ctx, agent)
    try {
      assert.equal(names(step).includes(denied), false)
      assert.equal((await dispatch(ctx, agent, step, denied)).error.info.code, 'UNKNOWN_TOOL')
    } finally { step.dispose(); liftAfter() }
  }
  liftBefore()
}))

await test('a denied counterpart leaves official tools declared and callable', () => fixture(async ({ ctx, agent, publish }) => {
  await publish(() => true)
  const lift = agent.ctx.get('tools').restrict({ deny: [...targets.values()] })
  try {
    const step = await prepareStep(ctx, agent)
    try {
      assert.deepEqual(names(step), [...targets.keys()].sort())
      for (const name of targets.keys()) assert.equal((await dispatch(ctx, agent, step, name)).value.ran, name)
    } finally { step.dispose() }
  } finally { lift() }
}))

await test('unconditional counterpart withdrawal restores the next step without waiting for registry reconciliation', () => fixture(async ({ ctx, tools, agent }) => {
  const removals = [...targets.values()].map(name => tools.register(tool(name)))
  const replaced = await prepareStep(ctx, agent)
  try { assert.deepEqual(names(replaced), [...targets.values()].sort()) } finally { replaced.dispose() }
  removals.forEach(remove => remove())
  const fallback = await prepareStep(ctx, agent)
  try {
    assert.deepEqual(names(fallback), [...targets.keys()].sort())
    for (const name of targets.keys()) assert.equal((await dispatch(ctx, agent, fallback, name)).value.ran, name)
  } finally { fallback.dispose() }
}))

await test('a new official restriction revokes an already admitted fallback step', () => fixture(async ({ ctx, agent, publish }) => {
  await publish(() => false)
  const held = await prepareStep(ctx, agent)
  const lift = agent.ctx.get('tools').restrict({ deny: ['read'] })
  try {
    assert.equal((await dispatch(ctx, agent, held, 'read')).error.info.code, 'UNKNOWN_TOOL')
  } finally { lift(); held.dispose() }
}))

await test('original source unload revokes held callbacks and a new source is selected immediately', () => fixture(async ({ ctx, tools, agent, removeOfficials, publish }) => {
  let enabled = false
  await publish(() => enabled)
  const held = await prepareStep(ctx, agent)
  try {
    removeOfficials.get('read')()
    assert.equal((await dispatch(ctx, agent, held, 'read')).error.info.code, 'UNKNOWN_TOOL')
    const replacement = { ...tool('read'), description: 'new official schema', execute: async () => ({ ran: 'new-read' }) }
    const removeNew = tools.register(replacement)
    try {
      const fallback = await prepareStep(ctx, agent)
      try {
        assert.equal(fallback.assembly.tools.find(t => t.name === 'read').description, replacement.description)
        assert.equal((await dispatch(ctx, agent, fallback, 'read')).value.ran, 'new-read')
      } finally { fallback.dispose() }
      enabled = true
      const replaced = await prepareStep(ctx, agent)
      try { assert.deepEqual(names(replaced), [...targets.values()].sort()) } finally { replaced.dispose() }
    } finally { removeNew() }
  } finally { held.dispose() }
}))

await test('unlinked probe scopes keep official tools visible and callable with one warning', () => fixture(async ({ ctx, tools, agent, officials, publish, warnings }) => {
  await publish(() => false)
  tools.register(tool('unrelated-probe'))
  for (let i = 0; i < 2; ++i) {
    const step = await prepareStep(ctx, agent)
    try {
      for (const name of targets.keys()) {
        assert.ok(names(step).includes(name))
        assert.equal(tools.get(name, agent), officials.get(name), 'an unlinked scope must not keep an official shadow')
        assert.equal((await dispatch(ctx, agent, step, name)).value.ran, name)
      }
    } finally { step.dispose() }
  }
  assert.equal(warnings.filter(message => message.includes('scope linkage unavailable')).length, 1)
}, { unboundProbe: true }))

for (const change of ['revokeAuthority', 'keepOfficial']) await test(`${change} leaves official fallback callable without a guard`, () => fixture(async f => {
  await f.publish(() => true)
  f[change]()
  const step = await prepareStep(f.ctx, f.agent)
  try {
    for (const name of targets.keys()) {
      assert.ok(names(step).includes(name))
      assert.equal((await dispatch(f.ctx, f.agent, step, name)).value.ran, name)
    }
  } finally { step.dispose() }
}))
report('replacements-admission')
