/**
 * G4 (#614): one worker call, measured. The worker is the shipped binary; both arms
 * send the same envelope and differ only in whether the trusted cache_dir field is
 * present, which is exactly the host's indexCache switch (see test/index-cache).
 *
 * @module dsh-ops/bench/index-ab/measure
 */

import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'

/** The envelope every measured call sends; request ids stay unique per call. */
export function workerRequest(options) {
  const { root, scope = 'g4-index-ab', patterns, cacheDir = null, timeoutMs = 120_000 } = options
  const request = {
    root,
    scope,
    tool: 'glob',
    args: { path: root, pattern: patterns, limit: 10_000 },
    read_only: true,
    deny_roots: [],
    deny_credential_names: false,
  }
  if (cacheDir !== null) request.cache_dir = cacheDir
  return {
    version: 1,
    requestId: 'g4-' + createHash('sha256').update(JSON.stringify({ root, patterns, index: cacheDir !== null })).digest('hex').slice(0, 24),
    component: 'file',
    budget: { timeoutMs, maxBytes: 131072 },
    request,
  }
}

/** sha256 of the measured worker binary; the report carries it so a rerun can prove identity. */
export function workerSha256(worker) {
  return createHash('sha256').update(fs.readFileSync(worker)).digest('hex')
}

/** Read VmHWM (kB) from /proc; null where the kernel does not expose it. */
function readHighWaterMark(pid) {
  try {
    const status = fs.readFileSync('/proc/' + pid + '/status', 'utf8')
    const match = /VmHWM:\s+(\d+)\s+kB/.exec(status)
    return match ? Number(match[1]) : null
  } catch { return null }
}

/**
 * Run one worker call and record wall time, peak RSS and the raw result bytes.
 * @param {{worker: string, envelope: object, timeoutMs?: number}} options - the binary, its request and a hard cap.
 * @returns {Promise<{wallMs: number, rssKb: number|null, stdout: string, stderr: string, status: number|null, timedOut: boolean}>} the measurement.
 */
export function runWorker(options) {
  const { worker, envelope, timeoutMs = 120_000 } = options
  return new Promise((resolve) => {
    const started = process.hrtime.bigint()
    const child = spawn(worker, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    let rssKb = null
    let timedOut = false
    const poll = setInterval(() => {
      const observed = readHighWaterMark(child.pid)
      if (observed !== null && (rssKb === null || observed > rssKb)) rssKb = observed
    }, 2)
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    child.stdout.on('data', (chunk) => { if (stdout.length < 4 * 1024 * 1024) stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8') })
    child.on('error', (error) => { clearInterval(poll); clearTimeout(timer); resolve({ wallMs: 0, rssKb, stdout, stderr: stderr + String(error), status: null, timedOut }) })
    child.on('close', (status) => {
      clearInterval(poll)
      clearTimeout(timer)
      const wallMs = Number(process.hrtime.bigint() - started) / 1e6
      resolve({ wallMs, rssKb, stdout, stderr, status, timedOut })
    })
    child.stdin.end(JSON.stringify(envelope) + '\n')
  })
}

/** Parse the worker's one-line JSON result; a non-JSON payload is itself evidence of a failure. */
export function parseResult(stdout) {
  try { return JSON.parse(stdout) } catch { return null }
}
