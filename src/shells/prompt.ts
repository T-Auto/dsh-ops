/** Bash operation semantics, independent of the host's PowerShell tool and prompt slot. */
import { BASH_TOOL } from '../policy.js'

export const BASH_PROMPT_SECTION = 'dsh-ops:tool-bash'

/** Describe the executor honestly without changing the host's OS identity. */
export function bashOperationDescription(platform: string = process.platform): string {
  return 'Execute a Bash command in a fresh non-login shell. Use Bash syntax for quoting, $VAR, '
    + '$(command), globs, redirects and pipelines; shell state does not persist between calls. '
    + (platform === 'win32'
      ? 'On Windows this is a local MSYS Bash environment, not Linux, WSL or PowerShell. '
      : 'This uses the local host Bash, not a remote shell. ')
}

/** Cross-call guidance belongs only to a scope that can actually call OPS Bash. */
export function renderBashGuidance(background: boolean, platform: string = process.platform): string {
  return [
    `# ${BASH_TOOL}: Bash command execution`,
    bashOperationDescription(platform),
    'Use command for short commands and pipelines. For complex scripts, write an existing Bash script file and pass script_path instead; provide exactly one of command or script_path. PowerShell scripts belong to the host pwsh tool when available.',
    'workdir defaults to the current session workspace; relative paths use that workspace, never the plugin process cwd.',
    ...(platform === 'win32' ? ['On Windows, workdir accepts D:/repo or /d/repo; drive-less /tmp or / is not a Windows workdir. Within command, use MSYS paths such as /d/repo, quote paths with spaces, and use Bash rather than PowerShell path/variable syntax.'] : []),
    'The host session sandbox remains authoritative. A denial is not permission to switch shells or bypass confinement. Request wider access only through the declared approval fields after a real denial; rejected approval must not be bypassed.',
    'description is required. Inspect kind before reading the result: foreground includes status, exitCode, stdout/stderr and optional failure.code/effectState/retry. A missing exitCode or failed status is not success; inspect unknown effects before repeating. Output is bounded; truncation and spill paths describe retained output, not completeness.',
    background
      ? 'With host jobs, run_in_background returns kind background with jobId; a foreground timeout may return kind promoted with jobId. Collect through job_output and stop through job_kill. Promotion is not command completion.'
      : 'Host jobs are unavailable: run_in_background is not accepted, and the foreground timeout stops the command.',
  ].join('\n\n')
}

/**
 * Explain a Bash slot whose executor never resolved, instead of rendering nothing.
 *
 * Resolution failures and execution failures are separate layers, and conflating them would
 * invent a second vocabulary for one condition: `resolveShells` reports the former as `source`
 * plus a `detail` that already ends with the deployment remedy, while `bash-runtime-failure`
 * classifies the latter once a call is actually attempted. A mount-time notice can only speak
 * about resolution, so it quotes that layer verbatim and claims nothing about retryability.
 * @param source - the resolution rung that failed (`missing`, `disabled`, `config`, `host`, ...).
 * @param detail - the resolution explanation, which already carries the remedy.
 * @returns the model-facing section text.
 */
export function renderBashUnavailable(source: string, detail: string): string {
  return [
    `# ${BASH_TOOL}: unavailable in this session`,
    `The Bash executor did not resolve for this deployment (resolution source: ${source}), so no ${BASH_TOOL} tool is published here. Only the command surfaces the host itself publishes remain. Resolution reported: ${detail}`,
    'Do not write Bash syntax into another shell, and do not read a PowerShell invocation as a Bash one. Reading, searching and editing files belong to the OPS file tools rather than to any shell.',
    'A sandbox or approval denial is not permission to switch shells. Restoring the executor is a deployment action: apply the remedy above and restart DSH; this notice disappears only when the executor resolves.',
  ].join('\n\n')
}
