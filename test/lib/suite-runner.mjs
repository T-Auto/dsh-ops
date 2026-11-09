import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import path from 'node:path'

export function testJobs(raw = process.env.DSH_OPS_TEST_JOBS) {
  if (raw === undefined || raw === '') return availableParallelism()
  const jobs = Number(raw)
  if (!Number.isSafeInteger(jobs) || jobs < 1) throw new Error(`invalid DSH_OPS_TEST_JOBS: ${raw}`)
  return jobs
}

/** No exclusive suite overlaps any other suite, including another exclusive suite. */
export async function runPool(suites, { jobs, exclusive = new Set(), run }) {
  const parallel = suites.filter(suite => !exclusive.has(path.basename(suite)))
  const serial = suites.filter(suite => exclusive.has(path.basename(suite)))
  let next = 0
  await Promise.all(Array.from({ length: Math.min(jobs, parallel.length) }, async () => {
    while (next < parallel.length) await run(parallel[next++])
  }))
  for (const suite of serial) await run(suite)
}

/** Buffer stdout and stderr together in arrival order; the caller prints one finished block. */
export async function runSuite(suite, { cwd, env = {}, timeoutMs }) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-ops-test-home-'))
  const label = path.basename(suite)
  const started = performance.now()
  const chunks = []
  const child = spawn(process.execPath, [suite], {
    cwd, env: { ...process.env, ...env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  })
  child.stdout.on('data', chunk => chunks.push(chunk))
  child.stderr.on('data', chunk => chunks.push(chunk))
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    chunks.push(Buffer.from(`--- ${label} exceeded the ${Math.round(timeoutMs / 1000)}s suite deadline; stopping its owned process tree\n`))
    if (!child.pid) return
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 })
    } else {
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
        if (error.code !== 'ESRCH') chunks.push(Buffer.from(`${error}\n`))
      }
    }
  }, timeoutMs)
  const status = await new Promise(resolve => {
    child.once('error', error => chunks.push(Buffer.from(`${error}\n`)))
    child.once('close', resolve)
  })
  clearTimeout(timer)
  let cleanupFailed = false
  try { rmSync(home, { recursive: true, force: true }) } catch (error) {
    cleanupFailed = true
    chunks.push(Buffer.from(`cannot remove suite home: ${error}\n`))
  }
  return { label, status: cleanupFailed ? 1 : status, timedOut,
    durationMs: performance.now() - started, output: Buffer.concat(chunks).toString('utf8') }
}
