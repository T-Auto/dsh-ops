/** Bounded subprocesses for the opt-in review CLI; never used by core tool registration. */
import { execFile } from 'node:child_process'

export interface CommandResult { code: number | null; stdout: string; stderr: string }
export interface CommandOptions { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal }
export type Runner = (file: string, args: string[], options?: CommandOptions) => Promise<CommandResult>

export const runCommand: Runner = (file, args, options = {}) => new Promise(resolve => {
  execFile(file, args, { ...options, encoding: 'utf8', timeout: 20_000, maxBuffer: 512 * 1024, windowsHide: true },
    (error, stdout, stderr) => resolve({
      code: error ? typeof error.code === 'number' ? error.code : null : 0,
      stdout: String(stdout), stderr: String(stderr || error?.message || '').slice(0, 1000),
    }))
})

/** Drop inherited Git command/config overrides while retaining executable lookup. */
export function isolatedGitEnv(emptyConfig: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: emptyConfig, GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
}
