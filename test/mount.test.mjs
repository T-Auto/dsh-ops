import { discoveryMountChecks } from './lib/discovery.mjs'
/** Real Cordis/tool/prompt composition with the released independent components. */
import fs from 'node:fs'
import { legacyComponent } from './lib/legacy-component.mjs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { BASH_TOOL, FILE_TOOLS, TOOLING_SECTION, publicToolName } from '../lib/policy.js'
import { NATIVE_RESIDENT_FILE_TOOLS } from '../lib/capabilities/registry.js'
import * as discovery from '../lib/components/discovery/index.js'
import { applyComponent } from '../lib/index.js'
import * as ptc from '../lib/ptc/index.js'
import { resolveWorker } from '../lib/ptc/runtime.js'
import { PACKAGE_ROOT, assert, report, skipSuite, test, waitFor, withTempDir } from './lib/harness.mjs'
import { bootHost, callTool, mountPlugin, mountScopedToolPlugin, preExecute, publicToolNames,
  registryHasOwnRegister, registryNames, renderSections, scopedToolNames,
  shutdown } from './lib/host.mjs'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { officialToolHidingMountChecks } from './lib/official-tool-hiding.mjs'

// Component 4 has no native runtime dependency; always exercise its real mounts.
await officialToolHidingMountChecks()
const EXPECTED = NATIVE_RESIDENT_FILE_TOOLS.map(publicToolName).sort()
const FILE_SECTION = `${TOOLING_SECTION}:file`
const SHELL_SECTION = `${TOOLING_SECTION}:shell`
const BG_SECTION = `${TOOLING_SECTION}:background`
// The file component needs the native worker the plugin itself resolves; without one this suite
// cannot answer here (a skip, which DSH_OPS_REQUIRE_RUNTIME=1 turns into a failure).
let worker
try { worker = resolveWorker({}) } catch (error) {
  if (process.env.DSH_OPS_REQUIRE_RUNTIME === '1') throw error
  skipSuite('mount', error.message.split('\n')[0])
}
console.log(`  worker: ${worker}`)
await discoveryMountChecks()
/** The row configs earlier bundles wrote into every existing profile (`cordis.patch.yml` before update 2). */
const LEGACY_ROWS = Object.freeze({
  file: { promptPolicy: true, enableShellTools: false, required: false, toolCallTimeoutMs: 300000 },
  background: { promptPolicy: true, enableShellTools: true, required: false, toolCallTimeoutMs: 300000 },
})
function foreignTool(name) {
  return { name, description: 'foreign fixture', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) }
}
async function fileMount(ctx, config = {}) {
  if (!ctx.get('subprocess')) await ctx.plugin(Subprocess)
  if (!ctx.get('sandbox')) await ctx.plugin(Sandbox, {})
  if (!ctx.get('sandboxPolicy')) await ctx.plugin(inner => inner.provide('sandboxPolicy', {
    resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: session.header.cwd, sessionId: session.id }),
  }))
  return mountPlugin({ ctx, config, expectTools: EXPECTED.length })
}
async function agentForCall(ctx, cwd, mode = 'danger-full-access') {
  const result = { id: 'file-call', session: { id: 'file-call', mode, header: { cwd } } }
  const { createScope } = await import('@deepseek-ai/dsh-scope')
  result.ctx = createScope(ctx, result).ctx
  await ctx.serial('agent/created', { agent: result, source: 'startup' })
  return result
}
async function advancedMount(ctx, names) {
  return ctx.plugin(legacyComponent(discovery), { required: true, enabled: false, allowedTools: names, alwaysLoaded: names })
}
async function component(ctx, name, config = {}) {
  return ctx.plugin({ name: `fixture-${name}`, apply(inner) { return applyComponent(inner, { ...config }, name) } })
}
async function executor(ctx) {
  await ctx.plugin(inner => {
    inner.provide('subprocess', { spawn() { throw new Error('fixture does not execute commands') } })
    inner.provide('sandboxPolicy', { resolve({ session }) { return { mode: session.mode, workspaceRoot: session.header.cwd } } })
    inner.provide('sandbox', { async confine(argv) { return { argv, enforcement: 'full' } } })
  })
}
async function agent(ctx, id, mode = 'danger-full-access', parent) {
  const { createScope } = await import('@deepseek-ai/dsh-scope')
  const result = { id, session: { id, mode, header: { cwd: process.cwd() } } }
  let scope
  await (parent?.ctx ?? ctx).plugin({ inject: ['tools'], apply(inner) { scope = createScope(inner, result) } })
  result.ctx = scope.ctx
  await ctx.serial('agent/created', { agent: result, source: 'startup' })
  return result
}
async function sections(ctx, currentAgent) { return renderSections(ctx, currentAgent) }
async function visible(ctx, currentAgent, expected) {
  await waitFor(() => expected.every(name => scopedToolNames(ctx, currentAgent).includes(name)), { timeoutMs: 5000, what: expected.join(', ') })
}
await test('file mount owns exactly the declared native tools and never overrides the registry', async () => {
  const { ctx } = await bootHost()
  try {
    const { tools } = await fileMount(ctx)
    assert.deepEqual(tools, EXPECTED)
    assert.equal(registryHasOwnRegister(ctx), false)
    assert.deepEqual(registryNames(ctx), EXPECTED)
    assert.equal(registryNames(ctx).some(name => name.includes('__')), false)
  } finally { await shutdown(ctx) }
})
await test('foreign tools keep their names, and survive plugin disposal', async () => {
  const { ctx } = await bootHost()
  try {
    const { fiber } = await fileMount(ctx)
    const registry = ctx.get('tools')
    const names = ['foreign', 'mcp__someone-else__glob', 'mcp__fastctx__foreign', 'ops_lookalike']
    const disposers = names.map(name => registry.register(foreignTool(name)))
    for (const name of names) assert.ok(registryNames(ctx).includes(name))
    await fiber.dispose()
    assert.deepEqual(registryNames(ctx), [...names].sort())
    assert.equal(registryHasOwnRegister(ctx), false)
    for (const dispose of disposers) dispose()
    assert.deepEqual(registryNames(ctx), [])
  } finally { await shutdown(ctx) }
})
await test('the same foreign name registers in two real scopes without becoming global', async () => {
  const { ctx } = await bootHost()
  try {
    await fileMount(ctx)
    const first = await mountScopedToolPlugin(ctx, { scope: 'first', toolName: 'subagent' })
    const second = await mountScopedToolPlugin(ctx, { scope: 'second', toolName: 'subagent' })
    for (const scope of [first.scopeKey, second.scopeKey]) assert.ok(scopedToolNames(ctx, scope).includes('subagent'))
    assert.equal(registryNames(ctx).includes('subagent'), false)
    await first.dispose(); await second.dispose()
    assert.deepEqual(registryNames(ctx), EXPECTED)
  } finally { await shutdown(ctx) }
})
await test('PTC batch/result mount only in pure PTC scopes and withdraw on presentation teardown', async () => {
  const { ctx } = await bootHost()
  try {
    await executor(ctx)
    await ctx.plugin(inner => inner.provide('ptcRuntime', { language: 'typescript' }))
    const component = await ctx.plugin(legacyComponent(ptc), { binaryPath: resolveWorker(), required: true, alwaysLoaded: ['batch'] })
    const native = await agent(ctx, 'ptc-native')
    const pure = await agent(ctx, 'ptc-only')
    let lift
    await pure.ctx.plugin({ inject: ['tools'], apply(inner) { lift = inner.tools.presentAs('ptc') } })
    await visible(ctx, pure, ['ops_batch', 'ops_result'])
    for (const name of ['ops_batch', 'ops_result']) {
      assert.equal(registryNames(ctx).includes(name), false)
      assert.equal(scopedToolNames(ctx, native).includes(name), false)
    }
    const stale = ctx.get('tools').get('ops_result', pure)
    lift()
    await ctx.get('systemPrompt').assemble({ scope: pure })
    assert.equal(scopedToolNames(ctx, pure).includes('ops_result'), false)
    assert.equal((await stale.execute({ action: 'page', id: 'unused' }, { agent: pure, signal: new AbortController().signal })).error.code, 'POLICY_DENIED')
    await component.dispose()
    assert.equal((await sections(ctx, pure)).has('tools:ptc-only'), false)
    assert.equal(registryHasOwnRegister(ctx), false)
  } finally { await shutdown(ctx) }
})
await test('real native file calls return data and propagate errors promptly', async () => {
  const { ctx } = await bootHost()
  try {
    await fileMount(ctx)
    await advancedMount(ctx, ['inspect_local_file', 'write_file', 'stat', 'glob'])
    await withTempDir('glob', async dir => {
      fs.writeFileSync(path.join(dir, 'alpha.txt'), 'alpha\n')
      const agent = await agentForCall(ctx, dir)
      const created = await callTool(ctx, publicToolName('write_file'), { path: 'created.txt', expectedRevision: 'absent', content: 'created' }, undefined, agent)
      assert.equal(created.value.status, 'completed', JSON.stringify(created.value))
      const stat = await callTool(ctx, publicToolName('stat'), { path: 'created.txt' }, undefined, agent)
      assert.equal(stat.value.revision, created.value.revision)
      const result = await callTool(ctx, publicToolName('glob'), { pattern: ['*.txt'], path: dir }, undefined, agent)
      assert.match(result.text, /alpha\.txt/)
      assert.equal(fs.realpathSync.native(result.value.items[0]), fs.realpathSync.native(path.join(dir, 'alpha.txt')))
      const missing = await callTool(ctx, publicToolName('inspect_local_file'), { path: path.join(dir, 'missing.txt') }, undefined, agent)
      assert.equal(missing.value.error.code, 'NOT_FOUND')
    })
  } finally { await shutdown(ctx) }
})
await test('native file paths resolve from session cwd and enforce workspace-write boundaries', async () => {
  const { ctx } = await bootHost()
  try {
    await fileMount(ctx)
    await advancedMount(ctx, ['inspect_local_file', 'glob', 'replace'])
    await withTempDir('native-paths', async dir => {
      fs.writeFileSync(path.join(dir, 'cwd.txt'), 'cwd\n')
      const workspace = await agentForCall(ctx, dir, 'workspace-write')
      const relative = await callTool(ctx, publicToolName('glob'), { pattern: ['cwd.txt'], path: '.' }, undefined, workspace)
      assert.equal(relative.value.status, 'completed')
      assert.deepEqual(relative.value.items.map(item => fs.realpathSync.native(item)), [fs.realpathSync.native(path.join(dir, 'cwd.txt'))])
      const outside = path.join(path.dirname(dir), 'outside-native.txt')
      fs.writeFileSync(outside, 'outside\n')
      try {
        const read = await callTool(ctx, publicToolName('inspect_local_file'), { path: outside }, undefined, workspace)
        assert.equal(read.value.status, 'completed')
        workspace.session.mode = 'read-only'
        const readonly = workspace
        const denied = await callTool(ctx, publicToolName('replace'), { path: outside, pattern: 'outside', replacement: 'changed' }, undefined, readonly)
        assert.equal(denied.value.error.code, 'POLICY_DENIED')
        assert.match(denied.value.error.message, /User authorization/)
        assert.match(denied.value.error.nextAction, /Ask the user/)
        assert.equal(fs.readFileSync(outside, 'utf8'), 'outside\n')
      } finally { fs.rmSync(outside, { force: true }) }
    })
  } finally { await shutdown(ctx) }
})
await test('the file component renders its live tools and retires both legacy sections', async () => {
  const { ctx } = await bootHost()
  try {
    const { fiber } = await fileMount(ctx)
    const rendered = await sections(ctx)
    for (const name of EXPECTED) assert.ok(rendered.get(FILE_SECTION).includes(name))
    for (const name of ['dsh-ops:host-shell-policy', 'mcp:fastctx', SHELL_SECTION, BG_SECTION]) assert.equal(rendered.has(name), false)
    await fiber.dispose()
    assert.deepEqual(publicToolNames(ctx), [])
    assert.equal((await sections(ctx)).has(FILE_SECTION), false)
  } finally { await shutdown(ctx) }
})
await test('optional missing runtime degrades honestly, required runtime rejects activation', async () => {
  const { ctx } = await bootHost()
  try {
    const binaryPath = path.join(process.cwd(), 'no-such-worker.exe')
    const { fiber } = await mountPlugin({ ctx, config: { binaryPath }, expectTools: 0 })
    assert.deepEqual(publicToolNames(ctx), [])
    assert.equal((await sections(ctx)).get(FILE_SECTION) ?? '', '')
    await fiber.dispose()
    await assert.rejects(() => mountPlugin({ ctx, config: { binaryPath, required: true }, expectTools: 0 }), /binaryPath/)
  } finally { await shutdown(ctx) }
})
await test('promptPolicy false leaves tools live with no prompt section', async () => {
  const { ctx } = await bootHost()
  try {
    await fileMount(ctx, { promptPolicy: false })
    assert.deepEqual(publicToolNames(ctx), EXPECTED)
    assert.equal((await sections(ctx)).has(FILE_SECTION), false)
  } finally { await shutdown(ctx) }
})
await test('bash is scoped to authorized sessions, responds to mode changes, and unloads cleanly', async () => {
  const { ctx } = await bootHost()
  try {
    await executor(ctx)
    const shell = await component(ctx, 'shell', { bashPath: process.execPath })
    const full = await agent(ctx, 'full')
    await visible(ctx, full, [BASH_TOOL])
    const restricted = await agent(ctx, 'restricted', 'workspace-write', full)
    await visible(ctx, restricted, [BASH_TOOL])
    assert.equal(registryNames(ctx).includes(BASH_TOOL), false)
    const text = (await sections(ctx, full)).get(SHELL_SECTION)
    assert.ok(text.includes(BASH_TOOL))
    assert.equal(((await sections(ctx, restricted)).get(SHELL_SECTION) ?? '').includes(BASH_TOOL), true)
    const definition = ctx.get('tools').get(BASH_TOOL, full)
    full.session.mode = 'read-only'
    await ctx.serial('session/event', full.session, { type: 'sandbox/mode' })
    await visible(ctx, full, [BASH_TOOL])
    if (process.platform === 'win32') {
      const restrictedResult = await definition.execute({ command: 'echo no', description: 'Verify the current scoped shell authority' }, { agent: full, signal: new AbortController().signal })
      assert.equal(restrictedResult.status, 'failed')
      assert.match(restrictedResult.error, /EXECUTOR_UNAVAILABLE/)
      assert.equal(restrictedResult.permission, undefined)
    } else {
      const value = await definition.execute({ command: 'echo no', description: 'Verify the current scoped shell authority' }, { agent: full, signal: new AbortController().signal })
      assert.equal(value.sandbox.mode, 'read-only')
      assert.match(value.error, /fixture does not execute/)
    }
    full.session.mode = 'danger-full-access'
    await ctx.serial('session/event', full.session, { type: 'sandbox/mode' })
    await visible(ctx, full, [BASH_TOOL])
    await shell.dispose()
    assert.equal(scopedToolNames(ctx, full).includes(BASH_TOOL), false)
    assert.equal((await sections(ctx, full)).has(SHELL_SECTION), false)
    assert.equal(registryHasOwnRegister(ctx), false)
  } finally { await shutdown(ctx) }
})
await test('without permission authority or subprocess a resolved bash is not advertised', async () => {
  const { ctx } = await bootHost()
  try {
    await component(ctx, 'shell', { bashPath: process.execPath })
    const full = await agent(ctx, 'missing-authority')
    assert.equal(scopedToolNames(ctx, full).includes(BASH_TOOL), false)
    assert.equal(((await sections(ctx, full)).get(SHELL_SECTION) ?? '').includes(BASH_TOOL), false)
  } finally { await shutdown(ctx) }
})
await test('advise preserves host tools; explicit deny works without ops commands and lifts on unload', async () => {
  const { ctx } = await bootHost()
  try {
    const registry = ctx.get('tools')
    const disposers = ['pwsh', 'bash', 'pwsh_persistent'].map(name => registry.register(foreignTool(name)))
    const advice = await component(ctx, 'shell', { publishBashTool: false })
    const advised = await agent(ctx, 'advised')
    assert.ok(scopedToolNames(ctx, advised).includes('bash'))
    assert.deepEqual(await preExecute(ctx, 'bash'), { kind: 'allow' })
    await advice.dispose()
    const denial = await component(ctx, 'shell', { shellPolicy: 'deny-host-shell', publishBashTool: false })
    await waitFor(() => ctx.get('tools').get('bash') !== undefined)
    // Cordis injection fibers settle after the component fiber mounts.
    await new Promise(resolve => setImmediate(resolve))
    const denied = await agent(ctx, 'denied')
    await waitFor(() => !scopedToolNames(ctx, denied).includes('bash'), { timeoutMs: 5000 })
    for (const name of ['bash', 'pwsh', 'pwsh_persistent']) {
      assert.equal(scopedToolNames(ctx, denied).includes(name), false)
      assert.equal((await preExecute(ctx, name)).kind, 'deny')
      assert.ok(registryNames(ctx).includes(name))
    }
    for (const name of ['ops_glob', 'read', 'edit']) assert.deepEqual(await preExecute(ctx, name), { kind: 'allow' })
    await denial.dispose()
    assert.ok(scopedToolNames(ctx, denied).includes('bash'))
    assert.deepEqual(await preExecute(ctx, 'bash'), { kind: 'allow' })
    for (const dispose of disposers) dispose()
  } finally { await shutdown(ctx) }
})
await test('a file row written by an earlier bundle still mounts and publishes its tools', async () => {
  // Every existing profile's file row carries the FastCtx-only keys until config update 2 rewrites
  // it; activation must not fail on them in between.
  const { ctx } = await bootHost()
  try {
    await ctx.plugin(Subprocess)
    await ctx.plugin(Sandbox, {})
    await ctx.plugin(inner => inner.provide('sandboxPolicy', {
      resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: session.header.cwd, sessionId: session.id }),
    }))
    const file = await component(ctx, 'file', LEGACY_ROWS.file)
    await waitFor(() => publicToolNames(ctx).length === EXPECTED.length, { timeoutMs: 10000, what: EXPECTED.join(', ') })
    assert.deepEqual(publicToolNames(ctx), EXPECTED)
    const rendered = await sections(ctx)
    for (const name of EXPECTED) assert.ok(rendered.get(FILE_SECTION).includes(name))
    assert.equal(rendered.has(BG_SECTION), false)
    await file.dispose()
    assert.deepEqual(publicToolNames(ctx), [])
  } finally { await shutdown(ctx) }
})
await test('an old background row loads as a no-op: no tools, no section, one warning', async () => {
  const { ctx } = await bootHost()
  const warnings = []
  ctx.logger.exporter({ levels: { default: 4 }, export(message) { warnings.push(message.args.join(' ')) } })
  try {
    const url = pathToFileURL(path.join(PACKAGE_ROOT, 'lib', 'components', 'background', 'index.js')).href
    const stub = await import(`${url}?tag=${Date.now()}`)
    assert.equal(stub.name, 'dsh-ops-background')
    // Any config is accepted, including keys no component has ever validated.
    const fiber = await ctx.plugin(stub, { ...LEGACY_ROWS.background, serverName: 'fastctx', bashPath: '/x', unknownKey: 1 })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(registryNames(ctx), [])
    assert.deepEqual(publicToolNames(ctx), [])
    const shown = await agent(ctx, 'background-stub')
    for (const name of ['ops_run', 'ops_run_background', 'ops_job_output', 'ops_job_list', 'ops_job_kill']) {
      assert.equal(scopedToolNames(ctx, shown).includes(name), false, `${name} is not published`)
    }
    assert.equal((await sections(ctx, shown)).has(BG_SECTION), false)
    const removed = warnings.filter(message => message.includes('saved "background" row is retired'))
    assert.equal(removed.length, 1, `exactly one removal warning: ${JSON.stringify(warnings)}`)
    assert.match(removed[0], /Remove that patch entry/)
    await fiber.dispose()
  } finally { await shutdown(ctx) }
})
await test('the host half refuses to mount a background component itself', () => {
  assert.throws(() => applyComponent({}, {}, 'background'), /unknown component "background"/)
})
await test('selected replacements fail closed when the file row publishes only its resident core', async () => {
  const { ctx } = await bootHost()
  try {
    await fileMount(ctx)
    for (const name of ['read', 'glob', 'grep']) ctx.tools.register(foreignTool(name))
    const { apply: hideOfficial } = await import('../lib/official-tool-hiding.js')
    const hiding = await ctx.plugin(legacyComponent({ name: 'selected-file-takeover', apply: hideOfficial }), { replaceTools: ['read', 'glob', 'grep'] })
    const current = await agent(ctx, 'selected-file-takeover')
    await assert.rejects(() => ctx.get('systemPrompt').assemble({ scope: current }), /READINESS_BLOCKED/)
    for (const name of ['read', 'glob', 'grep']) assert.ok(ctx.tools.schemas(current).some(tool => tool.name === name))
    await hiding.dispose()
    const assembly = await ctx.get('systemPrompt').assemble({ scope: current })
    for (const name of ['read', 'glob', 'grep', ...EXPECTED]) assert.ok(assembly.tools.some(tool => tool.name === name))
    assert.equal(assembly.tools.some(tool => tool.name.startsWith('ops_process_')), false)
  } finally { await shutdown(ctx) }
})
report('mount')
