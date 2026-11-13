/** Ordinary disposable user process for the Windows shell-range probe. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import net from 'node:net'

const [mode, stdoutPath, stderrPath, controlPath, ...arguments_] = process.argv.slice(2)
const sockets = []
let leaf, keepAlive, rejectFailure
const failure = new Promise((_, reject) => { rejectFailure = reject })
const observe = emitter => emitter.on('error', rejectFailure)
observe(process.stdout)
observe(process.stderr)

async function connect(path) {
  const socket = observe(net.createConnection({ path }))
  sockets.push(socket)
  await once(socket, 'connect')
  return socket
}

// Waiting for each write callback bounds pending storage even when write() returns false.
const write = (stream, bytes) => new Promise((resolve, reject) => {
  stream.write(bytes, error => error ? reject(error) : resolve())
})
const receipt = (stream, type, details = {}) => write(stream,
  `${JSON.stringify({ type, pid: process.pid, ppid: process.ppid, ...details })}\n`)

async function flood(stream, byte) {
  const chunk = Buffer.alloc(16 * 1024, byte)
  for (let written = 0; written < 1024 * 1024; written += chunk.length) {
    await write(stream, chunk)
  }
}

async function main() {
  if (!['once', 'flood', 'hold'].includes(mode) || !stdoutPath || !stderrPath || !controlPath) {
    throw new Error('expected once|flood|hold and three private pipe paths')
  }
  if (mode === 'hold') {
    // Launch before any pipe connection: Job ownership must cover early descendants,
    // including a detached process group, without cooperation from the child.
    leaf = observe(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore', detached: true, windowsHide: true,
    }))
  }
  const [stdout, stderr, control] = await Promise.all(
    [stdoutPath, stderrPath, controlPath].map(connect))
  if (mode === 'once') {
    await Promise.all([
      write(stdout, `${JSON.stringify(arguments_)}\n`),
      write(stderr, 'private-stderr\n'),
      receipt(control, 'ready'),
    ])
  } else if (mode === 'flood') {
    await receipt(control, 'ready')
    await Promise.all([
      flood(stdout, 'o'), flood(stderr, 'e'),
      flood(process.stdout, 'O'), flood(process.stderr, 'E'),
    ])
    await receipt(control, 'end', { bytes: 1024 * 1024 })
  } else {
    await receipt(control, 'ready', { leafPid: leaf.pid })
    keepAlive = setInterval(() => {}, 1000)
    await new Promise(() => {})
  }
  await Promise.all(sockets.map(socket => new Promise(resolve => socket.end(resolve))))
  // The server has no return traffic; close the readable halves after flushed writes.
  for (const socket of sockets) socket.destroy()
}

try {
  await Promise.race([main(), failure])
} catch (error) {
  process.exitCode = 1
  clearInterval(keepAlive)
  for (const socket of sockets) socket.destroy()
  leaf?.kill()
  process.stderr.write(`shell-child fixture: ${error.stack ?? error}\n`)
}
