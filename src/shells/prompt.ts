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
export function renderBashGuidance(background: boolean, platform: string = process.platform, session = false): string {
  return [
    `# ${BASH_TOOL}: Bash command execution`,
    'Provide exactly one of command or script_path. For scripts longer than about 1 KB or containing heredocs, quotes, backslashes or non-ASCII text, write a script file first and pass script_path.',
    ...(platform === 'win32' ? ['On Windows, workdir accepts D:/repo or /d/repo; drive-less /tmp or / is not a Windows workdir. Within command, use MSYS paths such as /d/repo, quote paths with spaces, and use Bash rather than PowerShell path/variable syntax.'] : []),
    'The host session sandbox remains authoritative; a denial or rejected approval must not be bypassed by switching shells.',
    'A missing exitCode or failed status is not success. Truncation and spill paths describe retained output, not completeness.',
    ...(session ? ['execution defaults to fresh. Choose session explicitly to retain cwd, exports, functions and options in this Agent; omitted workdir preserves cwd, explicit workdir changes it. Session accepts command only and stdin is EOF on each call. It rechecks authority at the native queue head. Check shellState and stateLost: a reset or authority/runtime change discards prior state. Session timeout stops the shell, never promotes it. Inline output retains a bounded prefix; use an available spillPath to recover the complete stream. For script_path or independent background jobs choose fresh; background jobs do not clone session state.'] : []),
    background
      ? 'Promotion is not command completion; collect through job_output and stop through job_kill.'
      : 'Host jobs are unavailable; the foreground timeout stops the command.',
  ].join('\n\n')
}

/**
 * Explain a Bash slot whose executor never resolved, instead of rendering nothing.
 * Quotes the resolution `source` and `detail` verbatim; `detail` already ends with the remedy.
 * Kept short on purpose: this text rides on every request of the session.
 * @param source - the resolution rung that failed (`missing`, `disabled`, `config`, `host`, ...).
 * @param detail - the resolution explanation, which already carries the remedy.
 * @returns the model-facing section text.
 */
export function renderBashUnavailable(source: string, detail: string): string {
  return [
    `# ${BASH_TOOL}: unavailable in this session`,
    `The Bash executor did not resolve (resolution source: ${source}): ${detail} Use the OPS file tools for file work and do not run Bash syntax in another shell.`,
  ].join('\n\n')
}
