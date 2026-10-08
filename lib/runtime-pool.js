/** One plugin-owned FastCtx connection shared by independently toggled components. */
import { McpStdioClient } from './handshake.js'
const pools = new WeakMap()
export async function acquireRuntime(ctx, runtime, env) {
  const root = ctx.root
  let pool = pools.get(root)
  if (!pool) { pool = { clients: new Map(), closing: Promise.resolve() }; pools.set(root, pool) }
  await pool.closing
  let entry = pool.clients.get(runtime.file)
  if (!entry) {
    const client = McpStdioClient.start({ file: runtime.file, args: ['serve', '--enable-shell'], env, timeoutMs: 60000 })
    entry = { client, refs: 0, ready: undefined }
    pool.clients.set(runtime.file, entry)
    entry.ready = (async () => {
      try {
        const handshake = await client.initialize('dsh-ops-components')
        const tools = await client.listTools()
        return { client, handshake, tools }
      } catch (error) {
        if (pool.clients.get(runtime.file) === entry) pool.clients.delete(runtime.file)
        await client.close()
        throw error
      }
    })()
    void client.exited.then(() => { if (pool.clients.get(runtime.file) === entry) pool.clients.delete(runtime.file) })
  }
  entry.refs += 1
  let released = false
  const release = async () => {
    if (released) return
    released = true
    entry.refs -= 1
    if (!entry.refs) {
      if (pool.clients.get(runtime.file) === entry) pool.clients.delete(runtime.file)
      const closing = pool.closing.then(() => entry.client.close())
      pool.closing = closing.catch(() => {})
      await closing
    }
  }
  try { return { ...await entry.ready, release } }
  catch (error) { await release(); throw error }
}
