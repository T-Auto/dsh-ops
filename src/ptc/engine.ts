/**
 * Typed entry to the PTC engine shipped as `engine/ptc/`.
 *
 * Same rationale as `src/file/parallel-read.ts`: the engine is a shipped CommonJS artifact with
 * declaration files, `scripts/build.mjs` refuses JavaScript under `src/`, and a second TypeScript
 * transcription would drift from the published one. `@ast-grep/napi` is already a declared
 * dependency of this package, so the engine needs nothing beyond `npm install`.
 *
 * Only value exports are listed. The engine's types (`PtcConfig`, `LocateHit`, …) stay reachable
 * through the engine's own declaration file, so nothing here has to mirror them.
 *
 * @module dsh-ops/ptc/engine
 */
export {
  PtcOutcomeError,
  defaultConfig,
  dbg,
  detectEol,
  esCandidates,
  normalizeEol,
  parseLooseJson,
  pickBin,
  readRange,
  run,
  stripBom,
  toLines,
  agentBoxApply,
  agentBoxRestore,
  applyEditsInMemory,
  astGrepRewrite,
  difftasticAudit,
  everythingFind,
  langOf,
  saneLocate,
  resolveTools,
  runRefactorPipeline,
  enumerate,
  inprocLocate,
  inprocRefactor,
  runInprocCli,
  auditAst,
  sgCrossCheck,
  spliceExpect,
  opsPtcAddition,
  opsPtcDiscoveryEntry,
} from '../../engine/ptc/index.js'
