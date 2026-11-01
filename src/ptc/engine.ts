/**
 * Typed door to the PTC engine, ported from the shipped 2.1.1 artifact into `src/ptc/*.cts`.
 *
 * The shipped declaration files are kept next to the port (`*.d.cts`) and remain the typed surface for
 * external consumers. The ported `.cts` implementations are runtime-identical to 2.1.1 and are not yet
 * re-typed, so this facade surfaces them as `any`: the migration is structural first, typed second.
 * `docs/CHANGELOG.md` records the gap under Unreleased.
 *
 * @module dsh-ops/ptc/engine
 */
import { createRequire } from 'node:module'

// This module is ESM (the package is `"type": "module"`), the engine is CommonJS: `createRequire`
// is the one bridge that keeps `lib/ptc/engine.js` loadable from both surfaces.
const engine: Record<string, any> = createRequire(import.meta.url)('./index.cjs') as Record<string, any>

export const PtcOutcomeError = engine.PtcOutcomeError
export const defaultConfig = engine.defaultConfig
export const dbg = engine.dbg
export const detectEol = engine.detectEol
export const esCandidates = engine.esCandidates
export const normalizeEol = engine.normalizeEol
export const parseLooseJson = engine.parseLooseJson
export const pickBin = engine.pickBin
export const readRange = engine.readRange
export const run = engine.run
export const stripBom = engine.stripBom
export const toLines = engine.toLines
export const agentBoxApply = engine.agentBoxApply
export const agentBoxRestore = engine.agentBoxRestore
export const applyEditsInMemory = engine.applyEditsInMemory
export const astGrepRewrite = engine.astGrepRewrite
export const difftasticAudit = engine.difftasticAudit
export const everythingFind = engine.everythingFind
export const langOf = engine.langOf
export const saneLocate = engine.saneLocate
export const resolveTools = engine.resolveTools
export const runRefactorPipeline = engine.runRefactorPipeline
export const enumerate = engine.enumerate
export const inprocLocate = engine.inprocLocate
export const inprocRefactor = engine.inprocRefactor
export const runInprocCli = engine.runInprocCli
export const auditAst = engine.auditAst
export const sgCrossCheck = engine.sgCrossCheck
export const spliceExpect = engine.spliceExpect
export const opsPtcAddition = engine.opsPtcAddition
export const opsPtcDiscoveryEntry = engine.opsPtcDiscoveryEntry
