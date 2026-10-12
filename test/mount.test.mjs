/** Real Cordis/tool/prompt composition with the released independent components. */
import fs from 'node:fs'
import path from 'node:path'
import { resolveConfig } from '../lib/config.js'
import { BASH_TOOL, FILE_TOOLS, BACKGROUND_TOOLS, TOOLING_SECTION, publicToolName } from '../lib/policy.js'
import { FastCtxTools, childEnv } from '../lib/tools.js'
import { applyComponent } from '../lib/index.js'
import { assert, report, skipSuite, test, waitFor, withTempDir } from './lib/harness.mjs'
import { bootHost, callTool, mountPlugin, mountScopedToolPlugin, preExecute, publicToolNames,
  registryHasOwnRegister, registryNames, renderSections, resolveRuntime, scopedToolNames,
  shutdown, tryResolveRuntime } from './lib/host.mjs'
const EXPECTED = FILE_TOOLS.map(publicToolName).sort()
const FILE_SECTION = `${TOOLING_SECTION}:file`
const SHELL_SECTION = `${TOOLING_SECTION}:shell`
const BG_SECTION = `${TOOLING_SECTION}:background`
const runtime = tryResolveRuntime()
if (!runtime.ok) {
  if (process.env.DSH_OPS_REQUIRE_RUNTIME === '1') throw new Error(runtime.reason)
  skipSuite('mount', runtime.reason)
}
console.log(`  runtime: ${runtime.file} (${runtime.source}, ${runtime.version})`)
function foreignTool(name) {
  return { name, description: 'foreign fixture', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) }
}
async function fileMount(ctx, config = {}) {
  return mountPlugin({ ctx, config: { toolCallTimeoutMs: 5000, ...config }, expectTools: EXPECTED.length })
}
async function component(ctx, name, config = {}) {
  return ctx.plugin({ name: `fixture-${name}`, apply(inner) { return applyComponent(inner, { toolCallTimeoutMs: 5000, ...config }, name) } })
}
async function executor(ctx) {
  await ctx.plugin(inner => {
    inner.provide('subprocess', { spawn() { throw new Error('fixture does not execute commands') } })
    inner.provide('sandboxPolicy', { resolve({ session }) { return { mode: session.mode } } })
  })
}
async function agent(ctx, id, mode = 'danger-full-access', parent, header = { cwd: process.cwd() }) {
  const { createScope } = await import('@deepseek-ai/dsh-scope')
  // The header is the session's own: a caller passes a working directory, or a
  // header without one, instead of the process directory this fixture defaults
  // to. The session's working directory is what `fileToolRoot: 'session'` reads.
  const result = { id, session: { mode, header } }
  let scope
  await (parent?.ctx ?? ctx).plugin({ inject: ['tools'], apply(inner) { scope = createScope(inner, result) } })
  result.ctx = scope.ctx
  await ctx.serial('agent/created', { agent: result, source: 'startup' })
  return result
}
async function callWithAgent(ctx, name, args, currentAgent) {
  // `callTool` in test/lib/host.mjs sends no agent, and this task does not own
  // that file; this is the same call the loop makes, with the session attached.
  // The lookup resolves through that session's own scope chain, because the
  // command tools are published per session rather than into the root registry.
  const definition = ctx.get('tools').get(name, currentAgent)
  if (definition === undefined) throw new Error(`tool "${name}" is not registered`)
  const exec = { callId: 'test', name, arguments: args, signal: new AbortController().signal, agent: currentAgent }
  const value = await definition.execute(args, exec)
  const content = definition.output.render(args, value)
  return { value, content, text: content.filter((block) => block.type === 'text').map((block) => block.text).join('\n') }
}
/**
 * The job's own output, without the server's trailing status decoration.
 *
 * `job_output` appends a `(Complete: job j-xxxxxx exited 0; …)` line that names
 * the job, so two runs of the same command can never be compared verbatim until
 * it is removed. The command's output is what a caller reads as the job's
 * effect, so that is what a reading comparison compares. `payload` is this
 * project's word for a platform binary package, so the job's text is not one.
 * @param {string} text - the rendered `job_output` text.
 * @returns {string} the job's output alone.
 */
function jobOutput(text) {
  return text.replace(/\s*\((?:Complete|Partial|Killed):[^)]*\)\s*$/, '').trim()
}
async function sections(ctx, currentAgent) { return renderSections(ctx, currentAgent) }
async function visible(ctx, currentAgent, expected) {
  await waitFor(() => expected.every(name => scopedToolNames(ctx, currentAgent).includes(name)), { timeoutMs: 5000, what: expected.join(', ') })
}
await test('file mount owns exactly four tools and never overrides the registry', async () => {
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
await test('real FastCtx calls return data and propagate server errors promptly', async () => {
  const { ctx } = await bootHost()
  try {
    await fileMount(ctx)
    await withTempDir('glob', async dir => {
      fs.writeFileSync(path.join(dir, 'alpha.txt'), 'alpha\n')
      const result = await callTool(ctx, publicToolName('glob'), { pattern: ['*.txt'], path: dir })
      assert.match(result.text, /alpha\.txt/)
      assert.equal(result.value.content[0].type, 'text')
      await assert.rejects(() => callTool(ctx, publicToolName('inspect_local_file'), { file_path: path.join(dir, 'missing.txt') }), /missing\.txt/)
    })
  } finally { await shutdown(ctx) }
})
await test('an omitted glob path searches the calling session working directory', async () => {
  const { ctx } = await bootHost()
  try {
    await fileMount(ctx)
    await withTempDir('session-root', async dir => {
      fs.writeFileSync(path.join(dir, 'file-tool-root-probe.txt'), 'the session-root probe\n')
      // The premise this check rests on: the process directory is the
      // repository, so a hit inside the temporary directory can only come from
      // the session's own root — FastCtx never returns a file outside its root.
      assert.notEqual(fs.realpathSync(dir).toLowerCase(), fs.realpathSync(process.cwd()).toLowerCase(),
        'the fixture needs a session root outside the process root')
      const session = await agent(ctx, 'session-root', 'danger-full-access', undefined, { cwd: dir })
      const result = await callWithAgent(ctx, publicToolName('glob'), { pattern: ['**/file-tool-root-probe.txt'] }, session)
      assert.match(result.text, /file-tool-root-probe\.txt/, 'an omitted path must find the session root file')
      assert.equal(result.text.includes('no files matched'), false, 'an omitted path must not report the process root')
    })
  } finally { await shutdown(ctx) }
})
await test('an omitted grep path searches the calling session working directory', async () => {
  const { ctx } = await bootHost()
  try {
    await fileMount(ctx)
    await withTempDir('session-grep', async dir => {
      fs.writeFileSync(path.join(dir, 'session-grep-probe.txt'), 'dsh-ops-session-root-marker\n')
      const session = await agent(ctx, 'session-grep', 'danger-full-access', undefined, { cwd: dir })
      const result = await callWithAgent(ctx, publicToolName('grep'), { pattern: 'dsh-ops-session-root-marker' }, session)
      assert.match(result.text, /session-grep-probe\.txt/, 'an omitted path must search the session root')
    })
  } finally { await shutdown(ctx) }
})
await test('a null file-tool path is treated as an omitted path', async () => {
  const { ctx } = await bootHost()
  try {
    await fileMount(ctx)
    await withTempDir('null-root', async dir => {
      fs.writeFileSync(path.join(dir, 'file-tool-root-probe.txt'), 'the null-root probe\n')
      const session = await agent(ctx, 'null-root', 'danger-full-access', undefined, { cwd: dir })
      const args = { pattern: ['**/file-tool-root-probe.txt'] }
      const omitted = await callWithAgent(ctx, publicToolName('glob'), args, session)
      // FastCtx normalises `path: null` to "absent" itself, so a plugin that
      // only tested for `undefined` would leave this argument as the bypass.
      const explicitNull = await callWithAgent(ctx, publicToolName('glob'), { ...args, path: null }, session)
      assert.match(explicitNull.text, /file-tool-root-probe\.txt/, 'a null path must still reach the session root')
      assert.equal(explicitNull.text, omitted.text, 'a null path must read exactly like an omitted path')
    })
  } finally { await shutdown(ctx) }
})
await test('fileToolRoot process keeps the pre-change FastCtx process reading', async () => {
  const { ctx } = await bootHost()
  try {
    await fileMount(ctx, { fileToolRoot: 'process' })
    await withTempDir('process-root', async dir => {
      fs.writeFileSync(path.join(dir, 'file-tool-root-probe.txt'), 'unreachable from the process root\n')
      const session = await agent(ctx, 'process-root', 'danger-full-access', undefined, { cwd: dir })
      const args = { pattern: ['**/file-tool-root-probe.txt'] }
      const omitted = await callWithAgent(ctx, publicToolName('glob'), args, session)
      // The old reading, byte for byte: FastCtx inherits this host process's
      // directory, and the probe file lives outside it.
      const processRoot = await callWithAgent(ctx, publicToolName('glob'), { ...args, path: process.cwd() }, session)
      assert.equal(omitted.text, processRoot.text, 'fileToolRoot "process" must keep the process-root reading verbatim')
      assert.equal(omitted.text.includes('file-tool-root-probe.txt'), false,
        'fileToolRoot "process" must not search the session root')
      // The key governs the omitted default only: an explicit path still works.
      const explicit = await callWithAgent(ctx, publicToolName('glob'), { ...args, path: dir }, session)
      assert.match(explicit.text, /file-tool-root-probe\.txt/, 'an explicit path is unaffected by the key')
    })
  } finally { await shutdown(ctx) }
})
await test('an omitted path without a session working directory fails, not an empty set', async () => {
  const { ctx } = await bootHost()
  try {
    await fileMount(ctx)
    const rootless = await agent(ctx, 'no-session-root', 'danger-full-access', undefined, {})
    for (const [rawName, args] of [['glob', { pattern: ['**/*'] }], ['grep', { pattern: 'anything' }]]) {
      await assert.rejects(
        () => callWithAgent(ctx, publicToolName(rawName), args, rootless),
        (error) => {
          assert.match(error.message, /no working directory/, 'the failure names the cause')
          assert.match(error.message, /Pass path explicitly/, 'the failure offers the first next step')
          assert.match(error.message, /fileToolRoot/, 'the failure offers the second next step')
          return true
        },
      )
    }
    // A missing session root never blocks a call that names its own path.
    await withTempDir('rootless', async dir => {
      fs.writeFileSync(path.join(dir, 'rootless-probe.txt'), 'explicit path\n')
      const explicit = await callWithAgent(ctx, publicToolName('glob'), { pattern: ['*.txt'], path: dir }, rootless)
      assert.match(explicit.text, /rootless-probe\.txt/, 'a missing session root never blocks an explicit path')
    })
  } finally { await shutdown(ctx) }
})
await test('a non-string or blank session root fails an omitted path, and never becomes that path', async () => {
  const { ctx } = await bootHost()
  try {
    await fileMount(ctx)
    // Only a usable string root may be substituted for an omitted path. A
    // number, an empty string and an all-whitespace string all reach the same
    // fail-closed branch: the caller is told the cause and both ways out, and
    // the unusable value is never forwarded to FastCtx as the argument.
    const unusable = [['a numeric cwd', { cwd: 42 }], ['an empty cwd', { cwd: '' }],
      ['a blank cwd', { cwd: '   ' }], ['a null cwd', { cwd: null }]]
    for (const [index, [label, header]] of unusable.entries()) {
      const session = await agent(ctx, `unusable-root-${index}`, 'danger-full-access', undefined, header)
      for (const [rawName, args] of [['glob', { pattern: ['**/*'] }], ['grep', { pattern: 'anything' }]]) {
        await assert.rejects(
          () => callWithAgent(ctx, publicToolName(rawName), args, session),
          (error) => {
            assert.match(error.message, /cannot resolve an omitted path/, `${label}: ${rawName} must fail closed`)
            assert.match(error.message, /no working directory/, `${label}: ${rawName} must name the cause`)
            assert.match(error.message, /Pass path explicitly/, `${label}: ${rawName} must offer the first next step`)
            assert.match(error.message, /fileToolRoot/, `${label}: ${rawName} must offer the second next step`)
            return true
          },
        )
      }
    }
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
    const binaryPath = path.join(process.cwd(), 'no-such-fastctx.exe')
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
    await waitFor(() => !scopedToolNames(ctx, restricted).includes(BASH_TOOL), { timeoutMs: 5000 })
    assert.equal(registryNames(ctx).includes(BASH_TOOL), false)
    const text = (await sections(ctx, full)).get(SHELL_SECTION)
    assert.ok(text.includes(BASH_TOOL))
    assert.equal(((await sections(ctx, restricted)).get(SHELL_SECTION) ?? '').includes(BASH_TOOL), false)
    const definition = ctx.get('tools').get(BASH_TOOL, full)
    full.session.mode = 'read-only'
    await ctx.serial('session/event', full.session, { type: 'sandbox/mode' })
    assert.equal(scopedToolNames(ctx, full).includes(BASH_TOOL), false)
    await assert.rejects(async () => definition.execute({ command: 'echo no' }, { agent: full }), /authoritative danger-full-access/)
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
await test('file/background share runtime, but command tools never leak into global or restricted scopes', async () => {
  const { ctx } = await bootHost()
  try {
    await executor(ctx)
    const file = await fileMount(ctx)
    const background = await component(ctx, 'background')
    const full = await agent(ctx, 'background-full')
    const jobs = BACKGROUND_TOOLS.map(publicToolName)
    await visible(ctx, full, jobs)
    const child = await agent(ctx, 'background-restricted', 'read-only', full)
    await waitFor(() => jobs.every(name => !scopedToolNames(ctx, child).includes(name)), { timeoutMs: 5000 })
    assert.deepEqual(registryNames(ctx), EXPECTED)
    assert.equal(scopedToolNames(ctx, full).includes('ops_run'), false)
    assert.match((await sections(ctx, full)).get(BG_SECTION), /Only operate on job IDs you started/)
    await file.fiber.dispose()
    await visible(ctx, full, jobs)
    assert.deepEqual(registryNames(ctx), [])
    await background.dispose()
    assert.equal(jobs.some(name => scopedToolNames(ctx, full).includes(name)), false)
    assert.equal((await sections(ctx, full)).has(BG_SECTION), false)
  } finally { await shutdown(ctx) }
})
await test('an omitted run_background cwd starts the job in the calling session working directory', async () => {
  const { ctx } = await bootHost()
  try {
    await executor(ctx)
    await fileMount(ctx)
    // Each reading waits for its job to finish inside the per-call deadline, so
    // that deadline has to outlast the wait below.
    const background = await component(ctx, 'background', { toolCallTimeoutMs: 15_000 })
    const full = await agent(ctx, 'background-cwd-full')
    const jobs = BACKGROUND_TOOLS.map(publicToolName)
    await visible(ctx, full, jobs)
    await withTempDir('background-cwd', async dir => {
      const session = await agent(ctx, 'background-cwd', 'danger-full-access', full, { cwd: dir })
      await waitFor(() => jobs.every(name => scopedToolNames(ctx, session).includes(name)),
        { timeoutMs: 5000, what: 'the session command tools' })
      // The premise the negative assertion rests on: the session directory and
      // the process directory are different places, so a reading of one cannot
      // be a reading of the other.
      assert.notEqual(fs.realpathSync(dir).toLowerCase(), fs.realpathSync(process.cwd()).toLowerCase(),
        'the fixture needs a session root outside the process root')
      // `pwd` is short-lived and prints its own working directory, so the
      // reading is a pure function of the directory the job started in — the
      // same command makes the two directories comparable without naming them.
      const reading = async (args) => {
        const started = await callWithAgent(ctx, publicToolName('run_background'), args, session)
        const id = /job (j-[a-z0-9]{6}) started/.exec(started.text)?.[1]
        assert.ok(id, `run_background must return a job ID, got: ${started.text}`)
        const output = await callWithAgent(ctx, publicToolName('job_output'), { job_id: id, wait_ms: 15000 }, session)
        return jobOutput(output.text)
      }
      const omitted = await reading({ command: 'pwd' })
      const explicit = await reading({ command: 'pwd', cwd: dir })
      // The contract lib/presentation.js states for an omitted `cwd`: it means
      // the calling session's working directory, not FastCtx's own.
      assert.equal(omitted, explicit, 'an omitted cwd must read exactly like the session working directory')
      const processRoot = await reading({ command: 'pwd', cwd: process.cwd() })
      assert.notEqual(omitted, processRoot, 'an omitted cwd must not fall back to the FastCtx process directory')
    })
  } finally { await shutdown(ctx) }
})
await test('a dead server withdraws and republishes real file tools', async () => {
  const registered = new Map(), messages = []
  const surface = new FastCtxTools({ ctx: { tools: { register(definition) {
    registered.set(definition.name, definition); return () => registered.delete(definition.name)
  } } }, config: resolveConfig({ enableShellTools: false, toolCallTimeoutMs: 5000 }), runtime: resolveRuntime(),
    report: message => messages.push(message) })
  try {
    assert.deepEqual((await surface.start()).sort(), EXPECTED)
    surface.client.child.kill()
    await waitFor(() => !surface.client, { timeoutMs: 5000 })
    assert.deepEqual([...registered.keys()], [])
    await waitFor(() => surface.names().length === EXPECTED.length, { timeoutMs: 10000 })
    assert.ok(messages.some(message => message.includes('reconnected')))
  } finally { await surface.stop() }
  assert.equal(registered.size, 0)
})
await test('missing approved bash blocks background publication and isolates shared runtime policy', async () => {
  const { ctx } = await bootHost()
  try {
    await executor(ctx)
    await fileMount(ctx)
    const ready = []
    ctx.logger.exporter({ levels: { default: 4 }, export(message) { ready.push(message.args.join(' ')) } })
    const previous = process.env.FASTCTX_BASH
    process.env.FASTCTX_BASH = process.execPath
    let background
    try {
      background = await component(ctx, 'background', { bashPath: path.join(process.cwd(), 'absent-approved-bash.exe') })
      // A conflicting file lease with an approved executor must not lend its
      // executor to this background component. Inspect its real model surface.
      await waitFor(() => ready.some(message => message.includes('background component')), { timeoutMs: 5000, what: 'background handshake with disabled executor' })
      const full = await agent(ctx, 'no-approved-executor')
      await new Promise(resolve => setImmediate(resolve))
      for (const name of BACKGROUND_TOOLS.map(publicToolName)) assert.equal(scopedToolNames(ctx, full).includes(name), false)
      assert.deepEqual(registryNames(ctx), EXPECTED)
      assert.equal(((await sections(ctx, full)).get(BG_SECTION) ?? ''), '')
    } finally {
      if (previous === undefined) delete process.env.FASTCTX_BASH
      else process.env.FASTCTX_BASH = previous
      await background?.dispose()
    }
  } finally { await shutdown(ctx) }
})

await test('FastCtx child drops credentials and DSH facts', () => {
  const env = childEnv({ PATH: 'C:\\bin', HOME: 'C:\\home', GH_CONFIG_DIR: 'C:\\gh', GH_TOKEN: 'fixture', DSH_HOME: 'C:\\dsh', DEEPSEEK_API_KEY: 'fixture' })
  assert.equal(env.PATH, 'C:\\bin'); assert.equal(env.GH_CONFIG_DIR, 'C:\\gh')
  for (const key of ['GH_TOKEN', 'DSH_HOME', 'DEEPSEEK_API_KEY']) assert.equal(Object.hasOwn(env, key), false)
})
report('mount')
