
/** Persistent Niubash session (real #872 driver) vs naive persistent niu.exe vs native WSL bash. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

const ROOT = process.env.OPS_ROOT
const NIU = process.env.OPS_NIU || path.join(ROOT, 'runtime/win32-x64/niubash/niu.exe')
const DRIVER = process.env.OPS_DRIVER || path.join(ROOT, 'native/target/release/examples/shell_driver.exe')
const WSL = 'wsl.exe'
const DISTRO = process.env.WSL_DISTRO || 'Ubuntu-24.04'
const SAMPLES = Number(process.env.SAMPLES || 300)
const WARMUP = Number(process.env.WARMUP || 30)
const MB = Number(process.env.BULK_MB || 256)
const execFileAsync = promisify((await import('node:child_process')).execFile)

const requireFromRoot = createRequire(path.join(ROOT, 'package.json'))
async function pkg(name) {
  try { return await import(pathToFileURL(requireFromRoot.resolve(name)).href) }
  catch {
    const dir = path.join(ROOT, 'node_modules', ...name.split('/'))
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    const entry = typeof meta.exports === 'string' ? meta.exports : meta.exports?.['.']?.import ?? meta.exports?.['.']?.default ?? meta.module ?? meta.main ?? 'index.js'
    return import(pathToFileURL(path.join(dir, typeof entry === 'string' ? entry : entry.default)).href)
  }
}
const pick = (p, label) => {
  const sorted = [...p].sort((a, b) => a - b)
  const at = q => sorted[Math.min(sorted.length - 1, Math.ceil((q / 100) * sorted.length) - 1)]
  return { label, n: p.length, min: +sorted[0].toFixed(2), p50: +at(50).toFixed(2), p95: +at(95).toFixed(2), p99: +at(99).toFixed(2), max: +sorted.at(-1).toFixed(2), mean: +(p.reduce((a, b) => a + b, 0) / p.length).toFixed(2) }
}
const sha = file => { try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex') } catch { return null } }
const report = { kind: 'niubash-vs-wsl', startedAt: new Date().toISOString(), head: await execFileAsync('git', ['-C', ROOT, 'rev-parse', 'HEAD']).then(v => v.stdout.trim()).catch(() => null), host: { platform: process.platform, arch: process.arch, node: process.version, cpu: os.cpus()[0]?.model, cores: os.cpus().length, totalMemGB: +(os.totalmem() / 2 ** 30).toFixed(1) },
  rounds: { samples: SAMPLES, warmup: WARMUP, bulkMB: MB }, artifacts: { driverSha256: sha(DRIVER), niuSha256: sha(NIU) }, limitations: [
    'driver arm: the #872 native shell_driver at detached HEAD 06c22a65 (release), one shell per session, anonymous-pipe endpoints plus per-call receipt files.',
    'naive arm: the same niu.exe payload driven over one stdin/stdout pipe with an echo sentinel; no per-call pipes, no receipt files. This isolates payload cost from driver design.',
    'wsl arm: Ubuntu bash over the same stdin/stdout sentinel, so naive and wsl arms share framing exactly.',
    'All arms exclude DSH host, Cordis assembly, kernel frames and model-facing rendering; a real tool call adds equal overhead on every arm.',
    'Bulk I/O compares NTFS through the Niubash MSYS layer against ext4 inside the WSL2 vhdx on the same physical machine, not the same filesystem or cache state.',
  ], arms: {}, ok: true }

// ---- shared stdin/stdout sentinel arm -------------------------------------
async function pipeArm({ label, file, args, cwd, env, cwdCommand, oneshot }) {
  const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], env })
  child.stderr.setEncoding('utf8')
  let stderr = ''
  child.stderr.on('data', d => { stderr += d })
  child.stdout.setEncoding('utf8')
  const stamp = Math.random().toString(36).slice(2)
  let buffer = '', pending = null, dead = null
  child.on('exit', code => { dead = new Error(label + ' exited ' + code + ': ' + stderr.slice(0, 300)); if (pending) { const r = pending.reject; pending = null; r(dead) } })
  child.on('error', error => { dead = error; if (pending) { const r = pending.reject; pending = null; r(error) } })
  child.stdout.on('data', chunk => {
    buffer += chunk
    if (!pending) return
    const index = buffer.indexOf(pending.token)
    if (index < 0) return
    const out = buffer.slice(0, index)
    buffer = buffer.slice(index + pending.token.length)
    const resolve = pending.resolve; pending = null; resolve(out)
  })
  const send = (command, timeoutMs = 240000) => new Promise((resolve, reject) => {
    if (pending) { reject(new Error('one call at a time')); return }
    if (dead) { reject(dead); return }
    const token = '__DONE_' + stamp + '_' + Math.random().toString(36).slice(2) + ':'
    const timer = setTimeout(() => { pending = null; reject(new Error(label + ' call timeout')) }, timeoutMs)
    pending = { token, resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } }
    child.stdin.write(command + '\n' + 'echo "' + token + '$?"' + '\n')
  })
  const waitReady = async () => {
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise(r => setTimeout(r, attempt === 0 ? 1200 : 500))
      try { const out = await send("printf '__PING_" + stamp + "\\n'", 4000); if (out.includes('__PING_' + stamp)) return } catch { if (dead) throw dead }
    }
    throw new Error(label + ' never answered a ping: ' + stderr.slice(0, 300))
  }
  await waitReady()
  const call = async command => { const started = performance.now(); const out = await send(command); return { out, wallMs: performance.now() - started } }
  await call(cwdCommand)
  const version = await call('bash --version | head -1')
  for (let i = 0; i < WARMUP; i++) await call(':')
  const roundtrip = []
  for (let i = 0; i < SAMPLES; i++) roundtrip.push((await call(':')).wallMs)
  const printf = []
  for (let i = 0; i < Math.min(SAMPLES, 100); i++) printf.push((await call("printf 'x'")).wallMs)
  const tP = performance.now()
  await call('yes x | head -c 8388608 | wc -c')
  const pipelineMs = performance.now() - tP
  const tW = performance.now()
  await call('yes x | head -c ' + MB * 1024 * 1024 + ' > bulk.bin; wc -c < bulk.bin')
  const writeMs = performance.now() - tW
  const tR = performance.now()
  await call('sha256sum bulk.bin')
  const readMs = performance.now() - tR
  const loop = await call('time (for i in $(seq 1 20000); do :; done) 2>&1 | tail -3')
  const oneshotMs = []
  if (oneshot) {
    for (let i = 0; i < Math.min(WARMUP, 20); i++) await oneshot()
    for (let i = 0; i < Math.min(SAMPLES, 50); i++) oneshotMs.push(await oneshot())
  }
  child.stdin.end()
  await new Promise(r => child.on('exit', r))
  return { version: version.out.trim(), roundtrip, printf, oneshot: oneshotMs, bulk: { writeMs: +writeMs.toFixed(1), readMs: +readMs.toFixed(1), mb: MB }, pipelineMs, loopText: loop.out.trim(), stderr: stderr.slice(0, 300) }
}

async function prepareNiuEnv(workspace) {
  const { scrubbedParentEnv } = await pkg('@deepseek-ai/dsh-subprocess')
  const { prepareNiubash } = await import(pathToFileURL(path.join(ROOT, 'lib/niubash/runtime.js')).href)
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bench-niu-home-')))
  const prepared = await prepareNiubash(NIU, process.env.PATH ?? process.env.Path, AbortSignal.timeout(30000), { workspaceRoot: workspace, env: { ...process.env, DSH_HOME: home } })
  const env = {}
  for (const [k, v] of Object.entries({ ...scrubbedParentEnv(), ...prepared.env, HOME: workspace, USERPROFILE: workspace })) {
    for (const old of Object.keys(env)) if (old.toUpperCase() === k.toUpperCase()) delete env[old]
    env[k] = v
  }
  return env
}

async function driverArm() {
  const { Context } = await pkg('@deepseek-ai/cordis')
  const SubprocessPlugin = (await pkg('@deepseek-ai/dsh-subprocess-local')).default
  const { residentShellBootstrap } = await import(pathToFileURL(path.join(ROOT, 'lib/execution/resident/shell-bootstrap.js')).href)
  const { channel } = await import(pathToFileURL(path.join(ROOT, 'bench/probes/872/channel.mjs')).href)
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bench-drv-')))
  const env = await prepareNiuEnv(ws)
  const ctx = new Context(); ctx.logger.level = 0
  await ctx.plugin(SubprocessPlugin)
  const handle = ctx.get('subprocess').spawn({ argv: [DRIVER], cwd: ws, graceMs: 100,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 }, control: 'pipe' } })
  handle.done.catch(() => {})
  const wire = channel(handle.control)
  const ready = await wire.next()
  if (ready.type !== 'ready') throw new Error('driver not ready')
  const ask = async (op, id, extra = {}) => {
    await wire.send({ op, id, ...extra })
    const response = await wire.next()
    if (!response.ok) throw new Error(op + ': ' + JSON.stringify(response).slice(0, 300))
    return response.result
  }
  const endpoints = await ask('prepare', 'bench')
  await ask('launch', 'bench', { argv: [NIU, ...residentShellBootstrap(endpoints)], cwd: ws, env })
  const call = async (command, timeoutMs = 240000) => {
    const started = performance.now()
    const value = await ask('call', 'bench', { requestId: 'c' + Math.random().toString(36).slice(2), command, timeoutMs })
    value.wallMs = performance.now() - started
    return value
  }
  const version = await call('bash --version | head -1')
  const control = []
  for (let i = 0; i < Math.min(SAMPLES, 100); i++) { const t = performance.now(); await ask('live', 'bench'); control.push(performance.now() - t) }
  for (let i = 0; i < WARMUP; i++) await call(':')
  const roundtrip = []
  for (let i = 0; i < SAMPLES; i++) roundtrip.push((await call(':')).wallMs)
  const printf = []
  for (let i = 0; i < Math.min(SAMPLES, 100); i++) printf.push((await call("printf 'x'")).wallMs)
  const tP = performance.now()
  await call('yes x | head -c 8388608 | wc -c')
  const pipelineMs = performance.now() - tP
  const tW = performance.now()
  await call('yes x | head -c ' + MB * 1024 * 1024 + ' > bulk.bin; wc -c < bulk.bin')
  const writeMs = performance.now() - tW
  const tR = performance.now()
  await call('sha256sum bulk.bin')
  const readMs = performance.now() - tR
  const loop = await call('time (for i in $(seq 1 20000); do :; done) 2>&1 | tail -3')
  const oneshotMs = []
  const one = async () => { const started = performance.now(); await execFileAsync(NIU, ['-c', ':'], { cwd: ws, env, timeout: 60000 }); return performance.now() - started }
  for (let i = 0; i < Math.min(WARMUP, 20); i++) await one()
  for (let i = 0; i < Math.min(SAMPLES, 50); i++) oneshotMs.push(await one())
  await ask('stop', 'bench')
  handle.control.end()
  try { await handle.done } catch {}
  await ctx.fiber.dispose()
  return { version: version.outputs?.[0]?.text?.trim(), control, roundtrip, printf, oneshot: oneshotMs, bulk: { writeMs: +writeMs.toFixed(1), readMs: +readMs.toFixed(1), mb: MB }, pipelineMs, loopText: loop.outputs?.[0]?.text }
}

try {
  if (!process.env.ONLY_WSL) {
    const a = await driverArm()
    report.arms.driver = { label: 'niubash persistent session via #872 native driver', version: a.version, control: pick(a.control, 'driver control round trip (no shell)'), roundtrip: pick(a.roundtrip, 'persistent session, empty command'), printf: pick(a.printf, 'persistent session, printf x'), oneshot: pick(a.oneshot, 'one-shot niu.exe process'), bulk: a.bulk, pipeline: { ms: +a.pipelineMs.toFixed(1), mibPerSec: +(8 / (a.pipelineMs / 1000)).toFixed(1) }, loop: a.loopText }
    const naiveWs = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bench-naive-')))
    const naiveEnv = await prepareNiuEnv(naiveWs)
    const b = await pipeArm({ label: 'naive niu', file: NIU, args: ['--noprofile', '--norc', '-s'], cwd: naiveWs, env: naiveEnv, cwdCommand: 'cd "' + naiveWs.replaceAll('\\', '/').replace('C:', '/c') + '"',
      oneshot: async () => { const started = performance.now(); await execFileAsync(NIU, ['-c', ':'], { cwd: naiveWs, env: naiveEnv, timeout: 60000 }); return performance.now() - started } })
    report.arms.naive = { label: 'niubash payload over one stdin/stdout pipe', version: b.version, roundtrip: pick(b.roundtrip, 'persistent shell, empty command'), printf: pick(b.printf, 'persistent shell, printf x'), oneshot: pick(b.oneshot, 'one-shot niu.exe process'), bulk: b.bulk, pipeline: { ms: +b.pipelineMs.toFixed(1), mibPerSec: +(8 / (b.pipelineMs / 1000)).toFixed(1) }, loop: b.loopText, stderr: b.stderr }
  }
  if (!process.env.ONLY_NIU) {
    const distroDir = '/tmp/bench-wsl-' + Date.now()
    const c = await pipeArm({ label: 'wsl', file: WSL, args: ['-d', DISTRO, '--', 'bash', '--noprofile', '--norc', '-s'], cwd: process.cwd(),
      cwdCommand: 'mkdir -p ' + distroDir + ' && cd ' + distroDir,
      oneshot: async () => { const started = performance.now(); await execFileAsync(WSL, ['-d', DISTRO, '--', 'bash', '--noprofile', '--norc', '-c', ':'], { timeout: 60000 }); return performance.now() - started } })
    report.arms.wsl = { label: 'native WSL bash over one stdin/stdout pipe', version: c.version, roundtrip: pick(c.roundtrip, 'persistent shell, empty command'), printf: pick(c.printf, 'persistent shell, printf x'), oneshot: pick(c.oneshot, 'one-shot wsl.exe session'), bulk: c.bulk, pipeline: { ms: +c.pipelineMs.toFixed(1), mibPerSec: +(8 / (c.pipelineMs / 1000)).toFixed(1) }, loop: c.loopText, stderr: c.stderr }
  }
} catch (error) {
  report.ok = false; report.error = String(error.stack ?? error)
}
report.driverSource = process.env.OPS_DRIVER_SOURCE
report.finishedAt = new Date().toISOString()
fs.writeFileSync(process.env.REPORT || 'report.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
process.exit(report.ok ? 0 : 1)
