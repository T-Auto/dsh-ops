/** Child fixtures for the public-host feasibility probe; no production behavior. */
import { openInheritedControlChannel } from '@deepseek-ai/dsh-subprocess/control'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { channel, within } from './channel.mjs'
import { boot } from './host.mjs'

const [mode, workspace] = process.argv.slice(2)
const fixture = fileURLToPath(import.meta.url)

if (mode === 'leaf') {
  process.stdout.write(`${process.pid}\n`)
  setInterval(() => {}, 60_000)
} else if (mode === 'kernel') {
  const control = openInheritedControlChannel()
  // A test-only stand-in for the Rust process module's shell child. Ordinary
  // non-detached creation inherits the ONE outer Job/cgroup. Starting a second
  // host provider here would move Linux work into an unrelated systemd scope.
  const leaf = spawn(process.execPath, [fixture, 'leaf', workspace], {
    cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  })
  const leafExit = new Promise(resolve => leaf.once('exit', resolve))
  const leafPid = await within(new Promise((resolve, reject) => {
    let text = ''
    leaf.stdout.on('data', bytes => {
      text += bytes.toString()
      if (text.includes('\n')) resolve(Number(text.trim()))
      if (text.length > 64) reject(new Error('invalid leaf identity'))
    })
    leaf.stdout.on('error', reject)
  }), 10_000, 'descendant startup')
  let stopping = false
  const close = async () => {
    if (stopping) return
    stopping = true
    if (leaf.exitCode === null && leaf.signalCode === null) leaf.kill('SIGKILL')
    await leafExit
    control.destroy()
  }
  const wire = channel(control, () => { void close() })
  const instance = randomUUID()
  process.stdout.write('ordinary stdout is separate\n')
  process.stderr.write('ordinary stderr is separate\n')
  const linuxCgroup = process.platform === 'linux' ? await readFile('/proc/self/cgroup', 'utf8') : undefined
  await wire.send({ type: 'hello', pid: process.pid, leafPid, instance, workspace, linuxCgroup })
  try {
    while (!stopping) {
      const request = await wire.next()
      if (request.context?.instance !== instance || request.context?.workspace !== workspace) throw new Error('wrong trusted fixture context')
      const base = { requestId: request.requestId, type: 'completed', pid: process.pid, instance }
      if (request.op === 'stat') {
        const info = await stat(path.join(workspace, 'AGENTS.md'))
        await wire.send({ ...base, bytes: info.size, file: info.isFile() })
      } else if (request.op === 'stall') {
        await wire.send({ ...base, state: 'blocking' })
        // No heartbeats, JS listeners or EOF cleanup can run during this wait.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000)
      } else if (request.op === 'crash') {
        await wire.send({ ...base, state: 'crashing' })
        process.kill(process.pid, 'SIGKILL')
      } else throw new Error('unknown probe operation')
    }
  } catch (error) {
    if (!stopping) process.stderr.write(`${error.stack}\n`)
  } finally { await close() }
} else if (mode === 'owner') {
  const host = await boot(workspace)
  process.send({ ...host.hello, type: 'ready' })
  process.on('message', async message => {
    try {
      if (message.op === 'stall') {
        await host.request('stall')
        process.send({ type: 'stalled' })
      } else if (message.op === 'dispose') {
        await host.dispose()
        process.send({ type: 'disposed' }, () => process.disconnect())
      }
    } catch (error) { process.send({ type: 'error', error: String(error.stack) }) }
  })
} else throw new Error(`unknown fixture mode ${mode}`)
