/**
 * The engine's public surface: one named export per capability, grouped by the module that owns it.
 *
 * This file is a list, not logic. It exists so `import { inprocLocate } from 'dsh-ops/ptc'` resolves
 * without pulling in a module the caller did not name.
 *
 * @module dsh-ops/ptc
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
} from './proc.cjs'

export {
  agentBoxApply,
  agentBoxRestore,
  applyEditsInMemory,
  astGrepRewrite,
  difftasticAudit,
  everythingFind,
  langOf,
  saneLocate,
} from './stages.cjs'

export { resolveTools, runRefactorPipeline } from './pipeline.cjs'

export { enumerate, inprocLocate, inprocRefactor, runInprocCli } from './inproc.cjs'

export { auditAst, sgCrossCheck, spliceExpect } from './astdiff.cjs'

export { opsPtcAddition, opsPtcDiscoveryEntry } from './tools.cjs'

export { default } from './tools.cjs'
