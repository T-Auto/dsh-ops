/** Public host API fixture. No private provider hooks or raw process launch. */
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { fileURLToPath } from 'node:url'
import { channel, within } from './channel.mjs'

const fixture = fileURLToPath(new URL('./process.mjs', import.meta.url))

export async function boot(workspace) {
  const root = new Context()
  root.logger.level = 0
  await root.plugin(LocalSubprocessRuntime)
  let handle, wire, closed = false, spawns = 0, requestId = 0
  // Each mounting owns its state through a plugin effect; no module singleton,
  // home/workspace lock, environment-derived instance identity or WeakMap.
  const fiber = await root.plugin({
    name: 'ops-resident-feasibility', inject: ['subprocess'],
    apply(ctx) {
      if (ctx.root !== root) throw new Error('child has a different root identity')
      handle = ctx.get('subprocess').spawn({
        argv: [process.execPath, fixture, 'kernel', workspace], cwd: workspace,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 }, control: 'pipe' },
        graceMs: 100,
      })
      spawns++
      if (!handle.control) throw new Error('public spawn returned no control pipe')
      wire = channel(handle.control, () => handle.terminate())
      // Direct exit is not proof the owned descendants exited. The consumer
      // explicitly asks the same public handle to terminate its range.
      handle.done.then(() => handle.terminate(), () => handle.terminate())
      ctx.effect(() => async () => {
        closed = true
        handle.terminate()
        if (!await handle.waitForExit(AbortSignal.timeout(10_000))) throw new Error('owned range did not exit')
        await handle.done.catch(() => {})
        handle.control.destroy()
      }, 'probe resident kernel')
    },
  })
  try {
    const hello = await within(wire.next(), 15_000, 'kernel handshake')
    if (hello.type !== 'hello') throw new Error('unexpected handshake')
    return {
      root, handle, hello, get spawns() { return spawns },
      async request(op, args = {}) {
        if (closed) throw new Error('consumer is unloaded')
        const id = ++requestId
        await wire.send({ requestId: id, op, context: { instance: hello.instance, workspace }, args })
        const response = await within(wire.next(), 10_000, op)
        if (response.requestId !== id) throw new Error('request correlation mismatch')
        return response
      },
      async unload() { await fiber.dispose() },
      async dispose() { await root.fiber.dispose() },
    }
  } catch (error) { await root.fiber.dispose(); throw error }
}
