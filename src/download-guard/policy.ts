/**
 * Turn a detection result into a decision, using operator configuration.
 *
 * WHY THE FORWARDER IS CONFIGURATION, NOT CODE
 *
 * A guard that hardcodes one downloader is only useful on the machine it was
 * written for. The plugin therefore never names a downloader: the operator
 * supplies a command template, and every part of the refusal text is derived
 * from it. With no template configured the guard stays out of the way
 * entirely — a default that refuses work the operator never asked to change
 * would be worse than the slow download it prevents.
 *
 * @module dsh-ops/download-guard/policy
 */
import type { DownloadHit } from './detect.js'

/**
 * One configured forwarder.
 *
 * `template` is the whole command, with `{url}` and `{file}` replaced by the
 * detected values. A template is used verbatim otherwise, so it can carry any
 * flags the operator's downloader needs.
 */
export interface ForwarderConfig {
  /** The command to suggest, containing `{url}` and optionally `{file}`. */
  template: string
}

/** What the guard decided for one call. */
export type DownloadDecision =
  | { kind: 'allow' }
  | { kind: 'deny', reason: string, info: { name: string, code: string } }

/** Quote one path for a POSIX shell only when it would otherwise split. */
function shellQuote(value: string): string {
  if (value === '') return "''"
  if (/^[A-Za-z0-9_\-./:=@%+,]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Render the forwarder command for one hit.
 *
 * `{url}` is required because a template without it cannot identify what to
 * download. `{file}` is optional: a downloader that derives the name from the
 * URL does not need it. When the hit has no visible target but the template
 * asks for one, the placeholder is left intact rather than replaced with a
 * guess, so the operator can see why it was not filled.
 *
 * @param template - the configured command template.
 * @param hit - the detection result.
 * @returns the command to show the model.
 */
export function renderForwarder(template: string, hit: DownloadHit): string {
  let rendered = template
  if (hit.url !== undefined) rendered = rendered.split('{url}').join(shellQuote(hit.url))
  if (hit.target !== undefined) rendered = rendered.split('{file}').join(shellQuote(hit.target))
  return rendered
}

/**
 * Build the refusal text.
 *
 * The shape follows the host's own refusals: what was refused, why it matters,
 * and the exact command that does it better. A refusal that does not name a
 * working alternative just moves the problem to the model.
 *
 * @param hit - the detection result.
 * @param template - the configured forwarder template.
 * @param command - the original command, for context.
 * @returns the refusal reason.
 */
export function refusalReason(hit: DownloadHit, template: string, command: string): string {
  const shown = command.length > 240 ? `${command.slice(0, 240)}...` : command
  const lines = [
    `This command downloads to disk through ${hit.rule}, which writes one connection at a time.`,
    hit.target === undefined
      ? 'The bytes land in a local file either way, so a downloader built for the job is strictly faster.'
      : `The bytes go to ${hit.target} either way, so a downloader built for the job is strictly faster.`,
    '',
    'Use the configured downloader instead:',
    `  ${renderForwarder(template, hit)}`,
  ]
  if (hit.url !== undefined) lines.push('', `URL: ${hit.url}`)
  lines.push(
    '',
    'If that downloader is not what you want here, say so instead of retrying this command:',
    'the guard refuses rather than silently rewriting your command.',
    '',
    `Blocked command: ${shown}`,
  )
  return lines.join('\n')
}

/**
 * Decide what to do with one inspected call.
 *
 * @param hit - the detection result, when the command looks like a download.
 * @param config - the operator's forwarder configuration, when configured.
 * @param command - the original command text.
 * @returns the decision.
 */
export function decideDownload(
  hit: DownloadHit | undefined,
  config: ForwarderConfig | undefined,
  command: string,
): DownloadDecision {
  // No detection: nothing to say.
  if (hit === undefined) return { kind: 'allow' }
  // No configured forwarder: the operator has not opted in, so the command runs
  // exactly as it always did. This is the difference between a plugin that
  // improves a workflow and one that breaks an unconfigured install.
  if (config === undefined || config.template.trim() === '') return { kind: 'allow' }
  // A template that cannot name the URL cannot produce a runnable alternative.
  if (!config.template.includes('{url}') || hit.url === undefined) return { kind: 'allow' }
  return {
    kind: 'deny',
    reason: refusalReason(hit, config.template, command),
    info: { name: 'DownloadGuardError', code: 'DOWNLOAD_TO_FILE' },
  }
}
