/** Run: node bench/probes/probe-872-host.mjs. Uses no build or paid services.
 * Synthetic Slice A substrate evidence, not the implementation of issue #872.
 * Raw spawn launches disposable test hosts and ordinary synthetic shell leaves;
 * every managed kernel uses the real public ctx.subprocess.spawn service.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { performance } from 'node:perf_hooks'
import { boot } from './872/host.mjs'
import { within } from './872/channel.mjs'

const workspace = fileURLToPath(new URL('../../', import.meta.url))
const fixture = fileURLToPath(new URL('./872/process.mjs', import.meta.url))
const findings = [], ownership = [], owned = new Set()
const alive = pid => {
  try { process.kill(pid, 0); return true }
  catch (error) { if (error.code === 'ESRCH') return false; throw error }
}
async function gone(pids, ms = 10_000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (pids.every(pid => !alive(pid))) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.deepEqual(pids.filter(alive), [], 'owned processes survived cleanup deadline')
}
function track(hello) {
  owned.add(hello.pid); owned.add(hello.leafPid)
  ownership.push({ kernelPid: hello.pid, leafPid: hello.leafPid, linuxCgroup: hello.linuxCgroup })
}
function processState(pid) {
  if (process.platform !== 'linux') return { pid, exists: alive(pid) }
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)
    return { pid, state: fields[0], parentPid: Number(fields[1]), processGroup: Number(fields[2]),
      session: Number(fields[3]), startTime: fields[19], linuxCgroup: readFileSync(`/proc/${pid}/cgroup`, 'utf8') }
  } catch (error) { return { pid, diagnostic: String(error) } }
}
async function check(name, body) {
  const start = performance.now()
  try { findings.push({ name, status: 'pass', ...(await body()), elapsedMs: Math.round(performance.now() - start) }) }
  catch (error) { findings.push({ name, status: 'fail', error: String(error.stack), elapsedMs: Math.round(performance.now() - start) }) }
  process.stdout.write(`${JSON.stringify(findings.at(-1))}\n`)
}
async function waitMessage(child, type) {
  return within(new Promise((resolve, reject) => {
    const onMessage = value => {
      if (value.type === type) { cleanup(); resolve(value) }
      else if (value.type === 'error') { cleanup(); reject(new Error(value.error)) }
    }
    const onExit = (code, signal) => { cleanup(); reject(new Error(`test host exited ${code ?? signal}`)) }
    const cleanup = () => { child.off('message', onMessage); child.off('exit', onExit) }
    child.on('message', onMessage); child.once('exit', onExit)
  }), 20_000, type)
}

await check('three distinct roots share home/workspace with one kernel each', async () => {
  const hosts = []
  try {
    for (let i = 0; i < 3; i++) { const host = await boot(workspace); hosts.push(host); track(host.hello) }
    assert.equal(new Set(hosts.map(h => h.root)).size, 3)
    assert.equal(new Set(hosts.map(h => h.hello.pid)).size, 3)
    assert.equal(new Set(hosts.map(h => h.hello.instance)).size, 3)
    const samples = []
    for (let i = 0; i < 25; i++) for (const host of hosts) {
      const start = performance.now(), result = await host.request('stat')
      samples.push(performance.now() - start)
      assert.equal(result.file, true); assert.ok(result.bytes > 0)
      assert.equal(result.pid, host.hello.pid)
    }
    assert.deepEqual(hosts.map(h => h.spawns), [1, 1, 1])
    await hosts[0].unload()
    await gone([hosts[0].hello.pid, hosts[0].hello.leafPid])
    assert.equal(hosts[0].handle.collected.stdout.readFrom(0).text, 'ordinary stdout is separate\n')
    assert.equal(hosts[0].handle.collected.stderr.readFrom(0).text, 'ordinary stderr is separate\n')
    await assert.rejects(hosts[0].request('stat'), /unloaded/)
    for (const host of hosts.slice(1)) assert.equal((await host.request('stat')).file, true)
    const ordered = samples.sort((a, b) => a - b)
    return { requests: samples.length, spawns: 3, home: os.homedir(), workspace,
      controlFrameLimit: 65_536, queueLimit: 16, p50Ms: ordered[Math.floor(ordered.length / 2)],
      note: 'Smoke latency only; not the required 200-sample interleaved production benchmark.' }
  } finally { await Promise.allSettled(hosts.map(host => host.dispose())) }
})

for (const stalled of [false, true]) await check(`control disconnection cleans ${stalled ? 'blocked' : 'responsive'} kernel range`, async () => {
  const host = await boot(workspace)
  track(host.hello)
  try {
    if (stalled) await host.request('stall')
    host.handle.control.destroy()
    assert.equal(await host.handle.waitForExit(AbortSignal.timeout(10_000)), true)
    await gone([host.hello.pid, host.hello.leafPid])
    return { cleanup: 'consumer control-close handler calls public handle.terminate()' }
  } finally { await host.dispose() }
})

await check('kernel hard crash leaves no descendant', async () => {
  const host = await boot(workspace)
  track(host.hello)
  try {
    await host.request('crash')
    assert.equal(await host.handle.waitForExit(AbortSignal.timeout(10_000)), true)
    await gone([host.hello.pid, host.hello.leafPid])
    return { cleanup: 'consumer done/control-close handler calls public handle.terminate(); no replay' }
  } finally { await host.dispose() }
})

for (const stalled of [false, true]) await check(`hard host death cleans ${stalled ? 'blocked' : 'responsive'} kernel and descendant`, async () => {
  // Explicit test observer outside the doomed host: production launches never use raw spawn.
  const child = spawn(process.execPath, [fixture, 'owner', workspace], {
    cwd: workspace, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  owned.add(child.pid)
  let diagnostic = ''
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-4096) })
  try {
    const hello = await waitMessage(child, 'ready')
    track(hello)
    if (stalled) { const ready = waitMessage(child, 'stalled'); child.send({ op: 'stall' }); await ready }
    process.kill(child.pid, 'SIGKILL')
    await gone([child.pid, hello.pid, hello.leafPid])
    return { cleanup: stalled ? 'host OS ownership; kernel event loop blocked, EOF cannot run' : 'host ownership or cooperative EOF', pids: [child.pid, hello.pid, hello.leafPid] }
  } catch (error) { throw new Error(`${error.stack}\n${diagnostic}`) }
  finally { if (alive(child.pid)) process.kill(child.pid, 'SIGKILL') }
})

// Test emergency cleanup is reported separately and never converts a failed
// ownership assertion into a pass. These identities were reported by fixtures.
const survivors = [...owned].filter(alive)
const survivorStates = survivors.map(processState)
for (const pid of survivors) { try { process.kill(pid, 'SIGKILL') } catch {} }
const result = { platform: process.platform, node: process.version,
  status: findings.every(f => f.status === 'pass') ? 'pass' : 'fail', findings,
  ownership, emergencyCleanupPids: survivors, survivorStates,
  scope: 'Real pinned public host, synthetic kernel; no Rust resident protocol or persistent shell implemented.',
  untested: process.platform === 'win32' ? ['Linux', 'macOS', 'Windows Job create-to-assignment crash interval', 'breakaway descendants'] : ['other operating systems'],
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (result.status !== 'pass') process.exitCode = 1
