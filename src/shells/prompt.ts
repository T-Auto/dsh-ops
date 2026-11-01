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
