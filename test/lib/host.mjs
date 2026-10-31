/**
 * A real host for the plugin.
 *
 * Every layer here is the production one: real Cordis `Context` and fiber
 * lifecycle, the harness's own `@deepseek-ai/dsh-tools` registry and
 * `@deepseek-ai/dsh-system-prompt` assembly, and real registration scopes.
 * Nothing is stubbed, so a passing suite is evidence about the shipped
 * composition rather than about a test double.
 *
 * @module dsh-ops/test/host
 */

import { Context } from '@deepseek-ai/cordis'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { TOOL_PREFIX } from '../../lib/policy.js'
import { PACKAGE_ROOT } from './harness.mjs'
import { legacyComponent } from './legacy-component.mjs'

/**
 * The directory service rc.5's `run_code` asks for, over a session's committed cwd.
 * @param {string} fallback - the directory a session without a committed cwd reports.
 * @returns {object} the provided service shape.
 */
export const workingDirectoryOver = fallback => ({
  get: (session) => session?.header?.cwd ?? fallback,
  ensure: async (agent) => agent?.session?.header?.cwd ?? fallback,
  set: async (_agent, target) => target ?? fallback,
})

/**
 * Boot a context with the real prompt and tool services installed.
 * @param {object} [options] - boot inputs.
 * @param {boolean} [options.withTools] - install the tool registry (default true).
 * @param {boolean} [options.withSystemPrompt] - install the prompt registry (default true).
 * @param {boolean} [options.keepLogger] - keep Cordis's console logging (default false).
 * @param {'native'|'ptc'} [options.toolsMode] - deployment presentation mode (default native).
 * @param {boolean} [options.withWorkingDirectory] - provide the directory service rc.5's `run_code` asks for (default false).
 * @returns {Promise<{ctx: Context, tools: any, prompt: any}>} the host.
 */
export async function bootHost({ withTools = true, withSystemPrompt = true, keepLogger = false, toolsMode = 'native', withWorkingDirectory = false } = {}) {
  const ctx = new Context()
  if (!keepLogger) {
    // Cordis logs service and plugin activity at info level; a gate that prints
    // it buries the assertions. Failures are asserted, not scrolled past.
    ctx.logger.level = 0
  }
  if (withSystemPrompt) {
    const SystemPrompt = (await import('@deepseek-ai/dsh-system-prompt')).default
    await ctx.plugin(SystemPrompt, {})
  }
  if (withTools) {
    const ToolRuntime = (await import('@deepseek-ai/dsh-tools')).default
    await ctx.plugin(ToolRuntime, { mode: toolsMode })
  }
  // rc.5 routes `run_code` through the host's working-directory service: a call
  // carrying an Agent asks it which directory the code runs in and throws when
  // the service is absent. Only the suites that really run code opt in, so the
  // rest keep exercising a host shaped like the ones that never install it.
  if (withWorkingDirectory) ctx.provide('workingDirectory', workingDirectoryOver(process.cwd()))
  return { ctx, tools: ctx.get('tools'), prompt: ctx.get('systemPrompt') }
}

/**
 * Load a fresh instance of the legacy global file component.
 *
 * The package root now publishes a per-preset mode instead of a global surface
 * (it is the optional client-carrier row), so these helpers mount the retained
 * legacy file module: its kernel semantics — global publication, read dedup,
 * worker lifecycle — are what the shared fixtures below still verify.
 * The test-only wrapper opts in only during the synchronous apply guard.
 * A fresh module graph per mount keeps module-level state from leaking between
 * scenarios, at the cost of one import per call.
 * @param {string} [tag] - a cache-busting tag.
 * @returns {Promise<{apply: Function, name: string}>} the plugin module.
 */
export async function loadPlugin(tag = `${Date.now()}-${Math.random()}`) {
  const file = pathToFileURL(path.join(PACKAGE_ROOT, 'lib', 'components', 'file', 'index.js')).href
  return legacyComponent(await import(`${file}?tag=${tag}`))
}

/**
 * Mount the legacy file component and wait until its tools appear (or the
 * deadline passes).
 * @param {object} options - mount inputs.
 * @param {Context} options.ctx - the host context.
 * @param {Record<string, unknown>} [options.config] - the plugin row config.
 * @param {number} [options.timeoutMs] - how long to wait for tools.
 * @param {number} [options.expectTools] - how many `ops_` tools to wait for.
 * @returns {Promise<{fiber: any, tools: string[]}>} the plugin fiber and the published tool names.
 */
export async function mountPlugin({ ctx, config = {}, timeoutMs = 10_000, expectTools = 1 }) {
  const plugin = await loadPlugin()
  const fiber = await ctx.plugin(plugin, config)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const names = publicToolNames(ctx)
    if (names.length >= expectTools) return { fiber, tools: names }
    if (Date.now() > deadline) throw new Error(`mount timed out after ${timeoutMs}ms: expected ${expectTools} tools, got ${names.join(', ')}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * The tool names this plugin publishes, as the registry currently exposes them.
 * @param {Context} ctx - the host context.
 * @returns {string[]} the names, sorted.
 */
export function publicToolNames(ctx) {
  const schemas = ctx.get('tools')?.schemas?.() ?? []
  return schemas
    .map((schema) => schema.name)
    .filter((name) => typeof name === 'string' && name.startsWith(TOOL_PREFIX))
    .sort()
}

/**
 * Every registered tool name, sorted — the honest registry view, whatever
 * namespace a definition sits in.
 * @param {Context} ctx - the host context.
 * @returns {string[]} the names, sorted.
 */
export function registryNames(ctx) {
  const schemas = ctx.get('tools')?.schemas?.() ?? []
  return schemas.map((schema) => schema.name).sort()
}

/**
 * Whether the shared tool registry carries its own `register` property.
 *
 * `ToolRuntime.register` is a prototype method: an own property on the registry
 * instance can only be an installed override. This is the cheapest way to state
 * "this plugin did not touch the shared registry" as an assertion.
 * @param {Context} ctx - the host context.
 * @returns {boolean} whether an own override is present.
 */
export function registryHasOwnRegister(ctx) {
  return Object.hasOwn(ctx.get('tools'), 'register')
}

/**
 * The tool names visible from one registration scope.
 * @param {Context} ctx - the host context.
 * @param {unknown} scopeKey - the scope identity returned by {@link mountScopedToolPlugin}.
 * @returns {string[]} the names visible in that scope, sorted.
 */
export function scopedToolNames(ctx, scopeKey) {
  const schemas = ctx.get('tools')?.schemas?.(scopeKey) ?? []
  return schemas.map((schema) => schema.name).sort()
}

/**
 * Mount a plugin that registers one tool through a registration scope of its
 * own — the way an agent-plane plugin does.
 *
 * This is the shape the shipped incident broke: a scope's registration must
 * stay in that scope, and the same name must be registrable in a second scope.
 * Nothing here belongs to dsh-ops, which is exactly the point.
 * @param {Context} ctx - the host context (or a context mounted under it).
 * @param {object} options - the fixture inputs.
 * @param {string} options.scope - a display name for the fixture plugin.
 * @param {string} options.toolName - the tool name to register.
 * @param {string} [options.description] - the tool description.
 * @returns {Promise<{fiber: any, scopeKey: unknown, dispose: () => Promise<void>}>} the mounted fixture.
 */
export async function mountScopedToolPlugin(ctx, { scope, toolName, description }) {
  const { createScope, scopeOf } = await import('@deepseek-ai/dsh-scope')
  const created = createScope(ctx, { scope })
  const plugin = {
    name: `fixture-${scope}`,
    inject: ['tools'],
    apply(inner) {
      inner.tools.register({
        name: toolName,
        description: description ?? `a ${scope} registration for ${toolName}`,
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'object' }, render: () => [] },
        execute: async () => ({}),
      })
    },
  }
  const fiber = await created.ctx.plugin(plugin)
  return { fiber, scopeKey: scopeOf(created.ctx), dispose: created.dispose }
}

/**
 * The assembled system prompt, as a name → text map.
 * @param {Context} ctx - the host context.
 * @returns {Promise<Map<string, string>>} the sections.
 */
export async function renderSections(ctx, agent) {
  const assembly = await ctx.get('systemPrompt').assemble({ agent })
  const sections = Array.isArray(assembly.sections) ? assembly.sections : []
  return new Map(sections.map((section) => [section.name, String(section.text ?? '')]))
}

/**
 * Call one registered tool the way the loop does: run the definition's body,
 * then render its canonical value into model-facing content.
 * @param {Context} ctx - the host context.
 * @param {string} name - the tool name.
 * @param {Record<string, unknown>} args - the arguments.
 * @param {AbortSignal} [signal] - the caller's signal.
 * @returns {Promise<{value: unknown, text: string, content: {type: string, text?: string}[]}>} the outcome.
 */
export async function callTool(ctx, name, args, signal = new AbortController().signal, agent) {
  const definition = ctx.get('tools').get(name, agent)
  if (definition === undefined) throw new Error(`tool "${name}" is not registered`)
  const value = await definition.execute(args, { callId: 'test', name, arguments: args, signal, agent: agent ?? { session: { id: 'file-call', header: { cwd: process.cwd() } } } })
  const content = definition.output.render(args, value)
  return {
    value,
    content,
    text: content.filter((block) => block.type === 'text').map((block) => block.text).join('\n'),
  }
}

/**
 * Dispatch one `tools/pre-execute` waterfall exactly as the registry does and
 * report the decision.
 * @param {Context} ctx - the host context.
 * @param {string} toolName - the tool the model called.
 * @returns {Promise<unknown>} the decision, or the value the terminal `next()` produced.
 */
export async function preExecute(ctx, toolName) {
  const exec = { callId: 'test', name: toolName, arguments: {}, signal: new AbortController().signal }
  return ctx.waterfall('tools/pre-execute', exec, () => Promise.resolve({ kind: 'allow' }))
}

/**
 * Dispose the host and everything mounted under it.
 * @param {Context} ctx - the host context.
 * @returns {Promise<void>} resolves once disposal settles.
 */
export async function shutdown(ctx) {
  await ctx.fiber.dispose()
}
