/** Explicit resident ownership for standalone host fixtures; never installed by bootHost. */
import path from 'node:path'
import { startResident, ResidentNotStarted } from '../../lib/execution/resident/client.js'
import { WORKER } from './boundary.mjs'
import { exchange } from '../../lib/execution/transport.js'

const starting = new WeakMap()
const identity = file => {
  const absolute = path.resolve(file)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}
function compatible(client, file) {
  if (file !== undefined && identity(client.file) !== identity(file)) {
    throw new Error('Resident fixture worker conflicts with the existing opsKernel service')
  }
  return client
}
async function mount(ctx, options, create, inject = []) {
  const existing = ctx.get('opsKernel')
  if (existing) return compatible(existing, options.file)
  if (starting.has(ctx)) return compatible(await starting.get(ctx), options.file)
  const pending = (async () => {
    let client
    await ctx.plugin({ name: 'fixture-resident-kernel', inject, async apply(inner) {
      client = await create(inner, path.resolve(options.file ?? WORKER))
      inner.fiber.assertActive()
      inner.provide('opsKernel', client)
    } })
    if (!client) throw new Error('Resident fixture did not start; mount its required host services first')
    return client
  })()
  starting.set(ctx, pending)
  try { return await pending } finally { starting.delete(ctx) }
}

/** Mount once after Subprocess; startResident owns handshake and awaited cleanup. */
export function mountResident(ctx, options = {}) {
  return mount(ctx, options, (inner, file) => startResident(inner, file, options.cwd ?? process.cwd()), ['subprocess'])
}

/** Publication-only fixtures reject execution unless a test supplies its exact exchange. */
export function mountFakeResident(ctx, options = {}) {
  return mount(ctx, options, async (inner, file) => {
    const client = {
      file, pid: options.pid ?? 1, available: options.available ?? true,
      async invoke(envelope, signal, onStarted) {
        if (!client.available) throw new ResidentNotStarted('Resident fixture is unavailable')
        if (!options.invoke) throw new Error('Publication-only resident fixture must not execute')
        return options.invoke(envelope, signal, onStarted)
      },
      async stop() { client.available = false },
    }
    inner.effect(() => () => client.stop(), 'fixture: resident kernel')
    return client
  })
}

/** Convert existing raw-output subprocess mocks into explicit kernel receipts. */
export function mountExchangeResident(ctx, { file = 'unused', cwd = process.cwd() } = {}) {
  return mountFakeResident(ctx, { file, invoke: (envelope, signal, started) => exchange(ctx.get('subprocess'), {
    argv: [file], cwd, signal, graceMs: 1000,
    stdio: { stdin: { data: JSON.stringify(envelope) }, stdout: { maxBytes: envelope.budget.maxBytes }, stderr: { maxBytes: 16384 } },
  }, started) })
}
