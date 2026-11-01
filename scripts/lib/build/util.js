/**
 * Shared plumbing for the platform-package build pipeline.
 *
 * The small surface every step of `scripts/build-platform-packages.mjs` uses:
 * progress lines, JSON reads and writes, digests, child processes, and npm
 * invocations. The pipeline's entry point and the digest that pins it live here
 * too, so a stage is only reused while the same entry produced it.
 *
 * @module dsh-ops/build/lib/util
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** This checkout's root: this module lives in `scripts/lib/build/`. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** The directory the pipeline's own modules live in. */
const PIPELINE_DIR = path.dirname(fileURLToPath(import.meta.url))

/**
 * The pipeline's entry point, whose bytes every `provenance.json` records.
 *
 * It is named explicitly instead of derived from `import.meta.url` because the
 * digest below covers this module too, and one file has to be the file a
 * release ran.
 */
export const ENTRY_FILE = path.join(REPO_ROOT, 'scripts', 'build-platform-packages.mjs')

/** Every file that makes up this pipeline: the entry, then its modules in order. */
const PIPELINE_FILES = [
  ENTRY_FILE,
  ...fs.readdirSync(PIPELINE_DIR)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => path.join(PIPELINE_DIR, name)),
]

/**
 * The digest of this pipeline's own bytes: the entry point and every module
 * beside this one, path and content, so that a split of the pipeline into
 * modules cannot slip past the stage-reuse guard.
 *
 * It is recorded in every `provenance.json` and checked before a previously
 * assembled stage is reused, so a stage is only ever reused while everything
 * that produced it — the payload or pin, the skeleton, and this pipeline — is
 * unchanged. A stale stage is the one failure mode a release pipeline must not
 * have: the digests it publishes would describe bytes nobody built.
 */
export const SCRIPT_SHA256 = (() => {
  const hash = crypto.createHash('sha256')
  for (const file of PIPELINE_FILES) {
    hash.update(`${path.relative(REPO_ROOT, file).replace(/\\/gu, '/')}\0`)
    hash.update(fs.readFileSync(file))
    hash.update('\0')
  }
  return hash.digest('hex')
})()

/**
 * Print one progress line.
 * @param {string} scope - the step or area the line belongs to.
 * @param {string} message - what happened.
 * @returns {void}
 */
export function log(scope, message) {
  console.log(`[${scope}] ${message}`)
}

/** Print one warning line without failing the run. */
export function warn(scope, message) {
  console.log(`[${scope}] WARNING ${message}`)
}

/**
 * Format a byte count for the reports a human reads: kibibytes while a pin
 * package is measured in kilobytes, mebibytes once it is not.
 * @param {number|undefined} bytes - the count.
 * @returns {string} the formatted size.
 */
export function size(bytes) {
  if (bytes === undefined) return '?'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

/**
 * Read a JSON file, or return undefined when it is absent or unreadable.
 * @param {string} file - the path.
 * @returns {any} the parsed value, or undefined.
 */
export function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Write one JSON document with the repository's formatting (2 spaces, trailing newline).
 * @param {string} file - the path.
 * @param {unknown} value - the value to serialize.
 * @returns {void}
 */
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * The sha256 of one file, streamed so a large artifact is never held in memory twice.
 * @param {string} file - the path.
 * @returns {Promise<string>} the lowercase hex digest.
 */
export async function sha256File(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * Run one command and capture its output.
 * @param {string} command - the executable.
 * @param {string[]} args - its arguments.
 * @param {object} [options] - run options.
 * @param {string} [options.cwd] - the working directory.
 * @param {NodeJS.ProcessEnv} [options.env] - the environment.
 * @param {boolean} [options.inherit] - stream the child's output instead of capturing it.
 * @returns {{status: number, stdout: string, stderr: string}} the result.
 */
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? process.env,
    encoding: 'utf8',
    // `npm pack --json` describes every file it packed: the default 1 MiB
    // capture limit turns that report into ENOBUFS, so the cap is raised.
    maxBuffer: 512 * 1024 * 1024,
    stdio: options.inherit === true ? 'inherit' : 'pipe',
    windowsHide: true,
  })
  if (result.error !== undefined && result.error !== null) {
    throw new Error(`cannot run ${command}: ${String(result.error.message ?? result.error)}`)
  }
  const stdout = options.inherit === true ? '' : (result.stdout ?? '')
  const stderr = options.inherit === true ? '' : (result.stderr ?? '')
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${String(result.status)}`
      + (stderr.trim() === '' ? '' : `\n${stderr.trim()}`),
    )
  }
  return { status: result.status, stdout, stderr }
}

/**
 * How to run npm: through this Node's own npm CLI when it is next to the
 * interpreter, so no shell quoting is involved (spawning `npm.cmd` needs a
 * shell, which would make every path containing a space a parsing problem).
 * @param {string[]} args - the npm arguments.
 * @returns {{command: string, args: string[]}} the invocation.
 */
export function npmInvocation(args) {
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return fs.existsSync(cli)
    ? { command: process.execPath, args: [cli, ...args] }
    : { command: 'npm', args }
}

/**
 * Run npm, capturing its output.
 * @param {string[]} args - the npm arguments.
 * @param {object} [options] - run options.
 * @returns {{status: number, stdout: string, stderr: string}} the result.
 */
export function npm(args, options = {}) {
  const call = npmInvocation(args)
  return run(call.command, call.args, options)
}

/**
 * Parse the JSON document npm prints for `--json`, tolerating surrounding noise.
 * @param {string} stdout - the captured output.
 * @param {string} what - what was being parsed, for the error message.
 * @returns {any} the parsed value.
 */
export function parseNpmJson(stdout, what) {
  const trimmed = stdout.trim()
  const candidates = [trimmed]
  const frames = [['[', ']'], ['{', '}']].map(([open, close]) => ({ start: trimmed.indexOf(open), end: trimmed.lastIndexOf(close) }))
    .filter(({ start, end }) => start >= 0 && end > start).sort((a, b) => a.start - b.start)
  for (const { start, end } of frames) candidates.push(trimmed.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // try the next shape
    }
  }
  throw new Error(`cannot parse npm --json output for ${what}: ${trimmed.slice(0, 400)}`)
}

/** Normalize npm <=11 arrays and npm 12 package-keyed pack reports, failing closed. */
export function parseNpmPackReport(stdout, what, manifest) {
  const value = parseNpmJson(stdout, what)
  const object = entry => entry !== null && typeof entry === 'object' && !Array.isArray(entry)
  const invalid = () => { throw new Error(`invalid npm pack report for ${what}: expected one matching package with safe tarball and file metadata`) }
  if (!object(manifest) || typeof manifest.name !== 'string' || typeof manifest.version !== 'string') invalid()
  const entries = Array.isArray(value) ? value : object(value) ? Object.values(value) : []
  if (entries.length !== 1 || (!Array.isArray(value) && Object.keys(value)[0] !== manifest.name)) invalid()
  const [entry] = entries
  const relativeFile = name => typeof name === 'string' && name.length > 0 && !/[\\:\0]/u.test(name)
    && !path.posix.isAbsolute(name) && !name.split('/').some(part => part === '' || part === '.' || part === '..')
  if (!object(entry) || entry.name !== manifest.name || entry.version !== manifest.version
    || entry.id !== `${manifest.name}@${manifest.version}` || !relativeFile(entry.filename)
    || entry.filename.includes('/') || !entry.filename.endsWith('.tgz')
    || !Number.isSafeInteger(entry.unpackedSize) || entry.unpackedSize < 0
    || !Array.isArray(entry.files) || entry.files.length === 0
    || !entry.files.every(file => object(file) && relativeFile(file.path))) invalid()
  return entry
}

/** The main package's manifest, read once per run. */
export function mainManifest() {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
}

/**
 * Copy one file or directory tree.
 * @param {string} source - the source path.
 * @param {string} destination - the destination path.
 * @returns {string[]} the package-relative paths written.
 */
export function copyEntry(source, destination) {
  const written = []
  const stat = fs.statSync(source)
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(source).sort()) {
      written.push(...copyEntry(path.join(source, entry), path.join(destination, entry)))
    }
    return written
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(source, destination)
  written.push(destination)
  return written
}

/**
 * Every file inside a directory tree, as package-relative paths.
 * @param {string} root - the directory.
 * @returns {string[]} the sorted relative paths, with `/` separators.
 */
export function treeFiles(root) {
  const files = []
  /**
   * Walk one directory.
   * @param {string} current - the directory to walk.
   * @returns {void}
   */
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name)
      if (entry.isDirectory()) walk(file)
      else files.push(path.relative(root, file).replace(/\\/gu, '/'))
    }
  }
  walk(root)
  return files.sort()
}

/**
 * The current commit, for provenance, or `unknown` outside a git checkout.
 * @returns {string} the revision.
 */
export function gitRevision() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true })
  return result.status === 0 ? (result.stdout ?? '').trim() : 'unknown'
}

/**
 * The digest of one committed skeleton: every relative path and every file's
 * bytes, so a change to a notice or to the metadata forces the package to be
 * assembled again instead of silently reusing a stale stage.
 * @param {string} directory - the skeleton directory.
 * @returns {string} the lowercase hex digest.
 */
export function skeletonDigest(directory) {
  const hash = crypto.createHash('sha256')
  /**
   * Fold one directory into the digest, in a stable order.
   * @param {string} current - the directory to walk.
   * @returns {void}
   */
  const walk = (current) => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : 1))
    for (const entry of entries) {
      const file = path.join(current, entry.name)
      hash.update(`${path.relative(directory, file).replace(/\\/gu, '/')}\0`)
      if (entry.isDirectory()) walk(file)
      else hash.update(fs.readFileSync(file))
      hash.update('\0')
    }
  }
  walk(directory)
  return hash.digest('hex')
}
