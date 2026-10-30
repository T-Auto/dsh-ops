/**
 * `dsh-ops/download-guard` row: refuse a shell download that writes to disk and
 * name the operator's faster downloader instead.
 *
 * WHY THIS IS A ROW AND NOT PART OF A MODE
 *
 * It changes what the model is allowed to do, so it must be switchable on its
 * own. Mounting it as a row means disabling it in the profile tears its
 * listener down through the normal fiber lifecycle, with no extra flag to keep
 * in sync.
 *
 * WHY THE LISTENER ALLOWS BY DEFAULT
 *
 * With no `downloadGuard.template` configured this row registers nothing at
 * all. That is deliberate: the plugin ships to installs that never asked for a
 * download policy, and silently refusing their `curl -o` would be a regression
 * they did not choose. The whole decision lives in `./policy.ts`, which returns
 * `allow` until the operator names a downloader.
 *
 * @module dsh-ops/components/download-guard
 */
import type { Context } from '../../adapter/dsh/types.js'
import { resolveConfig } from '../../config.js'
import { inspectCommand } from '../../download-guard/detect.js'
import { decideDownload } from '../../download-guard/policy.js'

export const name = 'dsh-ops-download-guard'

/** Shell tools whose `command` argument is worth inspecting. */
const SHELL_TOOLS = new Set(['ops_bash', 'bash', 'pwsh', 'pwsh_persistent', 'shell'])

/**
 * Mount the row.
 *
 * @param ctx - the row's cordis context.
 * @param rawConfig - the row's config, validated by `resolveConfig`.
 */
export function apply(ctx: Context, rawConfig?: unknown): void {
  const config = resolveConfig(rawConfig)
  const guard = config.downloadGuard

  // Nothing configured: register nothing at all, so an install that never opted
  // in pays no listener and no per-call work.
  if (guard.template.trim() === '') return

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const toolName = typeof exec?.name === 'string' ? exec.name : ''
      if (!SHELL_TOOLS.has(toolName)) return next()
      const args = exec?.arguments as { command?: unknown, script_path?: unknown } | undefined
      if (args === null || typeof args !== 'object') return next()
      // `script_path` runs a file whose contents are not in this call, so there
      // is nothing to inspect. Guessing at the file would be a false positive.
      if (typeof args.script_path === 'string' && args.script_path !== '') return next()
      const command = args.command
      const hit = inspectCommand(command)
      const decision = decideDownload(hit, guard, typeof command === 'string' ? command : '')
      if (decision.kind === 'allow') return next()
      return { kind: 'deny', reason: decision.reason, info: decision.info }
    } catch {
      // A detector bug must never block an unrelated command.
      return next()
    }
  })
}
