/** Mount only package-owned descriptors; the host gateway supplies operator admission. */
import path from 'node:path'
import type { Context } from '../adapter/dsh/types.js'
import type {} from '../adapter/dsh/types.js'
import type { SubprocessRuntime } from '../adapter/dsh/types.js'
import { dshHome, PACKAGE_ROOT } from '../paths.js'
import { RuntimeActions } from './runtime-actions.js'
import type { RuntimeProcessRunner } from './runtime-actions.js'
import { RUNTIME_DESCRIPTORS } from './runtime-contract.js'
import type { DefaultPresetResult } from './runtime-contract.js'

declare module '@deepseek-ai/cordis' { interface Context { opsSettings: RuntimeActions } }
export function runtimeProcessRunner(subprocess: Pick<SubprocessRuntime, 'spawn'>, env: NodeJS.ProcessEnv = process.env): RuntimeProcessRunner {
  return async (argv, signal) => {
    let started = false
    try {
      signal.throwIfAborted()
      if (!path.isAbsolute(argv[0] ?? '')) throw new Error('Runtime action requires an absolute executable')
      const child = subprocess.spawn({ argv, cwd: PACKAGE_ROOT, signal, graceMs: 2000,
        stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' }, env: { DSH_HOME: dshHome(env) } })
      started = true
      const result = await child.done
      return { started, exitCode: result.exitCode, signal: result.signal }
    } catch (error) { return { started, exitCode: null, signal: signal.aborted ? 'aborted' : null,
      error: error instanceof Error ? error.message : String(error) } }
  }
}
export function mountRuntimeSettings(root: Context, options: { config?: () => unknown;
  applyDefaultPreset?: () => Promise<DefaultPresetResult> } = {}): void {
  root.inject(['typert', 'subprocess'], ctx => {
    const service = new RuntimeActions({ run: runtimeProcessRunner(ctx.subprocess), ...options })
    ctx.provide('opsSettings', service)
    ctx.typert.register({ package: 'dsh-ops', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: RUNTIME_DESCRIPTORS })
    ctx.effect(() => () => service.dispose(), 'dsh-ops: runtime settings actions')
  })
}
