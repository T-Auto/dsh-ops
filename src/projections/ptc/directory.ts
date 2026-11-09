/** The loader schema owns the allowed names and next-step selection contract. */
import { publicToolName } from '../../policy.js'
import type { ApiName } from '../../ptc/config.js'

export function renderSdkDirectory(allowed: readonly ApiName[], callable: ReadonlySet<string>): string {
  return allowed.some(raw => !callable.has(publicToolName(raw)))
    ? `For on-demand APIs, use tools.${publicToolName('load_sdk')}; its description lists the configured raw names.` : ''
}
