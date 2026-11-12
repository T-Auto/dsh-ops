/** Opt-in sampler for an already mounted real tool call; never launches shells itself. */
import { performance } from 'node:perf_hooks'

const percentile = (values, fraction) => values[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? null
const summary = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return { count: sorted.length, p50: percentile(sorted, 0.50), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99) }
}
const count = (name, value, minimum, maximum) => {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new RangeError(`${name} must be an integer in [${minimum}, ${maximum}]`)
}

/**
 * `invoke` must await the complete Native/PTC call, including result delivery. Bind authority,
 * workspace and output limits through that real tool, not a raw-spawn benchmark substitute.
 * `validate` checks workload-specific output without retaining it in the report.
 * No files, background sampling loops, retries, parallel calls or global state are created here.
 */
export async function sampleExecution({ invoke, validate, metadata, samples = 200, warmup = 10, signal }) {
  if (typeof invoke !== 'function' || typeof validate !== 'function') throw new TypeError('invoke and validate are required')
  count('samples', samples, 1, 10_000)
  count('warmup', warmup, 0, 1_000)
  for (const field of ['system', 'host', 'plugin', 'runtime', 'permission', 'projection', 'workload', 'storage', 'cache']) {
    if (typeof metadata?.[field] !== 'string' || !metadata[field].trim()) throw new TypeError(`metadata.${field} is required`)
  }
  const rows = []
  const cpu = process.cpuUsage()
  const started = performance.now()
  let peakSamplerRss = process.memoryUsage().rss
  for (let index = 0; index < 1 + warmup + samples; index++) {
    signal?.throwIfAborted()
    const phase = index === 0 ? 'first-call' : index <= warmup ? 'warmup' : 'hot'
    const begin = performance.now()
    let result, error, success = false
    try { result = await invoke({ signal }) }
    catch (cause) { error = cause instanceof Error ? cause.name : 'UnknownError' }
    // Validation is deliberately outside the call's measured wall time.
    const wallMs = performance.now() - begin
    if (!error) {
      try { success = await validate(result) === true }
      catch (cause) { error = cause instanceof Error ? cause.name : 'ValidationError' }
    }
    const timing = result?.executionTiming ?? result?.diagnostics?.timing
    rows.push({ index, phase, wallMs, success, ...(error ? { error } : {}),
      ...(timing?.version === 1 ? { timing } : {}) })
    peakSamplerRss = Math.max(peakSamplerRss, process.memoryUsage().rss)
  }
  const elapsedMs = performance.now() - started
  const usage = process.cpuUsage(cpu)
  const hot = rows.filter(row => row.phase === 'hot')
  const phases = Object.fromEntries(['admission', 'policy', 'queue', 'prepare', 'launch', 'hostWait', 'outputFinalize', 'resultReturn']
    .map(name => [name, summary(hot.map(row => row.timing?.phases?.[name])
      .filter(phase => phase?.status === 'completed').map(phase => phase.durationMs))]))
  return { version: 1, metadata: { ...metadata }, samples, warmup, rows,
    hot: { wallMs: summary(hot.map(row => row.wallMs)), phases,
      failures: hot.filter(row => !row.success).length,
      errorRate: hot.filter(row => !row.success).length / hot.length,
      callsPerSecond: hot.length * 1000 / hot.reduce((total, row) => total + row.wallMs, 0) },
    resources: { scope: 'sampler-process-only', elapsedMs, cpuUserMicros: usage.user,
      cpuSystemMicros: usage.system, peakObservedRssBytes: peakSamplerRss,
      childCpu: null, childRss: null, handles: null, temporaryDisk: null },
    qualification: 'Diagnostic samples only. First-call is not proof of a cold cache; no safety equivalence or cross-platform victory is inferred.' }
}
