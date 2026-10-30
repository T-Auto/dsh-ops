/**
 * Public surface of the Symbol Map engine.
 *
 * The engine is split into eight modules because each one has a different reason to change and
 * because a single file would blow the repository's 1000-line gate. That split is an
 * implementation detail: everything outside `src/symbol-map/` imports from here, so a module can
 * be moved or merged without touching the fence, the tool layer, or the tests.
 *
 * Two groups are exported. The first is the engine proper — the fifteen names the `symbol_map`
 * tool publishes as its public surface. The second is what the `symbol_map` tool needs in order to
 * turn a request into a map and a failure into a receipt: the error type, the scope parser, the
 * size and page defaults, and the install hint for the missing-grammar case. Nothing here reads
 * the filesystem on import, and nothing here loads a grammar until the first parse, so importing
 * this module is free even on a machine with no C++ toolchain.
 *
 * @module dsh-ops/symbol-map
 */

/* ------------------------------------------------------------------ engine */

export { SYMBOL_QUERY, SYMBOL_QUERY_EXT, CAPTURE_ROLE, querySource } from './query.js'
export type { CaptureRole } from './query.js'

export { LANG_BY_EXT, INSTALL_HINT, detectLanguage, grammar, parserConstructor, poolStats } from './grammar.js'

export {
  mapSource,
  buildFromBuffer,
  buildSymbolMap,
  extractSymbols,
  recoverSymbols,
  countSyntaxErrors,
  compareSymbols,
} from './engine.js'

export {
  paginate,
  verifySymbolMap,
  parseSnapshot,
  writeSnapshot,
  readSnapshot,
  DEFAULT_LIMIT,
  DEFAULT_BUDGET_BYTES,
  encodeSymbol,
  decodeSymbol,
} from './snapshot.js'
export type { SnapshotCheck } from './snapshot.js'

export { getSymbolMap, mapFiles, cacheKeyOf, resetCaches, stats } from './cache.js'
export type { MapFileResult } from './cache.js'

/* ------------------------------------------------------------- tool support */

export { SymbolMapError, fail, describe } from './errors.js'
export type { SymbolMapErrorCode } from './errors.js'

export { normalizeScope, readFileBuffer, statRegularFile, revisionOf, fileFingerprint, displayPath, DEFAULT_MAX_BYTES, HASH_LEN, REVISION_RE, FAST_HASH_WINDOW } from './files.js'

/* -------------------------------------------------------------------- types */

export type {
  Symbol,
  SymbolType,
  SymbolMap,
  SymbolPage,
  Scope,
  SourceLanguage,
  MapOptions,
  MapFileOptions,
  PageOptions,
  SyntaxNode,
  SyntaxTree,
  SyntaxParser,
  SyntaxQuery,
  SyntaxLanguage,
  SyntaxMatch,
  SyntaxCapture,
  SyntaxQueryOptions,
  SyntaxPoint,
  ParserConstructor,
} from './types.js'
