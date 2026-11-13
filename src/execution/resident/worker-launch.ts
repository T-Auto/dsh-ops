/** Exact public confinement launch facts; never exposed as tool arguments. */
import path from 'node:path'
import { LAUNCH_BYTES } from './frames.js'
import { loadScrubbedParentEnv } from '../../adapter/dsh/host.js'
import { adaptElectronRunner } from '../../shells/environment.js'

export interface ConfinedWorkerLaunch {
  argv: string[]
  cwd: string
  env: Record<string, string>
}
export async function confinedWorkerLaunch(argv: string[], cwd: string): Promise<ConfinedWorkerLaunch> {
  const launch = { argv: [...argv], cwd,
    env: adaptElectronRunner(argv, await loadScrubbedParentEnv()) as Record<string, string> }
  validateWorkerLaunch(launch)
  return launch
}
export function validateWorkerLaunch(launch: ConfinedWorkerLaunch): void {
  const text = (value: unknown): value is string => typeof value === 'string' && !value.includes('\0')
  if (!launch || !Array.isArray(launch.argv) || !launch.argv.length || !launch.argv.every(text)
    || !path.isAbsolute(launch.argv[0]!) || !text(launch.cwd) || !path.isAbsolute(launch.cwd)
    || !launch.env || typeof launch.env !== 'object' || Array.isArray(launch.env)
    || Object.entries(launch.env).some(([key, value]) => !key || !text(key) || key.includes('=') || !text(value))
    || Buffer.byteLength(JSON.stringify(launch)) > LAUNCH_BYTES) throw new Error('Invalid or oversized confined worker launch')
}
