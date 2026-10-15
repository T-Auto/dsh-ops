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
  const fromPackage = path.resolve(packageRoot, 'runtime', `${platform}-${arch}`, workerName(platform))
  const fromSourceTree = path.resolve(packageRoot, 'native', 'target', 'release', workerName(platform))
  const candidates = explicit !== undefined
    ? [{ file: explicit, note: 'explicit selection (config.binaryPath / DSH_OPS_WORKER_BIN) — trusting the named path is the whole point of selecting it' }]
    : [
      { file: fromPackage, note: 'packaged runtime' },
      { file: fromSourceTree, note: 'source-tree build (npm run build:ptc) — a dev artifact, with no receipt to verify against' },
    ]
  // Compare **resolved, case-folded** paths, never raw strings: Windows is
  // case-insensitive, so `…\RUNTIME\…` names the same file as the candidate we
  // derived — a substring/spelling test would let it skip verification entirely.
  const same = (a, b) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
  for (const { file, note } of candidates) {
    if (!path.isAbsolute(file)) throw new Error('Native worker selection must be an absolute path.')
    let stat
    try { stat = fs.statSync(file) } catch { continue }
    if (!stat.isFile()) continue
    // Verify the packaged candidate against its receipt. Two limits, stated so nobody
    // mistakes this for a trust boundary:
    //   · the receipt sits **beside** the payload, so whoever replaces both passes.
    //     This catches a build/metadata mismatch (a stale or mistaken runtime), not a
    //     deliberate substitution — that needs npm's integrity or a signature, which is
    //     outside this plugin.
    //   · the selection test is "is this the candidate we derived", not a substring of a
    //     path: `includes('\runtime\')` let any absolute path opt itself in (or out).
    if (same(path.resolve(file), fromPackage)) {
      const receipt = JSON.parse(fs.readFileSync(path.join(path.dirname(file),'provenance.json'),'utf8'))
      const version = JSON.parse(fs.readFileSync(path.join(packageRoot,'package.json'),'utf8')).version
      if (receipt.target !== `${platform}-${arch}` || receipt.version !== version || receipt.executable !== workerName(platform)
        || receipt.sha256 !== createHash('sha256').update(fs.readFileSync(file)).digest('hex')) throw new Error('Native worker provenance mismatch.')
    } else {
      // Not silent: an unverified worker binary is a fact the operator should see.
      console.warn(`dsh-ops: native worker selected without provenance verification — ${note}: ${file}`)
    }
    return file
  }
  throw new Error(`Native worker unavailable for ${platform}-${arch}. Install a runtime-bearing dsh-ops package, or run npm run build:ptc in the source checkout. No ACL repair, shell fallback or automatic download is performed.`)
}
