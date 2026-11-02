/**
 * Real corpora: manifests that name an existing tree on this machine, plus the argument
 * adapters that make one logical query comparable across two projections.
 *
 * A manifest is a *contract about shape*, not a copy of data. The tree itself is whatever
 * the pinned lockfile, toolchain or git commit produced; `shape.mjs` proves it is still
 * the workload the numbers are filed under.
 *
 * @module dsh-ops/bench/calls/corpora
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

import { sampleHash } from './shape.mjs'
import { expandTemplate } from './paths.mjs'

/** Where the shipped manifests live, resolved from this module so any cwd works. */
export const CORPORA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'corpora')

/** The logical tools a corpus case may name; each has one adapter per projection. */
export const LOGICAL_TOOLS = ['grep', 'glob']

/** Fields a manifest may carry; anything else is a typo that must fail loudly. */
export const MANIFEST_FIELDS = ['id', 'title', 'class', 'roots', 'shape', 'identity', 'cases']

/** Fields the identity block may carry: provenance files, and how many files to sample. */
export const IDENTITY_FIELDS = ['files', 'sample', 'expect']

/** Fields a case may carry. */
export const CASE_FIELDS = ['id', 'tool', 'args', 'candidate']

/**
 * Read one manifest. Throws with the file name and the offending field, because a
 * malformed corpus must never be silently replaced by a default.
 *
 * @param {string} file - absolute manifest path.
 * @returns {object} the validated manifest with `file` added.
 */
export function readManifest(file) {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read corpus manifest ${file}: ${String(error?.message ?? error)}`)
  }
  rejectUnknown(raw, MANIFEST_FIELDS, path.basename(file))
  const manifest = { ...raw, file }
  if (typeof manifest.id !== 'string' || !/^[a-z0-9-]+$/.test(manifest.id)) throw new Error(`${path.basename(file)}: id must be lower-case letters, digits and dashes`)
  if (!Array.isArray(manifest.roots) || manifest.roots.length === 0) throw new Error(`${path.basename(file)}: roots must be a non-empty array`)
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) throw new Error(`${path.basename(file)}: cases must be a non-empty array`)
  if (typeof manifest.identity !== 'object' || manifest.identity === null) throw new Error(`${path.basename(file)}: identity is required — a corpus that cannot name its own version is not pinned`)
  rejectUnknown(manifest.identity, IDENTITY_FIELDS, `${manifest.id} identity`)
  if (manifest.identity.files !== undefined && (!Array.isArray(manifest.identity.files) || manifest.identity.files.some(item => typeof item !== 'string' || item === ''))) throw new Error(`${manifest.id}: identity.files must be an array of paths`)
  if (manifest.identity.sample !== undefined && (!Number.isInteger(manifest.identity.sample) || manifest.identity.sample < 0)) throw new Error(`${manifest.id}: identity.sample must be a non-negative integer`)
  if ((manifest.identity.files ?? []).length === 0 && (manifest.identity.sample ?? 0) === 0) throw new Error(`${manifest.id}: identity needs files or a positive sample`)
  if (manifest.identity.expect !== undefined) {
    if (typeof manifest.identity.expect !== 'object' || manifest.identity.expect === null) throw new Error(`${manifest.id}: identity.expect must be an object of path -> sha256`)
    for (const [template, digest] of Object.entries(manifest.identity.expect)) {
      if (!/^[0-9a-f]{64}$/.test(String(digest))) throw new Error(`${manifest.id}: identity.expect["${template}"] must be a sha256 hex digest`)
      if (!(manifest.identity.files ?? []).includes(template)) throw new Error(`${manifest.id}: identity.expect["${template}"] must also be listed in identity.files`)
    }
  }
  const seen = new Set()
  for (const item of manifest.cases) {
    rejectUnknown(item, CASE_FIELDS, `${manifest.id} case`)
    if (typeof item.id !== 'string' || item.id === '') throw new Error(`${manifest.id}: every case needs an id`)
    if (seen.has(item.id)) throw new Error(`${manifest.id}: duplicate case id "${item.id}"`)
    seen.add(item.id)
    if (!LOGICAL_TOOLS.includes(item.tool)) throw new Error(`${manifest.id}/${item.id}: unknown tool "${item.tool}" (known: ${LOGICAL_TOOLS.join(', ')})`)
    if (typeof item.args !== 'object' || item.args === null || typeof item.args.pattern !== 'string') throw new Error(`${manifest.id}/${item.id}: args.pattern must be a string`)
  }
  return manifest
}

/**
 * Load every `*.json` manifest in a directory, sorted by id.
 * @param {string} [dir] - the manifest directory; defaults to the shipped corpora.
 * @returns {object[]} the manifests.
 */
export function loadManifests(dir = CORPORA_DIR) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .map(name => readManifest(path.join(dir, name)))
    .sort((left, right) => left.id.localeCompare(right.id))
}

/**
 * Expand one declared root. The implementation lives in `paths.mjs` so the pin resolver
 * expands the very same placeholders; this name stays the public one for callers/tests.
 *
 * @param {string} template - `${repo}`, `${home}`, `${root}` or `${env:NAME}` segments.
 * @param {{repoRoot: string, home?: string, env?: NodeJS.ProcessEnv, root?: string}} context - expansion values.
 * @returns {string} the absolute candidate path.
 */
export const expandRoot = expandTemplate

/**
 * Resolve the first existing declared root. An explicit override wins and is checked for
 * existence, so "I pointed it at the wrong tree" is a refusal rather than a zero-file run.
 *
 * @param {object} manifest - a validated manifest.
 * @param {{repoRoot: string, override?: string, home?: string, env?: NodeJS.ProcessEnv}} context - resolution values.
 * @returns {string} the absolute corpus root.
 * @throws {Error} when no candidate exists.
 */
export function resolveRoot(manifest, context) {
  if (context.override !== undefined) {
    const resolved = path.resolve(context.override)
    if (!fs.existsSync(resolved)) throw new Error(`${manifest.id}: --root does not exist: ${resolved}`)
    return resolved
  }
  const candidates = manifest.roots.map(template => expandRoot(template, context))
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  throw new Error(`${manifest.id}: no corpus root exists. Tried:\n  ${candidates.join('\n  ')}\nBuild it (npm ci / rustup toolchain install) or pass --root <path>.`)
}

/**
 * Turn one logical case into the call a projection actually accepts. The query is shared;
 * only the argument shape differs, because the two tools are different tools.
 *
 * @param {object} item - one manifest case.
 * @param {'official'|'candidate'} projection - which arm is being called.
 * @param {(name: string) => string} candidateName - maps a logical name to the public OPS name.
 * @returns {{name: string, args: object}} the call.
 */
export function adaptCase(item, projection, candidateName) {
  const args = { ...item.args }
  if (projection === 'official') return { name: item.tool, args }
  if (projection !== 'candidate') throw new Error(`unknown projection "${projection}"`)
  const common = { pattern: args.pattern, path: args.path }
  const mapped = item.tool === 'grep'
    ? { name: candidateName('grep'), args: { ...common, ...(args.include === undefined ? {} : { glob: [args.include] }), outputMode: 'summary' } }
    : { name: candidateName('glob'), args: { ...common, pattern: [args.pattern], outputMode: 'paths', sort: 'path', limit: 100 } }
  return { ...mapped, args: { ...mapped.args, ...(item.candidate ?? {}) } }
}

/**
 * The identity of one corpus: the provenance files it names (a lockfile, a channel
 * manifest) plus a content sample of the tree. This is what makes "same corpus" checkable
 * across runs; the mtime tree hash in `shape.mjs` only proves nothing moved *during* one run.
 *
 * @param {object} manifest - a validated manifest.
 * @param {string} root - the resolved corpus root.
 * @param {{repoRoot: string, home?: string, env?: NodeJS.ProcessEnv}} context - expansion values.
 * @returns {{files: {path: string, sha256: string}[], sample: object, combined: string}} the identity.
 * @throws {Error} when a declared provenance file is missing.
 */
export function identityOf(manifest, root, context) {
  const declared = manifest.identity ?? {}
  const files = (declared.files ?? []).map(template => {
    const file = expandRoot(template, { ...context, root })
    if (!fs.existsSync(file)) throw new Error(`${manifest.id}: identity file missing: ${file}`)
    return { path: file, sha256: sha256File(file) }
  })
  // A recorded expectation is a lock, not a note: a provenance file that no longer hashes
  // to the pinned value means this is a different installation, and the run must refuse.
  for (const [template, expected] of Object.entries(declared.expect ?? {})) {
    const file = expandRoot(template, { ...context, root })
    const found = files.find(candidate => candidate.path === file)
    if (!found) throw new Error(`${manifest.id}: identity.expect names an unhashed file: ${file}`)
    if (found.sha256 !== expected) throw new Error(`${manifest.id}: ${path.basename(file)} is not the pinned version (expected ${expected.slice(0, 12)}, found ${found.sha256.slice(0, 12)}); rebuild the corpus or update the pin deliberately`)
  }
  const sample = sampleHash(root, { count: declared.sample ?? 32 })
  const combined = createHash('sha256')
    .update(files.map(file => file.sha256).join(':') + '|' + (sample.hash ?? 'none'))
    .digest('hex')
  return { files, sample, combined }
}

/**
 * Compare two identities of the same corpus. Every difference is named, because "the
 * versions differ" without saying which file moved is not actionable.
 *
 * @param {{files: {path: string, sha256: string}[], sample: {hash: string|null}}} current - this run.
 * @param {{files: {path: string, sha256: string}[], sample: {hash: string|null}}} baseline - the earlier run.
 * @returns {string[]} the differences; empty when the corpus is the same software version.
 */
export function compareIdentities(current, baseline) {
  const differences = []
  for (const file of current.files) {
    const before = baseline.files.find(candidate => path.basename(candidate.path) === path.basename(file.path))
    if (!before) differences.push(`identity file not in baseline: ${file.path}`)
    else if (before.sha256 !== file.sha256) differences.push(`${path.basename(file.path)} differs (${before.sha256.slice(0, 12)} -> ${file.sha256.slice(0, 12)})`)
  }
  const currentHash = current.sample?.hash ?? null
  const baselineHash = baseline.sample?.hash ?? null
  if (currentHash !== baselineHash) differences.push(`tree sample differs (${String(baselineHash).slice(0, 12)} -> ${String(currentHash).slice(0, 12)})`)
  return differences
}

/** The sha256 of a file; identity files are small enough to read whole. */
function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** Reject any field the whitelist does not know; a typo must name itself. */
function rejectUnknown(value, allowed, where) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${where}: unknown field "${key}" (known: ${allowed.join(', ')})`)
  }
}
