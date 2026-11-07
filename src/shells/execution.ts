/** Live Bash command over the host subprocess service; no service registration. */
import { Buffer } from 'node:buffer'
import path from 'node:path'
import type { SubprocessHandle, SubprocessOutputReader, SubprocessOutputRead } from '../adapter/dsh/types.js'
import type { ShellExecutorOptions, ShellExecutionSpec, ShellCall, ShellExecution, ShellResult, ShellStream } from './types.js'
import { errorMessage } from './types.js'
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_MAX_SPILL_BYTES, shellEnvOverrides } from './constants.js'
import { recordSettledSpill } from './spill-ledger.js'
import { noteSpillSettled } from './spill-retention-runtime.js'
import { formatBashSpawnError } from './spawn-error.js'

const emptyRead = (): SubprocessOutputRead => ({ text: '', nextOffset: 0, lossy: false })

const ELECTRON_NODE_MODE = 'ELECTRON_RUN_AS_NODE'

/** A confined Windows sandbox runs the Desktop executable itself as the runner; give it Node mode (#574). */
function adaptElectronRunner(argv: string[], env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!globalThis.process.versions.electron || !argv[0]) return env
  const normalize = (file: string) => globalThis.process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)
  if (normalize(argv[0]) !== normalize(globalThis.process.execPath)) return env
  const keyOf = (key: string) => globalThis.process.platform === 'win32' ? key.toUpperCase() : key
  const existing = Object.entries(env).filter(([key]) => keyOf(key) === ELECTRON_NODE_MODE)
  // Windows compares environment names case-insensitively: never leave two spellings behind.
  if (existing.length === 1 && existing[0][1] === '1') return env
  const cleaned = Object.fromEntries(Object.entries(env).filter(([key]) => keyOf(key) !== ELECTRON_NODE_MODE))
  return { ...cleaned, [ELECTRON_NODE_MODE]: '1' }
}

/** One settled stream plus the total the reader reported, for the ledger. */
interface SettledStream { stream: ShellStream; bytesTotal: number }

function collectStream(reader: SubprocessOutputReader | undefined, includeMetadata: boolean): SettledStream {
  const read = reader?.readFrom?.(0) ?? emptyRead()
  const text = typeof read.text === 'string' ? read.text : ''
  const bytesTotal = Number.isFinite(read.nextOffset) ? read.nextOffset : Buffer.byteLength(text)
  return {
    stream: {
      text,
      truncated: read.lossy === true,
      ...(read.spillPath !== undefined ? { spillPath: read.spillPath } : {}),
      ...(includeMetadata ? {
        bytes: Buffer.byteLength(text),
        bytesTotal,
        lines: text === '' ? 0 : text.split(/\n/).length - (text.endsWith('\n') ? 1 : 0),
      } : {}),
    },
    bytesTotal,
  }
}

/** Read the retained stream after settlement, preserving honest truncation facts. */
export function settledStream(reader: SubprocessOutputReader | undefined, includeMetadata = false): ShellStream {
  return collectStream(reader, includeMetadata).stream
}

/**
 * Record the host's settled spill files in the ownership ledger and tell the
 * retention runtime a settlement happened. Settlement belongs to the command:
 * neither step may change its result or throw.
 */
function recordSettledStreams(streams: readonly SettledStream[], exec: ShellCall): void {
  for (const { stream, bytesTotal } of streams) {
    if (typeof stream.spillPath !== 'string') continue
    recordSettledSpill({ path: stream.spillPath, bytes: bytesTotal,
      ...(typeof exec.agent?.session?.id === 'string' ? { sessionId: exec.agent.session.id } : {}) })
  }
  noteSpillSettled()
}

/**
 * Start preparation and execution once. The caller owns the returned handle; the host owns
 * process containment, collection and disposal. A job can observe output without consuming it.
 * `onExpiry: none` disables only this executor's deadline, never caller cancellation.
 */
export function startBashExecution({ file, source, subprocess, prepareArgv, env = {}, projectResult }: ShellExecutorOptions, spec: ShellExecutionSpec, exec: ShellCall = {}): ShellExecution {
  const controller = new AbortController()
  const callerSignal = exec.signal
  const startedAt = performance.now()
  let cause: 'cancelled' | 'timeout' | undefined
  let handle: SubprocessHandle | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = (kind: 'cancelled' | 'timeout', reason: unknown) => {
    if (controller.signal.aborted) return
    cause = kind
    controller.abort(reason)
  }
  const onCallerAbort = () => stop('cancelled', callerSignal?.reason)
  if (callerSignal?.aborted) onCallerAbort()
  else callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
  if (spec.onExpiry !== 'none' && !controller.signal.aborted) {
    timer = setTimeout(() => stop('timeout', new Error(`command timed out after ${spec.timeoutMs}ms`)), spec.timeoutMs)
    timer.unref?.()
  }
  const reader = (stream: 'stdout' | 'stderr'): SubprocessOutputReader => ({ readFrom: offset => handle?.collected?.[stream]?.readFrom(offset) ?? { ...emptyRead(), nextOffset: offset } })
  const process: ShellExecution = {
    status: 'running',
    get started() { return handle !== undefined },
    observed: { stdout: reader('stdout'), stderr: reader('stderr') },
    kill: reason => stop('cancelled', new Error(reason ?? 'bash execution cancelled')),
    result: () => result,
    done: Promise.resolve(),
  }
  const flags = () => ({
    timedOut: cause === 'timeout',
    timeoutMs: spec.timeoutMs,
    ...(cause === 'cancelled' ? { cancelled: true } : {}),
    ...(spec.includeDiagnostics ? { diagnostics: {
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      executor: { kind: 'subprocess', source },
    } } : {}),
  })
  const deadline = spec.onExpiry === 'none' ? Infinity : startedAt + spec.timeoutMs
  const expire = () => {
    // Synchronous runtime preparation can block the timer; never spawn after its budget expired.
    if (performance.now() >= deadline) stop('timeout', new Error(`command timed out after ${spec.timeoutMs}ms`))
  }
  const assertRunning = () => { expire(); controller.signal.throwIfAborted() }
  const run = async (): Promise<ShellResult> => {
    let value: ShellResult
    let streams: SettledStream[] = []
    let phase: 'preparation' | 'spawn' = 'preparation'
    try {
      assertRunning()
      const argv = spec.command === undefined ? [file, spec.scriptPath!] : [file, '-c', spec.command]
      // Race preparation so an unavailable provider cannot strand a cancelled job.
      let preparedArgv = argv
      if (prepareArgv) {
        let abort!: () => void
        const cancelled = new Promise<never>((_, reject) => {
          abort = () => reject(controller.signal.reason)
          controller.signal.addEventListener('abort', abort, { once: true })
        })
        try { preparedArgv = await Promise.race([prepareArgv(argv, controller.signal), cancelled]) }
        finally { controller.signal.removeEventListener('abort', abort) }
      }
      assertRunning()
      phase = 'spawn'
      if (!subprocess) throw new Error('Host subprocess service is unavailable')
      const childEnv = shellEnvOverrides(globalThis.process.env, env)
      assertRunning()
      handle = subprocess.spawn({
        argv: preparedArgv,
        // Legacy direct executor callers can omit cwd; scoped host calls resolve it before this seam.
        cwd: spec.workdir!,
        stdio: {
          // A closed pipe supplies EOF without exposing Windows NUL to MSYS as a device.
          stdin: { data: '' },
          stdout: { maxBytes: DEFAULT_MAX_OUTPUT_BYTES, spill: { maxBytes: DEFAULT_MAX_SPILL_BYTES } },
          stderr: { maxBytes: DEFAULT_MAX_OUTPUT_BYTES, spill: { maxBytes: DEFAULT_MAX_SPILL_BYTES } },
        },
        graceMs: spec.graceMs,
        signal: controller.signal,
        env: prepareArgv ? adaptElectronRunner(preparedArgv, childEnv) : childEnv,
      })
      const outcome = await handle.done
      streams = [collectStream(handle.collected?.stdout, spec.includeDiagnostics), collectStream(handle.collected?.stderr, spec.includeDiagnostics)]
      value = {
        ...(outcome?.exitCode != null ? { exitCode: outcome.exitCode } : {}),
        ...(outcome?.signal != null ? { signal: outcome.signal } : {}),
        ...flags(),
        stdout: streams[0].stream,
        stderr: streams[1].stream,
      }
    } catch (error) {
      expire()
      streams = [collectStream(handle?.collected?.stdout, spec.includeDiagnostics), collectStream(handle?.collected?.stderr, spec.includeDiagnostics)]
      value = {
        // Preparation owns authority/runtime diagnostics; spawn errors need routing.
        error: phase === 'preparation' ? errorMessage(error) : formatBashSpawnError(error, file, source, spec.workdir),
        ...flags(),
        stdout: streams[0].stream,
        stderr: streams[1].stream,
      }
    } finally {
      // Settlement is the one place the plugin learns a spill path exists, so the
      // ownership ledger and the bounded retention counter are updated here.
      try { recordSettledStreams(streams, exec) } catch { /* retention must never fail a command */ }
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onCallerAbort)
    }
    const projected = projectResult ? await projectResult(value) : value
    process.status = projected.error || projected.timedOut || projected.cancelled || projected.signal ? 'killed' : 'completed'
    process.exitCode = projected.exitCode ?? null
    process.signal = projected.signal ?? null
    process.sandbox = projected.sandbox
    return projected
  }
  const result = run()
  process.done = result.then(() => undefined, () => undefined)
  return process
}
