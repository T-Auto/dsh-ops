/** Narrow untrusted worker and argument values before touching host services. */
export interface WorkerInvokeConfig {
  binaryPath?: string
  required?: boolean
  denyCredentialReads?: boolean
  /** Which reader answers `read_files`; see `src/config.ts`. */
  fileReader?: 'native' | 'inproc'
  toolCallTimeoutMs?: number
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
export function errorText(error: unknown): string {
  return String(record(error) ? error.message ?? error : error)
}
