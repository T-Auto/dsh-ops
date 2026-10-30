/**
 * 宿主 `src/worker-boundary.ts` 的契约副本（最小集）。
 *
 * 这是宿主契约在本包内的最小副本，符号与宿主同名同义；合并回宿主时应优先用宿主原实现
 * 并删除本文件。宿主那份 13 行，这里只取本包用到的两个符号：`record()` 类型守卫与
 * `WorkerInvokeConfig` 类型；`errorText()` 本包没有调用点，故意不复制。
 *
 * @module dsh-ops/host/worker-boundary
 */

/** 一次 worker 派发的宿主配置。本包只读 `denyCredentialReads`。 */
export interface WorkerInvokeConfig {
  binaryPath?: string
  required?: boolean
  denyCredentialReads?: boolean
  toolCallTimeoutMs?: number
}

/** 把不可信的参数/错误值收窄成普通对象；数组与 `null` 都不算。 */
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
