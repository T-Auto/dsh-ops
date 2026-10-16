import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'

export const sha256 = value => createHash('sha256').update(value).digest('hex')
export const EXPECTED_DIFFERENCES = Object.freeze({}) // 'fixture/query': 'specific reviewed semantic migration'

export function canonical(value) {
  const normalize = item => {
    if (Array.isArray(item)) return item.map(normalize)
    if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort()
      .filter(key => !['elapsedMs', 'durationMs'].includes(key)).map(key => [key, normalize(item[key])]))
    return item
  }
  return JSON.stringify(normalize(value))
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length ? (sorted[middle] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2 : null
}

// Direct native workers have no subprocess descendants; wait for close even after kill/error.
export function runWorker(binary, request, { timeoutMs = 60000, maxOutputBytes = 16 * 1024 * 1024, args = [] } = {}) {
  return new Promise(resolve => {
    const started = performance.now()
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let state = 'OK', error = '', outputBytes = 0, stderr = ''
    const chunks = []
    const stop = reason => { if (state === 'OK') { state = reason; child.kill('SIGKILL') } }
    const timer = setTimeout(() => stop('TIMEOUT'), timeoutMs)
    child.on('error', cause => { state = 'ERROR'; error = cause.message })
    child.stdin.on('error', cause => { if (cause.code !== 'EPIPE' && state === 'OK') { error = cause.message; stop('ERROR') } })
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length
      if (outputBytes > maxOutputBytes) stop('OUTPUT_LIMIT')
      else if (state === 'OK') chunks.push(chunk)
    })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(0, 4096) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const ms = performance.now() - started
      let value
      if (state === 'OK') {
        try {
          if (code !== 0 || signal) throw new Error(`worker exited ${code ?? signal}`)
          value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (!value || !['completed', 'error'].includes(value.status)) throw new Error('worker returned an invalid result envelope')
        } catch (cause) { state = 'ERROR'; error = cause.message }
      }
      resolve({ state, ms, outputBytes, value, error, stderr, pid: child.pid })
    })
    child.stdin.end(JSON.stringify(request))
  })
}

export function summarize(runs, warmup = null) {
  const all = warmup ? [warmup, ...runs] : runs
  const valid = runs.filter(run => run.state === 'OK' && run.value?.status === 'completed')
  const rejections = runs.filter(run => run.state === 'OK' && run.value?.status === 'error')
  const hashes = [...new Set(all.filter(run => run.state === 'OK').map(run => sha256(canonical(run.value))))]
  return {
    runsMs: valid.map(run => run.ms), medianMs: median(valid.map(run => run.ms)),
    rejectedRunsMs: rejections.map(run => run.ms), rejectionMedianMs: median(rejections.map(run => run.ms)),
    timeouts: runs.filter(run => run.state === 'TIMEOUT').length,
    errors: runs.filter(run => run.state !== 'OK' && run.state !== 'TIMEOUT').length,
    warmupState: warmup?.state ?? null,
    outputBytes: Math.max(0, ...runs.map(run => run.outputBytes ?? 0)),
    resultHash: hashes.length === 1 ? hashes[0] : null,
    unstable: hashes.length > 1,
    eligible: all.length > 0 && all.every(run => run.state === 'OK' && run.value?.status === 'completed') && hashes.length === 1,
    sample: all.find(run => run.state === 'OK')?.value,
    nativeErrors: [...new Map(all.filter(run => run.state === 'OK' && run.value?.status === 'error')
      .map(run => [canonical(run.value.error), run.value.error])).values()],
    failures: all.filter(run => run.state !== 'OK').map(({ state, error, stderr }) => ({ state, error, stderr })),
  }
}

export function compare(baseline, candidate, expectedDifference = null, expectedError = null) {
  const sameAsBaseline = baseline.resultHash !== null && baseline.resultHash === candidate.resultHash
  let state
  if (baseline.timeouts || candidate.timeouts || baseline.warmupState === 'TIMEOUT' || candidate.warmupState === 'TIMEOUT') state = 'TIMEOUT'
  else if (baseline.errors || candidate.errors || baseline.failures.length || candidate.failures.length) state = 'ERROR'
  else if (baseline.unstable || candidate.unstable) state = 'UNSTABLE'
  else if (!sameAsBaseline) state = expectedDifference ? 'EXPECTED_DIFFERENCE' : 'MISMATCH'
  else if (expectedError && baseline.sample?.error?.code === expectedError && candidate.sample?.error?.code === expectedError) state = 'EXPECTED_REJECTION'
  else if (!baseline.eligible || !candidate.eligible) state = 'WORKER_ERROR'
  else state = 'MATCH'
  return { state, sameAsBaseline, expectedDifference, speedup: state === 'MATCH' && candidate.medianMs > 0 ? baseline.medianMs / candidate.medianMs : null }
}

export function firstDifference(left, right, location = '$') {
  if (canonical(left) === canonical(right)) return null
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      const difference = firstDifference(left[key], right[key], `${location}.${key}`)
      if (difference) return difference
    }
  }
  const preview = value => String(canonical(value)).slice(0, 160)
  return `${location}: ${preview(left)} -> ${preview(right)}`
}
