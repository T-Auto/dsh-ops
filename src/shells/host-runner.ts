/**
 * Refuse a confined argv that would start the host GUI instead of the command.
 *
 * The Windows ACL sandbox provider builds its invocation as
 * `[process.execPath, <runner>, …]`. Under DSH Desktop `process.execPath` is the
 * Electron GUI binary, so spawning that argv unchanged opens a second GUI
 * instance: the host's single-instance lock makes it exit 0 without ever running
 * the command, and an exit-0/no-output result is indistinguishable from success.
 * Nothing else in this plugin adapts that argv, so the refusal lives here rather
 * than reporting a silent success.
 */

/** The host runtime a confined argv may name. */
export interface HostRuntime {
  /** The binary the confined argv may start. */
  execPath: string
  /** Whether that binary is an Electron application rather than a Node runtime. */
  electron: boolean
}

/** The variable Electron reads to behave as a plain Node runtime. */
const NODE_MODE = 'ELECTRON_RUN_AS_NODE'

/**
 * The host runtime as this process sees it.
 * @returns the exec path and whether it is an Electron application.
 */
export function currentHostRuntime(): HostRuntime {
  return { execPath: process.execPath, electron: process.versions.electron !== undefined }
}

/**
 * Whether the child environment already asks Electron to behave as Node.
 * Windows environment names are case-insensitive, so a lower-cased variant counts.
 */
function nodeModeRequested(env: NodeJS.ProcessEnv): boolean {
  return Object.entries(env).some(([key, value]) => key.toUpperCase() === NODE_MODE && value === '1')
}

/**
 * Refuse a confined argv that would start the host GUI instead of the command.
 * @param argv - the argv the confinement provider returned.
 * @param env - the environment the confined child will actually receive.
 * @param host - the host runtime; injected so the guard is testable off-Electron.
 * @returns the failure text, or `undefined` when the argv is safe to spawn.
 */
export function hostRunnerRefusal(argv: readonly string[], env: NodeJS.ProcessEnv = {}, host: HostRuntime = currentHostRuntime()): string | undefined {
  if (!host.electron || argv[0] !== host.execPath || nodeModeRequested(env)) return undefined
  return 'EXECUTOR_UNAVAILABLE: the confined argv starts the host Electron binary without ELECTRON_RUN_AS_NODE, so it would open a second GUI instance that exits 0 without running the command. This is not a user authorization denial and no command executed. Restore a confinement provider that returns a Node-runnable argv, or run the confined child with ELECTRON_RUN_AS_NODE=1; changing the DSH selector is not a repair. Do not retry.'
}
