/**
 * The mounted composition: the plugin hosting a real FastCtx binary over the
 * real tool registry, the real prompt assembly, and real registration scopes.
 *
 * This is the suite that would catch a wrong server command line, a tool that
 * never gets published, a prompt section that renders empty, a mount that leaks
 * its server — and, first of all, a plugin that reaches into the shared tool
 * registry. That last one shipped: patching `ToolRuntime.register` attributed
 * every foreign registration to this plugin's plane, so the host's second
 * registration of a name such as `subagent` threw and every new session failed.
 */

import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_DENIED_HOST_TOOLS, resolveConfig } from '../lib/config.js'
import { BASH_TOOL, FILE_TOOLS, HOST_SHELL_SECTION, SHELL_TOOLS, TOOLING_SECTION, publicToolName } from '../lib/policy.js'
import { FastCtxTools, childEnv } from '../lib/tools.js'
import { assert, report, skipSuite, test, waitFor, withTempDir, TEST_HOME } from './lib/harness.mjs'
import {
  bootHost,
  callTool,
  mountPlugin,
  mountScopedToolPlugin,
  preExecute,
  publicToolNames,
  registryHasOwnRegister,
  registryNames,
  renderSections,
  resolveRuntime,
  scopedToolNames,
  shutdown,
  tryResolveRuntime,
} from './lib/host.mjs'

const EXPECTED = [...FILE_TOOLS, ...SHELL_TOOLS].map(publicToolName).sort()

/**
 * A registration that belongs to someone else: this plugin must not rename it,
 * claim it, or count it as its own.
 * @param {string} name - the tool name.
 * @returns {object} a minimal valid tool definition.
 */
function foreignTool(name) {
  return {
    name,
    description: 'a registration this plugin does not own',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] },
    execute: async () => ({}),
  }
}

/**
 * The smallest registry that lets the tool surface run without a host, so the
 * connection lifecycle can be driven directly.
 * @returns {{ctx: object, names: () => string[], call: (name: string, args: object) => Promise<unknown>, reports: string[]}} the fixture.
 */
function surfaceFixture() {
  const registered = new Map()
  const reports = []
  return {
    reports,
    ctx: {
      tools: {
        register(definition) {
          if (registered.has(definition.name)) {
            throw new Error(`tool "${definition.name}" is already registered`)
          }
          registered.set(definition.name, definition)
          let live = true
          return () => {
            if (!live) return
            live = false
            registered.delete(definition.name)
          }
        },
      },
    },
    names: () => [...registered.keys()].sort(),
    call(name, args) {
      const definition = registered.get(name)
      if (definition === undefined) throw new Error(`tool "${name}" is not registered`)
      return definition.execute(args, {
        callId: 'fixture',
        name,
        arguments: args,
        signal: new AbortController().signal,
      })
    },
  }
}

/**
 * The two host shell names the visibility tests register for real. They are the
 * names the default denial list carries, registered as foreign tools exactly the
 * way a host composition registers its own shells.
 */
const HOST_SHELL_TOOLS = ['pwsh', 'bash']

/**
 * Collect every line this plugin reports through the host logger.
 *
 * The plugin reports through `ctx.logger` when it is present, so an exporter of
 * its own is the only way to see a bounded, once-per-mount warning.
 * @param {object} ctx - the host context.
 * @returns {string[]} the lines reported from now on, in order.
 */
function captureReports(ctx) {
  const lines = []
  ctx.logger.exporter({
    levels: { default: 4 },
    export: (message) => {
      lines.push(message.args.map((argument) => String(argument)).join(' '))
    },
  })
  return lines
}

/**
 * Mint an agent the way the loop does: one registered scope, and the agent
 * carrying it.
 *
 * The scoped context resolves services through the minting plugin's dependency
 * chain, so the minter must inject what the scope holders reach.
 * @param {object} ctx - the host context.
 * @param {string} id - the agent id, used as the scope key's identity.
 * @returns {Promise<{id: string, ctx: object}>} the agent.
 */
async function mintAgent(ctx, id) {
  const { createScope } = await import('@deepseek-ai/dsh-scope')
  const agent = { id }
  let scope
  await ctx.plugin(Object.assign((inner) => { scope = createScope(inner, agent) }, {
    inject: ['tools'],
  }))
  agent.ctx = scope.ctx
  return agent
}

/**
 * Mount the `subprocess` service the bash rung needs to publish its tool.
 *
 * The harness mounts none, so a host that resolves a bash still has no bash
 * rung: publishing `ops_bash` goes through this service. The fixture never runs
 * a command — the assertions are about which tools exist, not about executing
 * them — so `spawn` only has to exist.
 * @param {object} ctx - the host context.
 * @returns {Promise<any>} the fixture's fiber.
 */
function mountSubprocessFixture(ctx) {
  return ctx.plugin({
    name: 'fixture-subprocess',
    apply(inner) {
      inner.provide('subprocess', {
        spawn() { throw new Error('the mount suite never executes a command') },
      })
    },
  })
}

// ---------------------------------------------------------------------------
// The suite needs a real FastCtx binary, and says so instead of going green
// ---------------------------------------------------------------------------
//
// Everything below hosts a real runtime: the tools this suite asserts about are
// published by FastCtx itself. A machine with no build, no provisioned runtime,
// and no installed platform package therefore cannot answer here — and the one
// thing it must not do is pass. Resolution happens ONCE, here, before any check
// runs, and its answer decides:
//
//   - no runtime, DSH_OPS_REQUIRE_RUNTIME unset/0: the suite SKIPS. `run.mjs`
//     counts it as skipped, not passed, and prints the reason in its summary.
//   - no runtime, DSH_OPS_REQUIRE_RUNTIME=1: the suite FAILS, with the two ways
//     to get one. The integration job sets this, so a gate that quietly lost its
//     runtime cannot report success.
const runtime = tryResolveRuntime({ env: { ...process.env, DSH_HOME: TEST_HOME } })
if (runtime.ok !== true) {
  if (process.env.DSH_OPS_REQUIRE_RUNTIME === '1') {
    console.error(
      'dsh-ops mount: FAIL - DSH_OPS_REQUIRE_RUNTIME=1 but no FastCtx runtime is resolvable.\n'
      + `  ${runtime.reason}\n`
      + '  Build one from the vendored source:\n'
      + '    cargo build --release --locked --manifest-path vendor/fastctx/Cargo.toml\n'
      + '  or point the plugin at one:\n'
      + '    DSH_OPS_FASTCTX_BIN=<path to the fastctx executable>\n'
      + `  searched (${runtime.tried.length}):\n`
      + runtime.tried.map((candidate) => `    ${candidate.source}: ${candidate.file} (${candidate.detail})`).join('\n'),
    )
    process.exit(1)
  }
  skipSuite('mount', `no FastCtx runtime is resolvable (${runtime.reason}); `
    + 'build one, set DSH_OPS_FASTCTX_BIN, or set DSH_OPS_REQUIRE_RUNTIME=1 to require it')
}

// The runtime is resolved once, so it is worth saying which one answered: two
// machines running "the same" suite against different builds is exactly what a
// gate should make visible.
console.log(`  runtime: ${runtime.file} (${runtime.source}, ${runtime.version})`)

await test('the plugin publishes its own tools and leaves the shared registry alone', async () => {
  const { ctx } = await bootHost()
  try {
    const { tools } = await mountPlugin({ ctx, config: { enableShellTools: true }, expectTools: EXPECTED.length })
    assert.deepEqual(tools, EXPECTED)
    // `ToolRuntime.register` is a prototype method, so an OWN property on the
    // registry instance can only be an installed override — the exact shape
    // that shipped the incident.
    assert.equal(
      registryHasOwnRegister(ctx),
      false,
      'the shared tool registry must carry no own register override',
    )
    assert.deepEqual(registryNames(ctx), EXPECTED, 'the plugin publishes its own tools and nothing else')
    assert.deepEqual(
      registryNames(ctx).filter((name) => name.includes('__')),
      [],
      'no transport-qualified name may reach the model',
    )
  } finally {
    await shutdown(ctx)
  }
})

await test('a foreign registration keeps its own name', async () => {
  const { ctx } = await bootHost()
  try {
    await mountPlugin({ ctx, expectTools: EXPECTED.length })
    const registry = ctx.get('tools')
    // One name outside every namespace this plugin owns, and one inside ANOTHER
    // MCP server's namespace: the plugin publishes its own names and rewrites
    // nobody's.
    const disposeA = registry.register(foreignTool('fixture-foreign-tool'))
    const disposeB = registry.register(foreignTool('mcp__someone-else__glob'))
    const names = registryNames(ctx)
    assert.ok(names.includes('fixture-foreign-tool'), `expected the foreign tool to survive; got ${names.join(', ')}`)
    assert.ok(names.includes('mcp__someone-else__glob'), `expected a foreign server namespace to survive; got ${names.join(', ')}`)
    disposeA()
    disposeB()
    assert.deepEqual(publicToolNames(ctx), EXPECTED)
  } finally {
    await shutdown(ctx)
  }
})

await test('the same foreign tool name survives in two registration scopes', async () => {
  const { ctx } = await bootHost()
  try {
    await mountPlugin({ ctx, expectTools: EXPECTED.length })

    // The shipped incident in one scenario. An agent-plane plugin installs one
    // variant of a name per agent scope, so the same name in two scopes is legal
    // by design. While the plugin patched `register`, BOTH registrations were
    // attributed to the plugin's own (global) plane: the first landed there and
    // the second threw
    // `tool "subagent" is already registered (for a per-agent variant, register
    //  through that agent's `agent.ctx` instead)`, which failed every new
    // session the host tried to create.
    const first = await mountScopedToolPlugin(ctx, { scope: 'first', toolName: 'subagent' })
    const second = await mountScopedToolPlugin(ctx, { scope: 'second', toolName: 'subagent' })

    assert.ok(
      scopedToolNames(ctx, first.scopeKey).includes('subagent'),
      'the first scope must still see its own registration',
    )
    assert.ok(
      scopedToolNames(ctx, second.scopeKey).includes('subagent'),
      'the second scope must still see its own registration',
    )
    // Attribution is the whole disease: neither foreign registration may show up
    // in the plugin's own (global) view.
    assert.equal(
      registryNames(ctx).includes('subagent'),
      false,
      `a foreign registration must not be attributed to this plugin; got ${registryNames(ctx).join(', ')}`,
    )
    assert.deepEqual(publicToolNames(ctx), EXPECTED, 'the plugin tools stay published throughout')

    await first.dispose()
    await second.dispose()
    assert.deepEqual(registryNames(ctx), EXPECTED, 'disposing the scopes leaves exactly the plugin tools')
  } finally {
    await shutdown(ctx)
  }
})

await test('the plugin never rewrites a registration it did not make, mounted or unloaded', async () => {
  const { ctx } = await bootHost()
  const { fiber } = await mountPlugin({ ctx, expectTools: EXPECTED.length })
  const registry = ctx.get('tools')

  // Even a name in the namespace this plugin's own server would use is somebody
  // else's registration: it is published as registered, while mounted.
  const whileMounted = registry.register(foreignTool('mcp__fastctx__while-mounted'))
  const lookalike = registry.register(foreignTool('ops_lookalike'))
  assert.ok(registryNames(ctx).includes('mcp__fastctx__while-mounted'))
  assert.ok(registryNames(ctx).includes('ops_lookalike'))

  await fiber.dispose()
  await new Promise((resolve) => setTimeout(resolve, 500))

  // Unload removes every tool the plugin published and nothing else, so the
  // registry is left exactly as the plugin found it.
  assert.deepEqual(
    registryNames(ctx).filter((name) => name !== 'mcp__fastctx__while-mounted' && name !== 'ops_lookalike'),
    [],
    `unloading must publish no tool of its own; got ${registryNames(ctx).join(', ')}`,
  )
  assert.ok(
    registryNames(ctx).includes('mcp__fastctx__while-mounted'),
    `a foreign registration must outlive the plugin; got ${registryNames(ctx).join(', ')}`,
  )
  assert.ok(registryNames(ctx).includes('ops_lookalike'))
  whileMounted()
  lookalike()
  assert.deepEqual(registryNames(ctx), [])
  await shutdown(ctx)
})

await test('disabling the shell tools publishes only the four file tools', async () => {
  const { ctx } = await bootHost()
  try {
    await mountPlugin({ ctx, config: { enableShellTools: false }, expectTools: FILE_TOOLS.length })
    // Give the server a moment to register anything it was going to: the
    // assertion is "exactly four", not "at least four".
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.deepEqual(publicToolNames(ctx), FILE_TOOLS.map(publicToolName).sort())
  } finally {
    await shutdown(ctx)
  }
})

await test('a real tool call round-trips through FastCtx', async () => {
  const { ctx } = await bootHost()
  try {
    await mountPlugin({ ctx, expectTools: EXPECTED.length })
    await withTempDir('glob', async (dir) => {
      fs.writeFileSync(path.join(dir, 'alpha.txt'), 'alpha\n')
      fs.mkdirSync(path.join(dir, 'nested'))
      fs.writeFileSync(path.join(dir, 'nested', 'beta.txt'), 'beta\n')
      const outcome = await callTool(ctx, publicToolName('glob'), { pattern: ['**/*.txt'], path: dir })
      assert.match(outcome.text, /alpha\.txt/)
      assert.match(outcome.text, /beta\.txt/)
      // The canonical value is the mapped MCP result, not a re-rendered summary.
      assert.equal(outcome.value.content[0].type, 'text')
    })
  } finally {
    await shutdown(ctx)
  }
})

await test('a failing tool call surfaces as a rejected call, not as empty output', async () => {
  const { ctx } = await bootHost()
  try {
    await mountPlugin({ ctx, expectTools: EXPECTED.length })
    await assert.rejects(
      () => callTool(ctx, publicToolName('inspect_local_file'), { file_path: path.join(process.cwd(), 'no-such-file.txt') }),
      (error) => {
        // The model must read the server's own diagnosis — the policy asks it to
        // correct its arguments — and never a transport-shaped name.
        assert.match(String(error.message), /no-such-file\.txt/, 'the failure must carry the server diagnosis')
        assert.equal(String(error.message).includes('mcp__'), false, 'no transport vocabulary reaches the model')
        return true
      },
    )
  } finally {
    await shutdown(ctx)
  }
})

await test('both prompt sections render, and the tooling section lists the live tools', async () => {
  const { ctx } = await bootHost()
  try {
    await mountPlugin({ ctx, expectTools: EXPECTED.length })
    const sections = await renderSections(ctx)
    assert.ok(sections.has(HOST_SHELL_SECTION), `expected ${HOST_SHELL_SECTION}; got ${[...sections.keys()].join(', ')}`)
    const tooling = sections.get(TOOLING_SECTION) ?? ''
    assert.notEqual(tooling, '', 'the tooling section must render once the server is mounted')
    for (const tool of EXPECTED) assert.ok(tooling.includes(tool), `tooling section should name ${tool}`)
    assert.equal(tooling.includes('mcp__'), false, 'the model must never be shown the bridge namespace')
    assert.match(sections.get(HOST_SHELL_SECTION) ?? '', /Do not construct a PowerShell command/)
  } finally {
    await shutdown(ctx)
  }
})

await test('the hosted server instructions are attributed as its own section', async () => {
  const { ctx } = await bootHost()
  try {
    await mountPlugin({ ctx, expectTools: EXPECTED.length })
    const sections = await renderSections(ctx)
    const server = [...sections.entries()].find(([name]) => name.startsWith('mcp:fastctx'))
    assert.ok(server !== undefined, `expected an mcp:fastctx section; got ${[...sections.keys()].join(', ')}`)
    assert.match(server[1], /inspect_local_file/)
  } finally {
    await shutdown(ctx)
  }
})

await test('the default policy leaves the host shell tools alone', async () => {
  const { ctx } = await bootHost()
  try {
    await mountPlugin({ ctx, expectTools: EXPECTED.length })
    for (const toolName of DEFAULT_DENIED_HOST_TOOLS) {
      assert.deepEqual(await preExecute(ctx, toolName), { kind: 'allow' })
    }
    // `advise` hides nothing from an agent's view either.
    const dispose = ctx.get('tools').register(foreignTool('pwsh'))
    const agent = await mintAgent(ctx, 'advised-agent')
    await ctx.serial('agent/created', { agent, source: 'startup' })
    assert.ok(
      scopedToolNames(ctx, agent).includes('pwsh'),
      'advise must leave the host shell visible to the agent',
    )
    dispose()
  } finally {
    await shutdown(ctx)
  }
})

await test('deny-host-shell refuses the host shell and still allows FastCtx tools', async () => {
  const { ctx } = await bootHost()
  try {
    await mountPlugin({ ctx, config: { shellPolicy: 'deny-host-shell' }, expectTools: EXPECTED.length })
    for (const toolName of DEFAULT_DENIED_HOST_TOOLS) {
      const decision = await preExecute(ctx, toolName)
      assert.equal(decision.kind, 'deny', `${toolName} should be refused`)
      assert.match(decision.reason, /ops_/)
    }
    for (const toolName of [publicToolName('run'), publicToolName('grep'), 'read', 'edit', 'workflow']) {
      assert.deepEqual(await preExecute(ctx, toolName), { kind: 'allow' }, `${toolName} must not be refused`)
    }
  } finally {
    await shutdown(ctx)
  }
})

await test('deny-host-shell hides the host shell while a rung of its own is live', async () => {
  const { ctx } = await bootHost()
  await mountSubprocessFixture(ctx)
  const { fiber } = await mountPlugin({
    ctx,
    config: {
      shellPolicy: 'deny-host-shell',
      // A configured path + the subprocess fixture make the rung live on any
      // machine: the gate is about the tool being published, not about which
      // bash a developer happens to have on PATH.
      bashPath: process.execPath,
      allowSystemShellFallback: false,
    },
    expectTools: EXPECTED.length,
  })
  const registry = ctx.get('tools')
  // The gate asks the registry, so the rung has to be live for this test to be
  // about hiding at all.
  assert.ok(registryNames(ctx).includes(BASH_TOOL), 'the bash rung must be published')
  const disposers = HOST_SHELL_TOOLS.map((name) => registry.register(foreignTool(name)))
  try {
    const agent = await mintAgent(ctx, 'hidden-agent')
    await ctx.serial('agent/created', { agent, source: 'startup' })

    const visible = scopedToolNames(ctx, agent)
    for (const name of HOST_SHELL_TOOLS) {
      assert.equal(visible.includes(name), false, `${name} must be hidden from that agent's view`)
    }
    for (const name of EXPECTED) {
      assert.ok(visible.includes(name), `the plugin's own ${name} must stay visible`)
    }
    // Visibility, lookup, and execution agree: the name is gone from the view
    // AND refused when it is called anyway.
    for (const name of HOST_SHELL_TOOLS) {
      assert.equal(registry.get(name, agent), undefined, `${name} must not resolve for that agent`)
      assert.equal((await preExecute(ctx, name)).kind, 'deny', `${name} must still be refused`)
    }
    // The mask belongs to that agent alone: the registry still carries the names.
    for (const name of HOST_SHELL_TOOLS) {
      assert.ok(registryNames(ctx).includes(name), `${name} must stay registered globally`)
    }

    // The plugin owns the disposer too, so unloading it lifts the mask even
    // though `agent.ctx` outlives the plugin.
    await fiber.dispose()
    await new Promise((resolve) => setTimeout(resolve, 200))
    const restored = scopedToolNames(ctx, agent)
    for (const name of HOST_SHELL_TOOLS) {
      assert.ok(restored.includes(name), `unloading the plugin must lift the mask on ${name}`)
    }
  } finally {
    for (const dispose of disposers) dispose()
    await shutdown(ctx)
  }
})

await test('a host shell the agent owns itself is not hidden, and the reason is reported once', async () => {
  const { ctx } = await bootHost()
  const reports = captureReports(ctx)
  await mountSubprocessFixture(ctx)
  try {
    await mountPlugin({
      ctx,
      config: {
        shellPolicy: 'deny-host-shell',
        bashPath: process.execPath,
        allowSystemShellFallback: false,
      },
      expectTools: EXPECTED.length,
    })
    // The gate has to be open for this to be about `restrict()` at all.
    assert.ok(registryNames(ctx).includes(BASH_TOOL), 'the bash rung must be published')

    // A registration in the agent's OWN scope is outside what `restrict()` may
    // name, which is the documented way the visibility step fails: the call
    // throws, the plugin keeps the name visible, and the fence is what holds.
    const owning = []
    for (const id of ['owning-agent', 'owning-agent-2']) {
      const agent = await mintAgent(ctx, id)
      agent.ctx.tools.register(foreignTool('pwsh'))
      owning.push(agent)
      await ctx.serial('agent/created', { agent, source: 'startup' })
    }
    for (const agent of owning) {
      assert.ok(scopedToolNames(ctx, agent).includes('pwsh'), 'a name the mask cannot name stays visible')
    }

    const failures = reports.filter((line) => /could not be hidden/.test(line))
    assert.equal(
      failures.length,
      1,
      `the reason must be reported once per mount; got ${failures.length}: ${failures.join(' | ')}`,
    )
    assert.match(failures[0], /restrict/)
    assert.match(failures[0], /fence still refuses/)
    assert.equal((await preExecute(ctx, 'pwsh')).kind, 'deny', 'the fence must still refuse it')
  } finally {
    await shutdown(ctx)
  }
})

await test('deny-host-shell without a bundled shell keeps the fence and hides nothing', async () => {
  const { ctx } = await bootHost()
  const reports = captureReports(ctx)
  try {
    await mountPlugin({
      ctx,
      config: {
        shellPolicy: 'deny-host-shell',
        // No configured path, no bundled copy, no system fallback: this is the
        // deployment where hiding the host shell would leave the model with no
        // shell at all.
        publishBashTool: false,
        allowSystemShellFallback: false,
      },
      expectTools: EXPECTED.length,
    })

    const disposers = HOST_SHELL_TOOLS.map((name) => ctx.get('tools').register(foreignTool(name)))
    // The decision is made as each agent appears, so the report happens then —
    // and only once, however many agents arrive.
    const agents = []
    for (const id of ['ungated-agent', 'ungated-agent-2']) {
      const agent = await mintAgent(ctx, id)
      agents.push(agent)
      await ctx.serial('agent/created', { agent, source: 'startup' })
    }
    for (const agent of agents) {
      const visible = scopedToolNames(ctx, agent)
      for (const name of HOST_SHELL_TOOLS) {
        assert.ok(visible.includes(name), `${name} must stay visible when no rung of ours is live`)
        assert.equal((await preExecute(ctx, name)).kind, 'deny', `${name} must still be refused by the fence`)
      }
    }
    const warnings = reports.filter((line) => /stay visible/.test(line))
    assert.equal(
      warnings.length,
      1,
      `the reason must be reported once per mount; got ${warnings.length}: ${warnings.join(' | ') || '(none)'}`,
    )

    // The ladder matches what resolved: with no bundled rung there is no rung
    // text for one, and the host shell is still named last.
    const tooling = (await renderSections(ctx)).get(TOOLING_SECTION) ?? ''
    assert.equal(tooling.includes('ops_bash'), false)
    assert.match(tooling, /## Rung 2 — the host's own shell tools: last resort/)
    for (const dispose of disposers) dispose()
  } finally {
    await shutdown(ctx)
  }
})

await test('a resolved bash without a subprocess service publishes no rung and installs no mask', async () => {
  const { ctx } = await bootHost()
  const reports = captureReports(ctx)
  try {
    await mountPlugin({
      ctx,
      config: {
        shellPolicy: 'deny-host-shell',
        // A bash resolves on this configuration, but the tool that runs on it
        // needs the host's `subprocess` service, which this host does not mount.
        bashPath: process.execPath,
        allowSystemShellFallback: false,
      },
      expectTools: EXPECTED.length,
    })

    assert.equal(ctx.get('subprocess'), undefined, 'this host must mount no subprocess service')
    assert.equal(
      registryNames(ctx).includes(BASH_TOOL),
      false,
      'nothing may publish the bash rung without a subprocess service',
    )
    const tooling = (await renderSections(ctx)).get(TOOLING_SECTION) ?? ''
    assert.equal(
      tooling.includes(BASH_TOOL),
      false,
      'the text must not name a rung the model cannot reach',
    )
    assert.match(tooling, /## Rung 2 — the host's own shell tools: last resort/)
    // The FastCtx rung is unaffected: its tools are published either way.
    for (const name of EXPECTED) {
      assert.ok(tooling.includes(name), `the text must still name ${name}`)
    }

    // A resolved executable is not a rung, so there is nothing to hide *for*:
    // the mask must not be installed, or the model would be left with no shell
    // of its own and no host shell either.
    const disposers = HOST_SHELL_TOOLS.map((name) => ctx.get('tools').register(foreignTool(name)))
    const agents = []
    for (const id of ['resolved-unpublished-1', 'resolved-unpublished-2']) {
      const agent = await mintAgent(ctx, id)
      agents.push(agent)
      await ctx.serial('agent/created', { agent, source: 'startup' })
    }
    for (const agent of agents) {
      const visible = scopedToolNames(ctx, agent)
      for (const name of HOST_SHELL_TOOLS) {
        assert.ok(visible.includes(name), `${name} must stay visible while no rung of ours is live`)
        assert.equal((await preExecute(ctx, name)).kind, 'deny', `${name} is still refused by the fence`)
      }
    }
    const warnings = reports.filter((line) => /stay visible/.test(line))
    assert.equal(
      warnings.length,
      1,
      `the reason must be reported once per mount; got ${warnings.length}: ${warnings.join(' | ') || '(none)'}`,
    )
    for (const dispose of disposers) dispose()
  } finally {
    await shutdown(ctx)
  }
})

await test('a subprocess service makes the rung publish, render, and go away with the plugin', async () => {
  const { ctx } = await bootHost()
  try {
    await mountSubprocessFixture(ctx)
    const { fiber } = await mountPlugin({
      ctx,
      config: { bashPath: process.execPath, allowSystemShellFallback: false },
      expectTools: EXPECTED.length,
    })

    // With the service the host supplies, `lib/shells.js` publishes the rung's
    // tool — and the ladder is rendered from that registry fact, so the text and
    // the registry agree in both directions.
    assert.ok(
      registryNames(ctx).includes(BASH_TOOL),
      `a subprocess service must let the rung publish; got ${registryNames(ctx).join(', ')}`,
    )
    const tooling = (await renderSections(ctx)).get(TOOLING_SECTION) ?? ''
    assert.match(tooling, /## Rung 2 — `ops_bash`: the bundled bash, for POSIX pipelines and scripts/)
    assert.match(tooling, /## Rung 3 — the host's own shell tools: last resort/)

    await fiber.dispose()
    await new Promise((resolve) => setTimeout(resolve, 200))

    assert.equal(
      registryNames(ctx).includes(BASH_TOOL),
      false,
      'unloading the plugin must remove the tool the rung is reached through',
    )
    const sections = await renderSections(ctx)
    assert.equal(sections.has(TOOLING_SECTION), false, 'the rung text goes away with the tool that carried it')
  } finally {
    await shutdown(ctx)
  }
})

await test('disposal unregisters the tools and the prompt sections', async () => {
  const { ctx } = await bootHost()
  const { fiber } = await mountPlugin({ ctx, expectTools: EXPECTED.length })
  assert.equal(publicToolNames(ctx).length, EXPECTED.length)
  const before = await renderSections(ctx)
  assert.ok(before.has(TOOLING_SECTION))

  await fiber.dispose()
  await new Promise((resolve) => setTimeout(resolve, 500))

  assert.deepEqual(publicToolNames(ctx), [], 'disposing the plugin must remove every FastCtx tool')
  assert.deepEqual(registryNames(ctx), [], 'disposing the plugin must leave no tool behind')
  const after = await renderSections(ctx)
  assert.equal(after.has(TOOLING_SECTION), false)
  assert.equal(after.has(HOST_SHELL_SECTION), false)
  await shutdown(ctx)
})

await test('a missing runtime degrades to the prompt policy instead of failing the profile', async () => {
  const { ctx } = await bootHost()
  try {
    await mountPlugin({
      ctx,
      config: { binaryPath: path.join(process.cwd(), 'no-such-fastctx.exe') },
      expectTools: 0,
      timeoutMs: 2_000,
    })
    assert.deepEqual(publicToolNames(ctx), [])
    const sections = await renderSections(ctx)
    assert.ok(sections.has(HOST_SHELL_SECTION), 'the host-shell rule must survive a missing runtime')
    assert.equal(sections.get(TOOLING_SECTION), '', 'the tooling section must stay empty without tools')
  } finally {
    await shutdown(ctx)
  }
})

await test('an unusable runtime fails activation when the deployment requires it', async () => {
  const { ctx } = await bootHost()
  try {
    let failure
    try {
      await mountPlugin({
        ctx,
        config: { binaryPath: path.join(process.cwd(), 'no-such-fastctx.exe'), required: true },
        expectTools: 0,
        timeoutMs: 2_000,
      })
    } catch (error) {
      failure = error
    }
    assert.ok(failure !== undefined, 'required: true must reject activation')
    assert.match(String(failure.message), /binaryPath/)
  } finally {
    await shutdown(ctx)
  }
})

await test('promptPolicy: false publishes the tools without any prompt section', async () => {
  const { ctx } = await bootHost()
  try {
    const { tools } = await mountPlugin({ ctx, config: { promptPolicy: false }, expectTools: EXPECTED.length })
    assert.equal(tools.length, EXPECTED.length)
    const sections = await renderSections(ctx)
    assert.equal(sections.has(HOST_SHELL_SECTION), false)
    assert.equal(sections.has(TOOLING_SECTION), false)
  } finally {
    await shutdown(ctx)
  }
})

await test('a dead server fails the next call loudly and is republished after a reconnect', async () => {
  const fixture = surfaceFixture()
  const surface = new FastCtxTools({
    ctx: fixture.ctx,
    config: resolveConfig({ enableShellTools: false }),
    runtime: resolveRuntime(),
    report: (message) => fixture.reports.push(message),
  })
  try {
    const published = await surface.start()
    assert.equal(published.length, FILE_TOOLS.length, `expected the four file tools; got ${published.join(', ')}`)
    const live = surface.client
    assert.ok(live !== undefined, 'a started surface holds a live connection')

    // Kill the server out from under the surface. The connection ending is an
    // event, not a failed request, so the surface notices it without a call.
    live.child.kill()
    await waitFor(() => surface.client === undefined, {
      timeoutMs: 15_000,
      what: 'the surface to notice the dead server',
    })
    assert.ok(
      fixture.reports.some((line) => /exited|could not be started/.test(line)),
      `the outage must be reported; got ${fixture.reports.join(' | ')}`,
    )

    // A call against a dead server must fail immediately and say why, instead of
    // waiting out the whole call deadline.
    const failure = await fixture
      .call(publicToolName('glob'), { pattern: ['*.txt'], path: process.cwd() })
      .then(() => undefined, (error) => error)
    assert.ok(failure !== undefined, 'a call against a dead server must reject')
    assert.match(String(failure.message), /ops_glob is unavailable/)

    // The backoff loop must republish a working generation, not just reconnect.
    await withTempDir('reconnect', async (dir) => {
      fs.writeFileSync(path.join(dir, 'gamma.txt'), 'gamma\n')
      const deadline = Date.now() + 30_000
      for (;;) {
        try {
          const value = await fixture.call(publicToolName('glob'), { pattern: ['**/*.txt'], path: dir })
          assert.equal(value.content[0].type, 'text')
          assert.match(value.content[0].text, /gamma\.txt/)
          break
        } catch (error) {
          if (Date.now() > deadline) throw error
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
      }
    })
    assert.ok(
      fixture.reports.some((line) => line.includes('reconnected')),
      `the recovery must be reported; got ${fixture.reports.join(' | ')}`,
    )
    assert.deepEqual(surface.names(), FILE_TOOLS.map(publicToolName).sort())
  } finally {
    await surface.stop()
  }
  assert.deepEqual(fixture.names(), [], 'stopping the surface must unregister every tool it published')
})

await test('the FastCtx child never inherits credential-shaped names', () => {
  const env = childEnv({
    PATH: 'C:\\bin',
    HOME: 'C:\\home',
    GH_CONFIG_DIR: 'C:\\gh',
    GH_TOKEN: 'secret',
    DEEPSEEK_API_KEY: 'secret',
    DSH_HOME: 'C:\\dsh',
    dsh_ops_fixture: '1',
  })
  assert.equal(env.PATH, 'C:\\bin')
  assert.equal(env.HOME, 'C:\\home')
  assert.equal(env.GH_CONFIG_DIR, 'C:\\gh', 'tool configuration locations survive')
  for (const dropped of ['GH_TOKEN', 'DEEPSEEK_API_KEY', 'DSH_HOME', 'dsh_ops_fixture']) {
    assert.equal(Object.hasOwn(env, dropped), false, `${dropped} must not reach the child`)
  }
})

report('mount')
