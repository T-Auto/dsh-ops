/** Runtime discovery is installation-relative; explicit selections never silently fall back. */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const PLATFORMS = Object.freeze(['win32-x64'])
export function workerName(platform = process.platform) { return platform === 'win32' ? 'dsh-ops-worker.exe' : 'dsh-ops-worker' }
export function resolveWorker(config = {}, { packageRoot = PACKAGE_ROOT, env = process.env, platform = process.platform, arch = process.arch } = {}) {
  if (!PLATFORMS.includes(`${platform}-${arch}`)) throw new Error(`dsh-ops 0.3.0 supports Windows x64 only; unsupported runtime target ${platform}-${arch}.`)
  const explicit = config.binaryPath ?? env.DSH_OPS_WORKER_BIN
  const candidates = explicit !== undefined ? [explicit] : [
    path.join(packageRoot, 'runtime', `${platform}-${arch}`, workerName(platform)),
    path.join(packageRoot, 'native', 'target', 'release', workerName(platform)),
  ]
  for (const file of candidates) {
    if (!path.isAbsolute(file)) throw new Error('Native worker selection must be an absolute path.')
    let stat
    try { stat = fs.statSync(file) } catch { continue }
    if (!stat.isFile()) continue
    if (file.includes(`${path.sep}runtime${path.sep}`)) {
      let receipt, version
      try {
        receipt = JSON.parse(fs.readFileSync(path.join(path.dirname(file),'provenance.json'),'utf8'))
        version = JSON.parse(fs.readFileSync(path.join(packageRoot,'package.json'),'utf8')).version
      } catch (error) {
        // A missing or unreadable receipt is a provenance failure, not a raw
        // filesystem error: report it like a mismatch, and keep the machine's
        // own paths out of the message.
        throw new Error(`Native worker provenance is unavailable or unreadable (${error?.code ?? error?.name}).`)
      }
      if (receipt?.target !== `${platform}-${arch}` || receipt?.version !== version || receipt?.executable !== workerName(platform)
        || receipt?.sha256 !== createHash('sha256').update(fs.readFileSync(file)).digest('hex')) throw new Error('Native worker provenance mismatch.')
    }
    return file
  }
  throw new Error(`Native worker unavailable for ${platform}-${arch}. Install a runtime-bearing dsh-ops package, or run npm run build:ptc in the source checkout. No ACL repair, shell fallback or automatic download is performed.`)
}
