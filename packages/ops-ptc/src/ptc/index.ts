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
} from './proc';
export type { PtcConfig, PtcErrorCode, Stage } from './proc';

export {
    agentBoxApply,
    agentBoxRestore,
    applyEditsInMemory,
    astGrepRewrite,
    difftasticAudit,
    everythingFind,
    langOf,
    saneLocate,
} from './stages';
export type { AgentBoxResult, AuditResult, Edit, EverythingQuery, RewriteOpts, SymbolSlice } from './stages';

export { resolveTools, runRefactorPipeline } from './pipeline';
export type { PtcOutcome, RefactorRequest } from './pipeline';

export {
    enumerate,
    inprocLocate,
    inprocRefactor,
    runInprocCli,
} from './inproc';
export type {
    EnumerateResult,
    InprocOutcome,
    InprocRequest,
    LocateHit,
    LocateInfo,
    LocateOutcome,
    LocateRequest,
    LocateStrategy,
} from './inproc';

export { auditAst, sgCrossCheck, spliceExpect } from './astdiff';
export type { AstAudit, AstSpan, SgCrossCheck } from './astdiff';

export { opsPtcAddition, opsPtcDiscoveryEntry } from './tools';
export type { PtcToolAddition, PtcToolDef } from './tools';
export { default } from './tools';
