/** Preserve the public host's Desktop-as-Node runner environment when native owns launch. */
import path from 'node:path'
const ELECTRON_NODE_MODE = 'ELECTRON_RUN_AS_NODE'

export function adaptElectronRunner(argv: string[], env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!globalThis.process.versions.electron || !argv[0]) return env
  const normalize = (file: string) => globalThis.process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)
  if (normalize(argv[0]) !== normalize(globalThis.process.execPath)) return env
  const keyOf = (key: string) => globalThis.process.platform === 'win32' ? key.toUpperCase() : key
  const existing = Object.entries(env).filter(([key]) => keyOf(key) === ELECTRON_NODE_MODE)
  if (existing.length === 1 && existing[0][1] === '1') return env
  const cleaned = Object.fromEntries(Object.entries(env).filter(([key]) => keyOf(key) !== ELECTRON_NODE_MODE))
  return { ...cleaned, [ELECTRON_NODE_MODE]: '1' }
}
