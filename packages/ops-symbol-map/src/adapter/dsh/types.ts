/**
 * 宿主 `src/adapter/dsh/types.ts` 的类型契约在本包内的最小副本。
 *
 * 宿主那份文件是 DSH 产品 API 的唯一类型边界，全部是 `export type { ... } from '@deepseek-ai/...'`
 * 的重导出；本包离开宿主后拿不到那些包，所以这里只按**本包实际读到的字段**重新声明形状：
 * 符号与宿主同名同义，字段是宿主类型的结构子集，多一个字段都没有。
 *
 * 合并回宿主时：优先用宿主原实现并删除本文件 —— 宿主类型比这里宽，本包代码只窄不宽，
 * 换回宿主版本不会产生类型错误。路径 `src/adapter/dsh/types.ts` 不能挪，`src/authority-paths.ts`
 * 与本文件都按这个相对位置 import。
 *
 * @module dsh-ops/adapter/dsh/types
 */

/** 与宿主 `dsh-sandbox` 的 `SandboxMode` 同一词汇表。 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** 一次策略解析的结果。本包只读 `mode` 与 `workspaceRoot` 两个字段。 */
export interface SandboxExecutionPolicy {
  mode: SandboxMode
  workspaceRoot: string
}

/** 会话身份的窄形状：`id` 用于拒绝无名会话，`header.cwd` 是回执里相对路径的基准。 */
export interface SessionIdentity {
  id?: string
  header?: { cwd?: string }
}

/** `ToolRunContext` 在本包内只被当作 `exec.agent.session` 的载体。 */
export interface ToolRunContext {
  agent?: { session?: SessionIdentity }
}

/** 宿主策略服务的窄形状：同步解析，`session` 是唯一输入。 */
export interface SandboxPolicyService {
  resolve(input: { session: SessionIdentity }): SandboxExecutionPolicy
}

/**
 * Cordis `Context` 的窄形状。
 *
 * 只声明本包真正会调用的那一次 `get`：`sandboxPolicy` 是唯一被取用的宿主服务，
 * 且返回 `undefined` 是「宿主没装策略服务」的正常分支，不是异常。
 */
export interface Context {
  get(name: 'sandboxPolicy'): SandboxPolicyService | undefined
}
