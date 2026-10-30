/**
 * 宿主 `src/permissions.ts` 的契约副本（最小集）。
 *
 * 这是宿主契约在本包内的最小副本，符号与宿主同名同义；合并回宿主时应优先用宿主原实现
 * 并删除本文件。宿主那份 55 行，多数是 `permissionError` / `denied` / `normalizeNativeDenial`
 * 这类给「有多个文件工具、需要把原生拒绝理由翻译成回执」的场景用的；本包只有一个只读工具，
 * 只用到两个符号：
 *
 *   - `MODES` —— 权威策略的模式白名单，用于拒绝宿主返回的未知 mode；
 *   - `credentialDenied()` —— 凭据围栏拒绝时的回执，形状与宿主逐字段一致（`status: 'rejected'`
 *     + `phase: 'preflight'` + `effectState: 'none'`），因为 `symbol_map` 的调用方按同一份
 *     回执契约解析，改一个字段就是改了跨工具的协议。
 *
 * @module dsh-ops/host/permissions
 */

import type { SandboxMode } from '../adapter/dsh/types.js'

/** 宿主权限选择器的全部取值。模型输入永远不能选中其中任何一个。 */
export const MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']

/** 凭据围栏拒绝。改 DSH 权限选择器不会解除这道围栏，所以 `nextAction` 明确写着不要重试。 */
export function credentialDenied(message: string) {
  return {
    status: 'rejected' as const,
    error: {
      code: 'CREDENTIAL_DENIED' as const,
      phase: 'preflight' as const,
      retryable: false as const,
      effectState: 'none' as const,
      message,
      nextAction: 'Choose a non-credential path. Do not retry or bypass the credential fence; changing the DSH permission selector does not remove it.',
    },
  }
}
