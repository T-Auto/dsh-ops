/** Actual Agent ownership and public Jobs lifecycle; producers remain controlled by the caller. */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Agents from '@deepseek-ai/dsh-agent'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Llm from '@deepseek-ai/dsh-llm'
import Loop from '@deepseek-ai/dsh-agent-loop'
import LocalJobs from '@deepseek-ai/dsh-jobs-local'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import './harness.mjs'
import { executeCall } from './executor.mjs'

let identity = 0

/**
 * Optional official tool controller comes from an explicit module, never a machine-specific default.
 * Without it, an owned public attachController() registration admits real Jobs without fake tools.
 * A requested controller that cannot load is an error, not a skipped test.
 */
export async function createResidentTaskJobs({
  cwd = process.cwd(), jobsConfig = {}, controllerModule = process.env.DSH_OPS_TEST_JOB_CONTROLLER,
  onRegistered: registered, initialAgents = 1,
} = {}) {
  if (!Number.isSafeInteger(initialAgents) || initialAgents < 0) throw new Error('initialAgents must be a non-negative integer')
  const ctx = new Context()
  ctx.logger.level = 0
  const agents = [], handles = [], events = [], observerErrors = [], registrationListeners = new Set()
  if (registered) registrationListeners.add(registered)
  let jobs, controller, observer, disposal, stopped = false

  function assertObservers() {
    if (observerErrors.length) throw new AggregateError([...observerErrors], 'Jobs fixture observer failed')
  }
  async function createAgent(options = {}) {
    if (stopped) throw new Error('Jobs fixture is disposed')
    const handle = await ctx.get('agents').create({
      sessionId: `resident-task-jobs-${++identity}`, meta: { cwd },
      agentOptions: { provider: 'fixture', model: 'unused' }, ...options,
    })
    handles.push(handle)
    agents.push(handle.agent)
    return handle
  }
  function dispose() {
    if (!disposal) {
      stopped = true
      disposal = (async () => {
        // Each actual Agent disposal joins its Jobs cleanup; one rejection must not strand a sibling.
        const results = await Promise.allSettled(handles.map(handle => handle.dispose()))
        results.push(...await Promise.allSettled([ctx.fiber.dispose()]))
        const errors = [...observerErrors, ...results.filter(result => result.status === 'rejected').map(result => result.reason)]
        if (errors.length) throw new AggregateError(errors, 'Jobs fixture cleanup failed')
      })()
    }
    return disposal
  }

  try {
    for (const plugin of [Prompt, Tools, NativeExecutor, Agents, Sessions, Projections, Llm]) await ctx.plugin(plugin, {})
    await ctx.plugin(inner => {
      inner.provide('workingDirectory', {
        get: session => session?.header?.cwd ?? cwd,
        ensure: async agent => agent?.session?.header?.cwd ?? cwd,
        set: async (_agent, target) => target ?? cwd,
      })
      inner.on('llm/stream', () => { throw new Error('The Jobs fixture must not request a model') })
    })
    await ctx.plugin(Loop, { agents: [] })
    const jobsFiber = await ctx.plugin(LocalJobs, { pumpPollMs: 5, ...jobsConfig })
    jobs = ctx.get('jobs')
    if (controllerModule !== undefined) {
      const module = typeof controllerModule === 'string' || controllerModule instanceof URL
        ? await import(typeof controllerModule === 'string' && path.isAbsolute(controllerModule)
          ? pathToFileURL(controllerModule).href : String(controllerModule))
        : controllerModule
      const plugin = typeof module?.apply === 'function' ? module : module?.default
      if (!plugin) throw new Error('controllerModule must export the official Jobs tool plugin')
      controller = await ctx.plugin(plugin, { completionDelivery: 'quiet', inlineOutputBytes: 0 })
      for (const name of ['job_list', 'job_output', 'job_kill']) {
        if (!ctx.get('tools').get(name)) throw new Error(`Requested Jobs controller did not publish ${name}`)
      }
    } else {
      controller = await ctx.plugin({ name: 'resident-task-jobs-controller', inject: ['jobs'], apply(inner) {
        inner.jobs.attachController('resident-task-jobs-fixture')
      } })
    }
    observer = await ctx.plugin({ name: 'resident-task-jobs-observer', inject: ['jobs'], apply(inner) {
      inner.jobs.events.subscribe({ owners: 'all' }, event => {
        events.push(event)
        if (event.type !== 'registered') return
        // Deliberately synchronous: this runs before jobs.start() returns its id.
        for (const listener of [...registrationListeners]) {
          try { listener(event, jobs) } catch (error) { observerErrors.push(error) }
        }
      })
    } })
    for (let i = 0; i < initialAgents; i++) await createAgent()
    return {
      ctx, jobs, jobsFiber, controller, observer, agents, handles, events, observerErrors,
      agent: agents[0], createAgent, dispose, assertObservers,
      controllerKind: controllerModule === undefined ? 'public-api' : 'official-tools',
      onRegistered(listener) { registrationListeners.add(listener); return () => registrationListeners.delete(listener) },
      tool(name, agent = agents[0]) { return ctx.get('tools').get(name, agent) },
      execute(name, args = {}, { agent = agents[0], ...call } = {}) {
        return executeCall(ctx, { agent, name, arguments: args, callId: `task-job-tool-${++identity}`, ...call })
      },
    }
  } catch (error) {
    try { await dispose() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Jobs fixture setup and cleanup failed') }
    throw error
  }
}
