/**
 * One error shape for the whole Symbol Map engine.
 *
 * The engine is reachable from two very different callers: the native file tool (which must turn
 * every failure into a fenced receipt) and the PTC path (which must never leak a stack trace into
 * canonical data). A bare `Error` with a `code` property satisfies neither — `instanceof` is
 * unreliable across the two module graphs and the code is untyped. This class keeps the code
 * typed, keeps the details structured, and keeps the message human-readable.
 *
 * @module dsh-ops/symbol-map/errors
 */

/** Machine-readable failure codes. Every one of these is a *refusal*, never a partial success. */
export type SymbolMapErrorCode =
  /** The caller asked for something the engine cannot express (bad scope, bad offset, ...). */
  | 'E_ARGS'
  /** The path does not exist. */
  | 'E_NOT_FOUND'
  /** The path exists but is a directory, socket, device, ... — not a regular file. */
  | 'E_NOT_FILE'
  /** The OS refused read access. */
  | 'E_ACCESS'
  /** Any other read failure. */
  | 'E_READ'
  /** The file is larger than `maxBytes`; we refuse rather than parse a huge buffer. */
  | 'E_FILE_TOO_LARGE'
  /** No grammar is known for this extension and the caller supplied no `lang`. */
  | 'E_LANG_UNKNOWN'
  /** The caller asked for a language this build cannot load. */
  | 'E_LANG_UNSUPPORTED'
  /** `tree-sitter` or one of the grammar packages is not installed next to this package. */
  | 'E_ENGINE_UNAVAILABLE'
  /** A snapshot document does not match the documented shape. */
  | 'E_SNAPSHOT'
  /** The engine needs a file argument and did not get one. */
  | 'E_NO_FILE'

/** A refusal with a stable code and optional structured details. */
export class SymbolMapError extends Error {
  readonly code: SymbolMapErrorCode
  readonly details: Readonly<Record<string, unknown>> | undefined

  constructor(code: SymbolMapErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'SymbolMapError'
    this.code = code
    this.details = details === undefined ? undefined : Object.freeze({ ...details })
  }
}

/** Throw a {@link SymbolMapError}. Declared `never` so call sites stay expression-shaped. */
export function fail(code: SymbolMapErrorCode, message: string, details?: Record<string, unknown>): never {
  throw new SymbolMapError(code, message, details)
}

/**
 * Narrow an unknown catch value into `{ code, message }` without pretending to know more.
 *
 * Anything that is not a `SymbolMapError` becomes `E_READ`: it came from the OS or from a grammar,
 * and inventing a finer code would be a guess. The original message is preserved verbatim.
 */
export function describe(error: unknown, fallback: SymbolMapErrorCode = 'E_READ'): { code: SymbolMapErrorCode, message: string } {
  if (error instanceof SymbolMapError) return { code: error.code, message: error.message }
  if (error instanceof Error) return { code: fallback, message: error.message }
  return { code: fallback, message: String(error) }
}
