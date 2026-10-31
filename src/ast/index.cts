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
} from './proc.cjs';
export type { PtcConfig, PtcErrorCode, Stage } from './proc.cjs';

export {
    agentBoxApply,
    agentBoxRestore,
    applyEditsInMemory,
    astGrepRewrite,
    difftasticAudit,
    everythingFind,
    langOf,
    saneLocate,
} from './stages.cjs';
export type { AgentBoxResult, AuditResult, Edit, EverythingQuery, RewriteOpts, SymbolSlice } from './stages.cjs';

export { resolveTools, runRefactorPipeline } from './pipeline.cjs';
export type { PtcOutcome, RefactorRequest } from './pipeline.cjs';

export {
    enumerate,
    inprocLocate,
    inprocRefactor,
    runInprocCli,
} from './inproc.cjs';
export type {
    EnumerateResult,
    InprocOutcome,
    InprocRequest,
    LocateHit,
    LocateInfo,
    LocateOutcome,
    LocateRequest,
    LocateStrategy,
} from './inproc.cjs';

export { auditAst, sgCrossCheck, spliceExpect } from './astdiff.cjs';
export type { AstAudit, AstSpan, SgCrossCheck } from './astdiff.cjs';

export { opsPtcAddition, opsPtcDiscoveryEntry } from './tools.cjs';
export type { PtcToolAddition, PtcToolDef } from './tools.cjs';
export { default } from './tools.cjs';
