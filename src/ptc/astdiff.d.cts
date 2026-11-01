/**
 * 进程内 AST 审计 —— difftastic 的零 fork 替代品
 *
 * difftastic 要起一个 36ms 的子进程、把两份文件写到 tmp、再读回 JSON。
 * 但它真正要回答的问题只有三个，全都能在已经 parse 过的两棵树上就地算出来：
 *
 *   ① 改后的文件语法还完整吗？          → after 树里的 ERROR 节点数
 *   ② 改动的范围是不是只有我提交的那几处？→ 区间外逐字节比对 + 区间内节点计数
 *   ③ 结构有没有被大改？                → 区间内 kind 集合的前后差异
 *
 * 成本：两次 parse（~0.4ms/千行）+ O(n) 遍历，比 difftastic 快两个数量级，
 * 且不需要任何外部二进制。`ops_ptc_audit` 仍然保留 difftastic 作为独立复核。
 */
import { parse, type SgNode } from '@ast-grep/napi';
export interface AstSpan {
    /**
     * 注意：与 `@ast-grep/napi` 的 `range().index` 同域 —— **UTF-16 字符索引，不是字节偏移**。
     * napi 的 `node.replace()` / `commitEdits()` 也在这个域里工作，混用字节偏移会在
     * 中文/emoji 源码上错位（实测：`export function demo(){\r\n return 说明; }` 字节 59 vs 字符 49）。
     */
    startByte: number;
    endByte: number;
}
export interface AstAudit {
    ok: boolean;
    /** 真实产生了结构变化的编辑区间数 */
    hunks: number;
    /** 区间内被替换掉的命名节点数 */
    nodesRemoved: number;
    /** 区间内新产生的命名节点数 */
    nodesAdded: number;
    /** after 树里的 ERROR 节点数；是否新增诊断由 ok 表示 */
    errorNodes: number;
    /** before 树里的 ERROR 节点数，>0 说明原文件本来就不完整 */
    errorNodesBefore: number;
    /** 谁判的语法完整性：tsc=TypeScript 编译器解析诊断，tree-sitter=仅 ERROR 节点 */
    parser: 'tsc' | 'tree-sitter';
    /** 语法诊断条数（parser=tsc 时来自 parseDiagnostics，tree-sitter 时同 errorNodes） */
    diagAfter: number;
    diagBefore: number;
    /** 区间外字节占比，越低说明改动面越大 */
    unchangedRatio: number;
    /** 区间内出现过的顶层 kind，用于摘要（最多 6 个） */
    kinds: string[];
    bytesBefore: number;
    bytesAfter: number;
    ms: number;
    code?: string;
    message?: string;
}
export declare function parseAuditRoot(lang: Parameters<typeof parse>[0], text: string): SgNode;
/** 把编辑还原成 after，用于证明「除了我提交的这几处，没有任何字符被动过」 */
export declare function spliceExpect(before: string, edits: Array<AstSpan & {
    text: string;
}>): string;
/**
 * @param lang  已解析出 AST 时用的语言（与调用方 parse 时相同）
 * @param edits 本轮提交的编辑，用于区间外比对
 */
/** Pipeline preflight needs syntax and exact-splice proof, not unused hunk statistics. */
export declare function auditSyntax(beforeText: string, afterText: string, lang: Parameters<typeof parse>[0], edits: Array<AstSpan & {
    text: string;
}>): Pick<AstAudit, 'ok' | 'code' | 'message'>;
export declare function auditAst(beforeText: string, afterText: string, lang: Parameters<typeof parse>[0], edits: Array<AstSpan & {
    text: string;
}>, 
/** Same-language whole-source root from this call's immutable snapshot. */
beforeRoot?: SgNode): AstAudit;
export interface SgCrossCheck {
    /** 两引擎命中数是否一致 */
    agree: boolean;
    napiCount: number;
    sgCount: number;
    /** 失败的命中区间（sg 独有 / napi 独有），一致时为空 */
    diff: string[];
    ms: number;
    stderr?: string;
}
/**
 * 用 `sg` CLI 独立跑同一个 pattern，和 napi 的命中数对账。
 *
 * 用途不是提速，是证伪：napi 与 CLI 走同一份 Rust 核心但不同调用路径
 * （addon vs 二进制、rule 解析 vs 命令行参数），两者一致才说明
 * 「我改的确实是这个 pattern 的结果」，而不是 addon 版本的行为偏差。
 */
export declare function sgCrossCheck(file: string, pattern: string, lang: string, napiCount: number, sgPath?: string, timeoutMs?: number): SgCrossCheck;
