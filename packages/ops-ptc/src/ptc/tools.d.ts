export interface PtcToolDef {
    name: string;
    title: string;
    /** 一句话，进动态工具列表，不进基础系统提示词 */
    description: string;
    inputSchema: Record<string, unknown>;
}
export interface PtcToolAddition {
    id: string;
    version: string;
    kind: 'tools_addition';
    /** 自定义匹配元数据；需宿主 adapter 显式接线，原 OPS discovery 不消费此结构。 */
    discover: {
        keywords: string[];
        intents: string[];
        minRepoFiles?: number;
        cost: 'light' | 'heavy';
        load: 'on-demand';
    };
    tools: PtcToolDef[];
    handlers: Record<string, (args: any, ctx?: {
        cwd?: string;
    }) => Promise<unknown>>;
}
declare const OUT_SCHEMA: {
    type: string;
    properties: {
        status: {
            type: string;
            enum: string[];
        };
        mode: {
            type: string;
            enum: string[];
        };
        file: {
            type: string;
        };
        symbol: {
            type: string;
        };
        hunks: {
            type: string;
        };
        addedLines: {
            type: string;
        };
        removedLines: {
            type: string;
        };
        summary: {
            type: string;
        };
        stages: {
            type: string;
            items: {
                type: string;
            };
        };
        degraded: {
            type: string;
        };
        rollback: {
            type: string;
        };
        code: {
            type: string;
        };
        stage: {
            type: string;
        };
        message: {
            type: string;
        };
    };
};
export declare const opsPtcAddition: PtcToolAddition;
export declare const opsPtcDiscoveryEntry: {
    id: string;
    summary: string;
    keywords: string[];
    intents: string[];
    /** 自定义宿主可使用的选择条件；原 OPS discovery 不自动调用。 */
    gate: (ctx: {
        repoFileCount?: number;
        userIntent?: string;
    }) => boolean;
    /** 仅返回 addition 元数据，不向原 OPS discovery 自动注册工具。 */
    load: () => PtcToolAddition;
};
export { OUT_SCHEMA };
export { createHostTools, registerHostTools, toHostOutcome, HOST_OUTCOME_SCHEMA } from './adapter';
export type { HostBridge, HostExec, HostPolicy, HostOutcome, HostToolDefinition } from './adapter';
export default opsPtcAddition;
