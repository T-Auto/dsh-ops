/** Stateful capture sink: queued filesystem work and activation lifetime only. */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { renderPanelHtml } from './render.js'
import { activityGate } from './activity.js'
import { object, field, missingFile } from './types.js'
import type { Row, PanelPaths, CaptureEvent, ArchiveMember, SessionState, CollectorOptions } from './types.js'
import { PANEL_DEFAULTS, PANEL_HTML, panelPaths, safeSessionId } from './config.js'
import { projectEvent } from './events.js'
import { parseAppendLog, foldRecords, fitDocument } from './fold.js'
export { PANEL_FORMAT, PANEL_DIR, PANEL_HTML, PANEL_DEFAULTS, PanelConfigError, resolvePanelConfig, panelPaths, safeSessionId } from './config.js'
export { projectEvent } from './events.js'
export { parseAppendLog, foldRecords, fitDocument } from './fold.js'
const string = (value: unknown) => typeof value === 'string' && value !== '' ? value : undefined
const bytes = (text: string) => Buffer.byteLength(text, 'utf8')

/**
 * Create the capture sink for one activation. It owns no timers and registers
 * nothing; persistence is per session and lazy, so no directory exists until the
 * first event of the first captured session arrives.
 * @param {object} [options] - `config`, `io`, `env`, `now`, `report` and `meta` seams.
 * Returns the collector for this activation.
 */
export function createPanelCollector(options: CollectorOptions = {}) {
  const config = options.config ?? PANEL_DEFAULTS
  const storage = options.io ?? fsp
  const activity = activityGate()
  // Fence each filesystem operation, including continuations after an awaited
  // read/write. Queued folds cannot start fresh writes once the row is stopped.
  const io = {
    readText: (file: string) => activity.run(() => storage.readFile(file, 'utf8')),
    readFile: (file: string) => activity.run(() => storage.readFile(file)),
    mkdir: (dir: string, options: { recursive: true }) => activity.run(() => storage.mkdir(dir, options)),
    appendFile: (file: string, data: string) => activity.run(() => storage.appendFile(file, data)),
    writeFile: (file: string, data: string) => activity.run(() => storage.writeFile(file, data)),
    rename: (from: string, to: string) => activity.run(() => storage.rename(from, to)),
    stat: (file: string) => activity.run(() => storage.stat(file)),
    rm: (file: string, options: { force: true }) => activity.run(() => storage.rm(file, options)),
  }
  const env = options.env ?? process.env
  const now = options.now ?? (() => Date.now())
  const report = typeof options.report === 'function' ? options.report : () => {}
  const meta = options.meta ?? {}
  const sessions = new Map<string, SessionState>()
  const noted = new Set<string>()
  let disposed = false
  let stopping: Promise<void> | undefined

  // Say something at most once per kind; reporting must never escape either.
  function note(key: string, message: string, level = 'warn') {
    if (noted.has(key)) return
    noted.add(key)
    try { report(message, level) } catch { /* a logger failure is not the session's problem */ }
  }
  function fail(key: string, error: unknown) {
    if (activity.cancelled(error)) return
    const reason = error instanceof Error ? error.message : String(error)
    note(key, `dsh-ops panel: capture failed (${key}): ${reason}; this session continues uncaptured.`, 'warn')
  }

  /** Recover the append log's header, size and persisted cap without retaining parsed payloads. */
  async function readAppendLog(wal: string) {
    let text
    try { text = await io.readText(wal) } catch (error) {
      if (missingFile(error)) return undefined
      throw error
    }
    if (text.trim() === '') return undefined
    let header: Row | undefined
    let capped = false
    for (let start = 0; start < text.length;) {
      const newline = text.indexOf('\n', start)
      const end = newline < 0 ? text.length : newline
      try {
        const parsed: unknown = JSON.parse(text.slice(start, end))
        if (object(parsed) && !Array.isArray(parsed)) {
          if (start === 0 && parsed.record === 'open') header = parsed
          // Match the fold's top-level marker contract, never cap-like text inside an event.
          if (parsed.record === 'capped') { capped = true; break }
        }
      } catch { /* malformed records are counted when the document is folded */ }
      start = end + 1
    }
    return { header, size: bytes(text), capped }
  }

  /** Open (or resume) one session's append log; refuse with one log line, never a throw. */
  function open(sessionId: string, cwd: unknown): SessionState | undefined {
    const existing = sessions.get(sessionId)
    if (existing !== undefined) return existing
    const paths = panelPaths(cwd, sessionId, { env })
    if (paths === undefined || typeof cwd !== 'string') {
      note(`path:${String(cwd)}`, `dsh-ops panel: not capturing session ${JSON.stringify(sessionId)}: `
        + 'the session needs an absolute working directory outside the DSH home and a file-name-safe id.', 'warn')
      return undefined
    }
    const state: SessionState = {
      sessionId, paths, size: 0, droppedEvents: 0, capped: false, closed: false,
      pendingBytes: 0, queueCapped: false, openFailed: false,
      header: undefined, chain: Promise.resolve(),
    }
    sessions.set(sessionId, state)
    state.chain = (async () => {
      const prior = await readAppendLog(paths.wal)
      if (prior !== undefined) {
        state.size = prior.size
        state.capped = prior.capped
        state.header = prior.header
        return
      }
      const header = { record: 'open', sessionId, cwd: path.resolve(cwd), at: new Date(now()).toISOString(), pluginVersion: string(meta.pluginVersion) }
      const line = `${JSON.stringify(header)}\n`
      await io.mkdir(paths.dir, { recursive: true })
      await io.appendFile(paths.wal, line)
      state.size += bytes(line)
      state.header = header
    })().catch((error) => {
      // Neither an unread log nor a failed header establishes a safe append state.
      state.openFailed = true
      fail('open', error)
    })
    return state
  }

  /** The first rejected event seals the retained prefix with one bounded marker. */
  async function cap(state: SessionState): Promise<void> {
    if (state.openFailed || state.capped) return
    state.capped = true
    const line = `${JSON.stringify({ record: 'capped', at: new Date(now()).toISOString(), limitBytes: config.maxSessionBytes })}\n`
    state.size += bytes(line)
    await io.appendFile(state.paths.wal, line)
  }

  /** Reserve bounded queue space immediately; admit writes only after recovery has loaded its size. */
  function append(state: SessionState, record: CaptureEvent & { record: string }) {
    if (state.closed || state.openFailed) return
    if (state.capped || state.queueCapped) { state.droppedEvents += 1; return }
    let line
    try { line = `${JSON.stringify(record)}\n` } catch (error) { fail('serialize', error); return }
    const size = bytes(line)
    if (state.size + state.pendingBytes + size > config.maxSessionBytes) {
      state.droppedEvents += 1
      // Close admission without retaining another payload or overtaking the already queued prefix.
      state.queueCapped = true
      state.chain = state.chain.then(() => cap(state)).catch((error) => { fail('append-cap', error) })
      return
    }
    state.pendingBytes += size
    state.chain = state.chain
      .then(async () => {
        state.pendingBytes -= size
        if (state.openFailed) return
        // Initial I/O may have discovered an existing log or added a new-session header.
        if (state.capped || state.size + size > config.maxSessionBytes) {
          state.droppedEvents += 1
          await cap(state)
          return
        }
        state.size += size
        await io.appendFile(state.paths.wal, line)
      })
      .catch((error) => { fail('append', error) })
  }

  /** Write `panel.html` when it is absent or stale, and describe it for the archive. */
  async function writeViewer(state: SessionState) {
    const html = renderPanelHtml()
    let current
    try { current = await io.readText(state.paths.html) } catch (error) {
      if (!missingFile(error)) throw error
    }
    if (current !== html) {
      await io.mkdir(state.paths.dir, { recursive: true })
      await io.writeFile(`${state.paths.html}.tmp-${process.pid}`, html)
      await io.rename(`${state.paths.html}.tmp-${process.pid}`, state.paths.html)
    }
    return describe(state.paths.html, PANEL_HTML, 'panel')
  }

  /** Stat and hash one archive member, or undefined when it is not on disk. */
  async function describe(file: string, relative: string, role: string): Promise<ArchiveMember | undefined> {
    try {
      const [info, contents] = await Promise.all([io.stat(file), io.readFile(file)])
      return { path: relative, bytes: info.size, sha256: createHash('sha256').update(contents).digest('hex'), role }
    } catch (error) {
      if (missingFile(error)) return undefined
      throw error
    }
  }

  /** Fold the append log into the JSON document and refresh the viewer. */
  async function materialise(state: SessionState, final: boolean): Promise<void> {
    if (state.openFailed) return
    const { paths } = state
    let text = ''
    try { text = await io.readText(paths.wal) } catch (error) {
      if (!missingFile(error)) throw error
    }
    const parsed = parseAppendLog(text)
    const document = foldRecords(parsed.records, { config, meta, droppedEvents: state.droppedEvents, malformed: parsed.malformed })
    document.events.mergedAt = new Date(now()).toISOString()
    let viewer
    try { viewer = await writeViewer(state) } catch (error) { fail('viewer', error) }
    const archive: ArchiveMember[] = []
    if (!final) {
      const log = await describe(paths.wal, `${state.sessionId}.ndjson`, 'events')
      if (log !== undefined) {
        archive.push(log)
        // `bench/run.schema.json` ties `events.files` to the NDJSON a document was sealed from.
        document.events.files = [{ path: log.path, events: document.events.records, sha256: log.sha256 }]
      }
    }
    if (viewer !== undefined) archive.push(viewer)
    document.archive = archive
    await io.mkdir(paths.dir, { recursive: true })
    await io.writeFile(`${paths.data}.tmp-${process.pid}`, fitDocument(document, config.maxSessionBytes).text)
    await io.rename(`${paths.data}.tmp-${process.pid}`, paths.data)
    if (final) { try { await io.rm(paths.wal, { force: true }) } catch (error) { fail('seal', error) } }
  }

  /** Queue a fold behind every append already scheduled for this session. */
  function merge(sessionId: string, final = false): Promise<void> {
    const state = sessions.get(sessionId)
    if (state === undefined) return Promise.resolve(undefined)
    state.chain = state.chain
      .then(() => materialise(state, final))
      .catch((error) => { fail('merge', error) })
    return state.chain
  }

  const collector = {
    config,
    /** Observe one committed session event; never throws, never rejects. */
    observe(session: unknown, event: unknown): void {
      if (disposed) return
      try {
        const sessionId = safeSessionId(field(session, 'id'))
        if (sessionId === undefined) return
        const state = open(sessionId, field(field(session, 'header'), 'cwd') ?? field(session, 'cwd'))
        if (state === undefined || state.openFailed) return
        const projected = projectEvent(event, config)
        if (projected === undefined) return
        append(state, { record: 'event', ...projected })
        // A turn end is the idle point: fold then, so the JSON is current without
        // a timer and without waiting for the session to be disposed.
        if (projected.type === 'turn/end') void merge(sessionId)
      } catch (error) { fail('observe', error) }
    },
    /** Wait for every append scheduled for one session (or all of them). */
    flush(sessionId?: string): Promise<void> {
      const targets = sessionId === undefined ? [...sessions.values()] : [sessions.get(sessionId)].filter((state): state is SessionState => state !== undefined)
      return Promise.all(targets.map((state) => state.chain)).then(() => undefined)
    },
    /** Fold one session's append log into its JSON document. */
    merge(sessionId: string): Promise<void> { return merge(sessionId, false) },
    /** Seal one session: final fold that drops the append log. */
    close(sessionId: string): Promise<void> {
      const state = sessions.get(sessionId)
      if (state === undefined || state.closed) return Promise.resolve(undefined)
      state.closed = true
      return merge(sessionId, true).then(() => { sessions.delete(sessionId) })
    },
    /** Stop collection without starting a final fold. Await all issued I/O before
     * the loader reports this row disabled; retained append logs remain recoverable. */
    stop(): Promise<void> {
      if (stopping) return stopping
      disposed = true
      activity.stop()
      stopping = collector.flush().then(() => { sessions.clear() })
      return stopping
    },
    /** Explicitly seal every session. Component teardown uses stop() instead. */
    dispose(): Promise<void> {
      if (disposed) return Promise.resolve(undefined)
      disposed = true
      return Promise.all([...sessions.keys()].map((sessionId) => collector.close(sessionId))).then(() => undefined)
    },
    /** The paths one captured session writes to, for callers that must report them. */
    pathsFor(sessionId: string): PanelPaths | undefined { return sessions.get(sessionId)?.paths },
    /** How many sessions this activation has captured. */
    get size() { return sessions.size },
  }
  return Object.freeze(collector)
}
