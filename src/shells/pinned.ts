/** Build/test input only: find the pinned Bash payload and verify its digest. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { PACKAGE_ROOT } from '../paths.js'
import { shellUpstreamPin } from './pins.js'
import { provisionedShell } from './paths.js'

interface PinnedBashOptions { file?: string; env?: NodeJS.ProcessEnv; bundleRoot?: string; required?: boolean }
export function pinnedBashExecutable(options: PinnedBashOptions & { required: false }): string | undefined
export function pinnedBashExecutable(options?: PinnedBashOptions): string
export function pinnedBashExecutable({ file, env = process.env, bundleRoot = PACKAGE_ROOT, required = true }: PinnedBashOptions = {}): string | undefined {
  let candidate = file ?? provisionedShell({ kind: 'bash', env, platform: 'win32', arch: 'x64' })?.file
  if (!candidate) {
    // The restored optional package is the normal source; a provisioned store copy is preferred above.
    try { candidate = path.join(path.dirname(createRequire(path.join(bundleRoot, 'package.json')).resolve('@dsh-ops/bash-win32-x64/package.json')), 'bin/bash.exe') } catch {}
  }
  if (!candidate) {
    if (!required) return undefined
    throw new Error('Pinned Bash is unavailable. For legacy MSYS tests, supply the committed SHELL_UPSTREAM_PINS Bash pin using dsh-ops provision-shells --bash --pin <file>, or set DSH_OPS_TEST_BASH to a previously verified pinned bin/bash.exe for offline validation.')
  }
  if (!path.isAbsolute(candidate)) throw new Error('Pinned Bash input must be an absolute executable path')
  const pin = shellUpstreamPin({ kind: 'bash', platform: 'win32', arch: 'x64' })
  if (!pin || !('executableSha256' in pin) || typeof pin.executableSha256 !== 'string') throw new Error('The Windows x64 Bash pin has no executable digest')
  const hash = createHash('sha256').update(fs.readFileSync(candidate)).digest('hex')
  if (hash !== pin.executableSha256) throw new Error('Bash input does not match the pinned executable SHA-256; install the pinned managed runtime')
  const dll = path.resolve(path.dirname(candidate), '../usr/bin/msys-2.0.dll')
  if (!fs.statSync(dll).isFile()) throw new Error('Pinned Bash input is missing its MSYS runtime')
  return candidate
}
