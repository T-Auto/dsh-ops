/** Capture configuration and safe workspace-relative storage paths. */
import path from 'node:path'
import { dshHome } from '../paths.js'
import { object } from './types.js'
import type { PanelConfig, PanelPaths } from './types.js'
/** Document format tag; a reader must reject a tag it does not know. */
export const PANEL_FORMAT = 'dsh-ops/panel-capture@1'
/** Directory below the session working directory that holds both panel files. */
export const PANEL_DIR = path.join('.dsh-ops', 'panel')
/** The viewer file name inside {@link PANEL_DIR}. */
export const PANEL_HTML = 'panel.html'
/** Recognised row keys and their defaults; `capture` is the user-facing switch. */
export const PANEL_DEFAULTS: PanelConfig = Object.freeze({ capture: true, textLimit: 2_000, maxSessionBytes: 8 * 1024 * 1024 })

/** Error raised for a panel configuration value this component cannot honour. */
export class PanelConfigError extends Error {
  /** @param {string} message - what is wrong and what is accepted. */
  constructor(message: string) {
    super(`dsh-ops panel config: ${message}`)
    this.name = 'PanelConfigError'
  }
}

/** Validate one row's config, applying every default; unknown or out-of-range values fail loud. */
export function resolvePanelConfig(options: unknown = {}): PanelConfig {
  if (!object(options) || Array.isArray(options)) {
    throw new PanelConfigError(`config must be an object, got ${JSON.stringify(options)}`)
  }
  const accepted = Object.keys(PANEL_DEFAULTS)
  const unknown = Object.keys(options).filter((key) => !accepted.includes(key))
  if (unknown.length > 0) {
    throw new PanelConfigError(`unknown key ${JSON.stringify(unknown[0])}; accepted keys are `
      + `${accepted.map((key) => JSON.stringify(key)).join(', ')}`)
  }
  const config = { ...PANEL_DEFAULTS, ...options }
  if (typeof config.capture !== 'boolean') {
    throw new PanelConfigError(`capture must be a boolean, got ${JSON.stringify(config.capture)}`)
  }
  if (typeof config.textLimit !== 'number' || !Number.isSafeInteger(config.textLimit) || config.textLimit < 64 || config.textLimit > 100_000) {
    throw new PanelConfigError(`textLimit must be an integer from 64 to 100000, got ${JSON.stringify(config.textLimit)}`)
  }
  if (typeof config.maxSessionBytes !== 'number' || !Number.isSafeInteger(config.maxSessionBytes)
    || config.maxSessionBytes < 64 * 1024 || config.maxSessionBytes > 256 * 1024 * 1024) {
    throw new PanelConfigError(`maxSessionBytes must be an integer from 65536 to 268435456, got ${JSON.stringify(config.maxSessionBytes)}`)
  }
  return Object.freeze({ capture: config.capture, textLimit: config.textLimit, maxSessionBytes: config.maxSessionBytes })
}

/**
 * A session id is used as a file name, so only a conservative character set is
 * accepted: an id this plugin cannot name safely is a session it does not capture.
 * @param {unknown} value - the candidate id.
 * @returns {string|undefined} the id, or undefined when it cannot be a file name.
 */
export function safeSessionId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ? value : undefined
}

/** Whether `child` is `parent` or lies below it, on resolved paths. */
function within(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Resolve the three panel paths for one session, or refuse.
 * @returns {{dir: string, data: string, wal: string, html: string, sessionId: string}|undefined} the paths.
 */
export function panelPaths(cwd: unknown, sessionId: unknown, options: { env?: NodeJS.ProcessEnv } = {}): PanelPaths | undefined {
  const id = safeSessionId(sessionId)
  if (typeof cwd !== 'string' || cwd === '' || !path.isAbsolute(cwd) || id === undefined) return undefined
  const root = path.resolve(cwd)
  // The capture directory belongs to the workspace, never to the harness home
  // (§五 "不写 ~/.dsh"), even when a session happens to run inside it.
  if (within(root, dshHome(options.env))) return undefined
  const dir = path.join(root, PANEL_DIR)
  return Object.freeze({
    dir, data: path.join(dir, `${id}.json`), wal: path.join(dir, `${id}.ndjson`),
    html: path.join(dir, PANEL_HTML), sessionId: id,
  })
}
