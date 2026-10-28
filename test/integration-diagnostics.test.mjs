import { integration, registerNativeCapability, diagnose } from 'dsh-ops/integration'
import path from 'node:path'
import { createScope } from '@deepseek-ai/dsh-scope'
import { bootHost, shutdown, scopedToolNames } from './lib/host.mjs'
import { assert, test, report, waitFor, withTempDir } from './lib/harness.mjs'
await test('diagnostics distinguishes unselected, unavailable and ready publication states', () => withTempDir('diagnostics', async cwd => {
  const { ctx } = await bootHost()
  try {
    const agent = { id: 'diag', session: { id: 'diag', mode: 'read-only', header: { cwd, agentPreset: 'diag-preset' } } }
    await ctx.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
    const unselected = await diagnose(ctx, agent)
    assert.equal(unselected.state, 'not-selected')
    await ctx.plugin(integration({ preset: 'diag-preset', profile: 'discovery', allowedTools: [], externalTools: ['diag_lookup'], externalAlwaysLoaded: ['diag_lookup'] }))
    const unavailable = await diagnose(ctx, agent)
    assert.equal(unavailable.external[0].state, 'unavailable')
    await registerNativeCapability(ctx, { search: 'diagnostic lookup', authorize: () => true, definition: {
      name: 'diag_lookup', description: 'Diagnostic lookup.', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({ ok: true }),
    } })
    await ctx.serial('agent/created', { agent })
    await waitFor(() => scopedToolNames(ctx, agent).includes('diag_lookup'))
    const result = await ctx.get('tools').execute({ agent, name: 'ops_status', arguments: {}, callId: 'diag', signal: new AbortController().signal })
    assert.equal(result.isError, false); assert.equal(result.value.external[0].state, 'active')
    const ready = await diagnose(ctx, agent)
    assert.equal(ready.state, 'ready'); assert.equal(ready.external[0].state, 'active')
    assert.equal(scopedToolNames(ctx, agent).includes('diag_lookup'), true)
    const retained = ctx.get('tools').get('ops_status', agent)
    await ctx.serial('agent/disposed', { agent })
    assert.equal((await retained.execute({}, { agent })).status, 'rejected')
  } finally { await shutdown(ctx) }
}))
await test('built-in discovery diagnoses missing runtime and missing scoped publication', () => withTempDir('diag-discovery', async cwd => {
  const { ctx } = await bootHost()
  try {
    const agents = []; ctx.provide('agents', { list: () => agents })
    ctx.provide('agentPresets', { composedPreset: () => undefined })
    await ctx.plugin(integration({ preset: 'broken-discovery', profile: 'discovery', binaryPath: path.join(cwd, 'missing-worker') }))
    const agent = { id: 'broken', session: { id: 'broken', mode: 'read-only', header: { cwd, agentPreset: 'broken-discovery' } } }
    await ctx.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
    agents.push(agent); await ctx.serial('agent/created', { agent })
    const result = await diagnose(ctx, agent)
    assert.equal(result.state, 'degraded')
    assert.ok(result.issues.some(row => row.code === 'RUNTIME_UNAVAILABLE'))
    assert.ok(result.issues.some(row => row.code === 'HOST_SERVICE_UNAVAILABLE'))
    assert.ok(result.issues.some(row => row.code === 'PUBLICATION_UNAVAILABLE'))
  } finally { await shutdown(ctx) }
}))
await test('shell diagnostics require host authority and visible scoped bash publication', () => withTempDir('diag-shell', async cwd => {
  const { ctx } = await bootHost()
  try {
    ctx.provide('agentPresets', { composedPreset: () => undefined })
    await ctx.plugin(integration({ preset: 'shell-diag', profile: 'shell', bashPath: process.execPath }))
    const agent = { id: 'shell', session: { id: 'shell', mode: 'danger-full-access', header: { cwd, agentPreset: 'shell-diag' } } }
    await ctx.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
    await ctx.serial('agent/created', { agent })
    const result = await diagnose(ctx, agent)
    assert.equal(result.state, 'degraded')
    assert.ok(result.issues.some(row => row.code === 'HOST_SERVICE_UNAVAILABLE'))
    assert.ok(result.issues.some(row => row.code === 'PUBLICATION_UNAVAILABLE'))
  } finally { await shutdown(ctx) }
}))
await test('external-only diagnostics need no worker and distinguish pending from active', () => withTempDir('diag-pending', async cwd => {
  const { ctx } = await bootHost()
  try {
    ctx.provide('agentPresets', { composedPreset: () => undefined })
    await ctx.plugin(integration({ preset: 'pending-diag', profile: 'discovery', allowedTools: [], externalTools: ['pending_lookup'] }))
    await registerNativeCapability(ctx, { search: 'pending lookup', authorize: () => true, definition: {
      name: 'pending_lookup', description: 'Lookup.', parameters: { type: 'object' },
      output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}),
    } })
    const agent = { id: 'pending', session: { id: 'pending', mode: 'read-only', header: { cwd, agentPreset: 'pending-diag' } } }
    await ctx.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
    await ctx.serial('agent/created', { agent })
    assert.equal((await diagnose(ctx, agent)).external[0].state, 'available')
    await ctx.get('tools').execute({ agent, name: 'ops_discover_tools', arguments: { query: 'select:pending_lookup' }, callId: 'select', signal: new AbortController().signal })
    const pending = await diagnose(ctx, agent)
    assert.equal(pending.state, 'ready'); assert.equal(pending.external[0].state, 'pending')
    await ctx.serial('session/event', agent.session, { type: 'step/end' })
    await ctx.get('systemPrompt').assemble({ scope: agent, agent })
    assert.equal((await diagnose(ctx, agent)).external[0].state, 'active')
  } finally { await shutdown(ctx) }
}))
report('integration-diagnostics')
