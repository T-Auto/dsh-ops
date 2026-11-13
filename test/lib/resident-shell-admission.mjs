/** Real host ownership and policy over a scripted kernel-owned shell queue. */
import { inspect } from 'node:util'
import Agents from '@deepseek-ai/dsh-agent'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Llm from '@deepseek-ai/dsh-llm'
import Loop from '@deepseek-ai/dsh-agent-loop'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import { createShellAdmissionHost } from '../../lib/execution/resident/shell-admission.js'
import { residentShellAdmission } from '../../lib/execution/resident/shell-owner.js'
import { assert, withTempDir } from './harness.mjs'
import { bootHost } from './host.mjs'

let identity = 0
export const turn = () => new Promise(resolve => setImmediate(resolve))
export async function bounded(promise, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle`)), 15_000)
    })])
  } finally { clearTimeout(timer) }
}

export async function fixture(run, { mode = 'danger-full-access', providerOwned = false, admissionOptions = {} } = {}) {
  await withTempDir('resident-shell-admission', async directory => {
    const { ctx } = await bootHost({ withWorkingDirectory: false })
    const frames = [], listeners = new Set(), watchers = new Set(), handles = []
    const approvals = [], confinements = [], preparations = [], bootstraps = [], calls = [], logs = [], aborts = [], reads = [], environmentCalls = []
    const closed = new Set(), pending = new Map(), retained = new Map()
    const state = { ensureCalls: 0, directoryError: undefined, approval: async () => 'allowed-once',
      environment: {}, runtimeEnvironment: {}, cleanup: false, expectedCleanupFailure: false, sendFailure: undefined, onAbort: undefined,
      outputRead: undefined, autoRetire: true, confinement: {} }
    ctx.logger.exporter({ levels: { default: 3 }, export: message => logs.push(inspect(message.args, { depth: null })) })
    let host, owner, unavailable = false
    const emit = frame => {
      if (frame.type === 'shell.unavailable') unavailable = true
      for (const listener of [...listeners]) listener(frame)
    }
    const complete = (request, overrides = {}) => {
      pending.delete(request.requestId)
      const receipt = { type: 'shell.completed', requestId: request.requestId, status: 'completed', exitCode: 0,
        effectState: 'unknown', shellState: 'preserved', cleanupConfirmed: true,
        stdoutTotal: 0, stderrTotal: 0, ...overrides }
      retained.set(request.requestId, receipt)
      emit(receipt)
    }
    const acknowledge = frame => {
      if (closed.has(frame.requestId)) return
      closed.add(frame.requestId)
      emit({ type: 'shell.closed', requestId: frame.requestId, cleanupConfirmed: true })
      if (frame.type === 'shell.close') for (const request of [...pending.values()]) {
        if (request.sessionKey === frame.sessionKey) complete(request, {
          status: 'cancelled', exitCode: null, effectState: 'none', shellState: 'reset',
        })
      }
    }
    const transport = {
      available: true, capabilities: ['shell-v1'],
      send(frame) {
        if (!transport.available) throw new Error('Fixture transport is unavailable')
        if (state.sendFailure?.(frame)) throw new Error('Fixture control write rejected')
        frames.push(structuredClone(frame))
        if (frame.type === 'shell.execute') pending.set(frame.requestId, frame)
        if (frame.type === 'shell.release') assert.equal(retained.delete(frame.requestId), true, 'Only retained terminal output can be released')
        for (const watcher of [...watchers]) watcher()
        // A retirement closes old shell state but leaves this kernel's queue intact.
        if (state.autoRetire && frame.type === 'shell.retire' || state.cleanup && frame.type === 'shell.close') {
          queueMicrotask(() => acknowledge(frame))
        }
      },
      async read(requestId, stream, offset, maxBytes) {
        reads.push({ requestId, stream, offset, maxBytes })
        assert.equal(transport.available, true)
        const receipt = retained.get(requestId)
        assert.ok(receipt, 'Output reads follow a terminal receipt in this fixture')
        if (state.outputRead) return state.outputRead({ requestId, stream, offset, maxBytes }, receipt)
        assert.equal(receipt[stream === 'stdout' ? 'stdoutTotal' : 'stderrTotal'], 0)
        return { type: 'shell.output', requestId, stream, offset, nextOffset: offset, bytesBase64: '', lossy: false, eof: true }
      },
      abort(error) { aborts.push(error); transport.available = false; state.onAbort?.(error) },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    }
    const message = async (type, after = 0, predicate = () => true) => {
      const find = () => frames.slice(after).find(frame => frame.type === type && predicate(frame))
      if (find()) return find()
      let check
      try {
        return await bounded(new Promise(resolve => {
          check = () => { const frame = find(); if (frame) resolve(frame) }
          watchers.add(check)
          check()
        }), `kernel message ${type}`)
      } finally { watchers.delete(check) }
    }
    try {
      for (const plugin of [Agents, Sessions, Projections, Llm]) await ctx.plugin(plugin, {})
      await ctx.plugin(Policy, { mode, workspaceRoot: directory })
      await ctx.plugin(inner => {
        inner.provide('workingDirectory', {
          get: session => session.header.cwd,
          async ensure(agent) {
            state.ensureCalls++
            if (state.directoryError) throw state.directoryError
            return agent.session.header.cwd
          },
        })
        inner.provide('approval', { async request(request) {
          approvals.push(request)
          return state.approval(request)
        } })
        inner.provide('shellEnv', { collect: exec => { environmentCalls.push(exec); return { ...state.environment } } })
        inner.on('llm/stream', () => { throw new Error('This admission fixture must never request a model') })
      })
      const sandboxProvider = await ctx.plugin(inner => {
        inner.provide('sandbox', { async confine(argv, policy, signal) {
          signal?.throwIfAborted()
          const wrapped = [process.execPath, 'fixture-public-sandbox', ...argv]
          confinements.push({ argv: [...argv], wrapped, policy: structuredClone(policy) })
          return { argv: wrapped, enforcement: 'full', ...state.confinement }
        } })
      })
      await ctx.plugin(Loop, { agents: [] })
      const options = {
        transport, bash: { file: process.execPath, source: 'fixture' },
        async runtime(...args) { preparations.push(args); return { file: process.execPath, env: { ...state.runtimeEnvironment } } },
        bootstrap(endpoints) {
          bootstraps.push(structuredClone(endpoints))
          return ['--noprofile', '--norc', '-c', 'fixture-driver', endpoints.commandPipe, endpoints.receiptPipe]
        },
      }
      Object.assign(options, admissionOptions)
      if (providerOwned) {
        owner = await ctx.plugin(residentShellAdmission(options))
        host = ctx.get('opsShellAdmission')
        assert.ok(host, 'The public owner helper publishes its ready admission service')
      } else owner = await ctx.plugin({ name: 'fixture-shell-admission-owner', apply(inner) {
        host = createShellAdmissionHost(inner, options)
      } })
      const agent = async (cwd = directory) => {
        const handle = await ctx.get('agents').create({ sessionId: `shell-admission-${++identity}`,
          meta: { cwd }, agentOptions: { provider: 'fixture', model: 'unused' } })
        handles.push(handle)
        return handle
      }
      const submit = async (handle, args = {}, signal = new AbortController().signal, active) => {
        const start = frames.length
        const result = host.execute({ command: 'printf fixture', ...args }, {
          agent: handle.agent, callId: `shell-call-${++identity}`, signal,
        }, active)
        calls.push(result)
        void result.catch(() => {})
        const request = await message('shell.execute', start)
        return { request, result }
      }
      const admit = async (call, hasShell = false) => {
        const start = frames.length
        emit({ type: 'shell.admit', requestId: call.request.requestId, hasShell,
          ...hasShell ? {} : { bootstrap: {
            commandPipe: `\\\\.\\pipe\\fixture-command-${++identity}`,
            receiptPipe: `\\\\.\\pipe\\fixture-receipt-${identity}`,
          } } })
        return message('shell.admission', start, frame => frame.requestId === call.request.requestId)
      }
      const finish = async (call, overrides = {}) => {
        emit({ type: 'shell.started', requestId: call.request.requestId })
        complete(call.request, overrides)
        return bounded(call.result, 'shell result')
      }
      await run({ ctx, host, owner, directory, agent, submit, admit, finish, complete, emit, acknowledge,
        message, frames, approvals, confinements, preparations, bootstraps, state, transport, logs, aborts, reads, sandboxProvider, environmentCalls })
    } finally {
      state.cleanup = true
      if (!transport.available && !unavailable) emit({ type: 'shell.unavailable', cleanupConfirmed: true,
        error: { code: 'EXECUTOR_UNAVAILABLE', message: 'Fixture teardown joined the scripted range.' } })
      for (const frame of frames) if (frame.type === 'shell.close' || frame.type === 'shell.retire') acknowledge(frame)
      const failures = []
      const cleanup = async (work, label) => {
        try { await bounded(work, label) } catch (error) { failures.push(error) }
      }
      await cleanup(host?.dispose() ?? Promise.resolve(), 'host cleanup')
      for (const handle of handles) await cleanup(handle.dispose(), 'Agent cleanup')
      await cleanup(ctx.fiber.dispose(), 'Cordis cleanup')
      await bounded(Promise.allSettled(calls), 'pending request cleanup')
      // The unconfirmed-loss case asserts the cleanup rejection before reaching this teardown.
      if (!state.expectedCleanupFailure && failures.length) throw new AggregateError(failures, 'Fixture cleanup failed')
    }
  })
}
