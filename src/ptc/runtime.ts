/** Runtime discovery is installation-relative; explicit selections never silently fall back. */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
export interface WorkerSelection { binaryPath?: string }
export interface RuntimeOptions { packageRoot?: string; env?: NodeJS.ProcessEnv; platform?: string; arch?: string }
export type WorkerResolution = { ok: true; file: string } | { ok: false; reason: string }
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const PLATFORMS = Object.freeze(['win32-x64', 'linux-x64', 'darwin-arm64', 'darwin-x64'])
export function workerName(platform: string = process.platform) { return platform === 'win32' ? 'dsh-ops-worker.exe' : 'dsh-ops-worker' }
/**
 * Read a JSON file, or name it.
 *
 * A missing receipt used to surface as a raw `ENOENT` out of `readFileSync`: it named
 * a path, but never said that the staged runtime was incomplete, which is the one
 * thing a caller has to know to fix it.
 *
 * Name the artifact **inside the package** (`runtime/<target>/provenance.json`), not the absolute
 * path, and report only the error's code or name: the raw `ENOENT`/`SyntaxError` message embeds the
 * operator's own install path, and an error text that reaches a tool result should not disclose it
 * (#30's point). The package-relative name keeps it actionable — you still know which artifact is
 * wrong.
 */
function readJson(file: string, what: string, shown: string): Record<string, unknown> {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (error) {
    throw new Error(`Native worker ${what} at ${shown} could not be read (${(error as NodeJS.ErrnoException)?.code ?? (error as Error)?.name ?? 'unknown'})`)
  }
  try { return JSON.parse(text) as Record<string, unknown> } catch (error) {
    throw new Error(`Native worker ${what} at ${shown} is not valid JSON (${(error as Error)?.name ?? 'unknown'})`)
  }
}
/**
 * Resolve the worker without throwing, for a caller that has to *report* an
 * unresolvable host rather than fail on it — a test suite, whose convention for
 * "this host cannot answer" is `skipSuite` (exit 77) and never a crash while the
 * module is still loading.
 *
 * The support matrix is checked first, so an unsupported host gets the matrix's
 * own sentence and every other failure keeps the exact reason `resolveWorker`
 * would have thrown. `reason` is a complete clause a caller can put straight into
 * a skip message.
 *
 * @param {object} [config] - same as {@link resolveWorker}.
 * @param {object} [options] - same as {@link resolveWorker}.
 * @returns {{ok: true, file: string}|{ok: false, reason: string}} the attempt.
 */
export function tryResolveWorker(config: WorkerSelection = {}, options: RuntimeOptions = {}): WorkerResolution {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  try {
    if (!PLATFORMS.includes(`${platform}-${arch}`)) {
      throw new Error(`this host is ${platform}-${arch}, outside the ${PLATFORMS.join(' / ')} support matrix`)
    }
    return { ok: true, file: resolveWorker(config, options) }
  } catch (error) {
    return { ok: false, reason: String((error as Error)?.message ?? error) }
  }
}

export function resolveWorker(config: WorkerSelection = {}, { packageRoot = PACKAGE_ROOT, env = process.env, platform = process.platform, arch = process.arch }: RuntimeOptions = {}): string {
  if (!PLATFORMS.includes(`${platform}-${arch}`)) throw new Error(`dsh-ops supports Windows x64, Linux x64 and macOS (arm64/x64) only; unsupported runtime target ${platform}-${arch}.`)
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
  const same = (a: string, b: string) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
  const skipped: string[] = []
  for (const { file, note } of candidates) {
    if (!path.isAbsolute(file)) throw new Error('Native worker selection must be an absolute path.')
    let stat
    try { stat = fs.statSync(file) } catch (error) {
      // Only "no such file" is an ordinary miss for a candidate list. A directory the
      // process may not traverse, or a symlink that dangles, is a real condition that
      // an "unavailable" message would hide behind the same words.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw new Error(`Native worker candidate ${file} could not be inspected: ${(error as Error).message}`)
      skipped.push(`${file} (absent)`); continue
    }
    if (!stat.isFile()) { skipped.push(`${file} (not a regular file)`); continue }
    // Windows has no execute bit, so this is POSIX-only. Without it, a worker copied
    // over without its mode was accepted here and failed later as a bare `EACCES`
    // from `spawn`, which reads as a sandbox problem rather than a missing `chmod`
    // (report L12).
    if (platform !== 'win32' && (stat.mode & 0o111) === 0) {
      throw new Error(`Native worker ${file} is not executable (mode ${(stat.mode & 0o7777).toString(8).padStart(4, '0')}). Run chmod +x on it, or re-stage it with npm run build:ptc; dsh-ops never changes permissions on its own.`)
    }
    // Verify the packaged candidate against its receipt. Two limits, stated so nobody
    // mistakes this for a trust boundary:
    //   · the receipt sits **beside** the payload, so whoever replaces both passes.
    //     This catches a build/metadata mismatch (a stale or mistaken runtime), not a
    //     deliberate substitution — that needs npm's integrity or a signature, which is
    //     outside this plugin.
    //   · the selection test is "is this the candidate we derived", not a substring of a
    //     path: `includes('\runtime\')` let any absolute path opt itself in (or out).
    if (same(path.resolve(file), fromPackage)) {
      const receipt = readJson(path.join(path.dirname(file), 'provenance.json'), 'provenance receipt',
        path.posix.join('runtime', `${platform}-${arch}`, 'provenance.json'))
      const version = readJson(path.join(packageRoot, 'package.json'), 'package manifest', 'package.json').version
      if (receipt.target !== `${platform}-${arch}` || receipt.version !== version || receipt.executable !== workerName(platform)
        || receipt.sha256 !== createHash('sha256').update(fs.readFileSync(file)).digest('hex')) throw new Error('Native worker provenance mismatch.')
    } else {
      // Not silent: an unverified worker binary is a fact the operator should see.
      console.warn(`dsh-ops: native worker selected without provenance verification — ${note}: ${file}`)
    }
    return file
  }
  throw new Error(`Native worker unavailable for ${platform}-${arch}. Tried:\n${skipped.map(entry => `  ${entry}`).join('\n')}\nInstall a runtime-bearing dsh-ops package, or run npm run build:ptc in the source checkout. No ACL repair, shell fallback or automatic download is performed.`)
}
