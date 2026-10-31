/**
 * The shape of a real directory tree: what a timing corpus must have in common with the
 * workload it stands in for, measured without reading file contents.
 *
 * A corpus is "real" only if it is `describe`d before and after a run: the shape and the
 * tree hash go into the evidence, so a number can never be explained by an unrecorded
 * change of input. Nothing here judges a duration.
 *
 * @module dsh-ops/bench/calls/shape
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

/** Extensions counted as binary bytes. A proxy for "the worker will fail UTF-8 on it". */
export const BINARY_EXTENSIONS = new Set([
  '.a', '.aab', '.apk', '.asar', '.bin', '.bz2', '.class', '.crate', '.db', '.dll', '.dmg',
  '.eot', '.exe', '.gif', '.gz', '.ico', '.iso', '.jar', '.jpeg', '.jpg', '.lib', '.msi',
  '.node', '.o', '.obj', '.otf', '.pdb', '.pdf', '.png', '.pyd', '.pyc', '.rar', '.rlib',
  '.rmeta', '.so', '.sqlite', '.tar', '.tgz', '.ttf', '.wasm', '.wav', '.webp', '.woff',
  '.woff2', '.xz', '.zip', '.7z',
])

/** Depth cap: deep enough for `node_modules/a/node_modules/b`, bounded so a loop cannot hang it. */
export const MAX_DEPTH = 64

/**
 * Walk a tree and describe it. Symlinks and junctions are counted, never followed: a
 * benchmark must not read through a link into a tree it did not declare.
 *
 * @param {string} root - the directory to describe; must exist.
 * @param {{maxDepth?: number}} [limits] - the depth cap.
 * @returns {{root: string, files: number, directories: number, bytes: number, mebibytes: number,
 *   maxDepth: number, links: number, unreadable: number, binaryFiles: number, binaryBytes: number,
 *   binaryBytesRatio: number, extensions: Record<string, {files: number, bytes: number}>}} the shape.
 */
export function describe(root, { maxDepth = MAX_DEPTH } = {}) {
  const resolved = path.resolve(root)
  const extensions = Object.create(null)
  let files = 0, directories = 0, bytes = 0, depth = 0, links = 0, unreadable = 0
  let binaryFiles = 0, binaryBytes = 0
  const stack = [[resolved, 0]]
  while (stack.length > 0) {
    const [directory, level] = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      unreadable += 1
      continue
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) { links += 1; continue }
      if (entry.isDirectory()) {
        directories += 1
        const next = level + 1
        if (next > depth) depth = next
        if (next < maxDepth) stack.push([target, next])
        else unreadable += 1
        continue
      }
      if (!entry.isFile()) continue
      let stat
      try {
        stat = fs.lstatSync(target)
      } catch {
        unreadable += 1
        continue
      }
      files += 1
      bytes += stat.size
      const extension = path.extname(entry.name).toLowerCase() || '<none>'
      const bucket = extensions[extension] ?? (extensions[extension] = { files: 0, bytes: 0 })
      bucket.files += 1
      bucket.bytes += stat.size
      if (BINARY_EXTENSIONS.has(extension)) { binaryFiles += 1; binaryBytes += stat.size }
    }
  }
  return {
    root: resolved, files, directories, bytes,
    mebibytes: round(bytes / 1048576, 1),
    maxDepth: depth, links, unreadable, binaryFiles, binaryBytes,
    binaryBytesRatio: bytes === 0 ? 0 : round(binaryBytes / bytes, 3),
    extensions,
  }
}

/**
 * A content-independent fingerprint of the tree: every file's relative path, size and
 * modification time, sorted. Two runs whose hashes differ did not read the same input,
 * whatever the durations say.
 *
 * @param {string} root - the tree to fingerprint.
 * @returns {string} the hex sha256 of the sorted inventory.
 */
export function treeHash(root) {
  const resolved = path.resolve(root)
  const rows = []
  const stack = [[resolved, '']]
  while (stack.length > 0) {
    const [directory, prefix] = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      rows.push(`${prefix}<unreadable>`)
      continue
    }
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isSymbolicLink()) { rows.push(`${relative}:link`); continue }
      if (entry.isDirectory()) { stack.push([path.join(directory, entry.name), relative]); continue }
      if (!entry.isFile()) continue
      try {
        const stat = fs.lstatSync(path.join(directory, entry.name))
        rows.push(`${relative}:${stat.size}:${stat.mtimeMs}`)
      } catch {
        rows.push(`${relative}:<unreadable>`)
      }
    }
  }
  rows.sort()
  return createHash('sha256').update(rows.join('\n')).digest('hex')
}

/**
 * Check a measured shape against the manifest's declared ranges. An out-of-range corpus
 * is a refusal, not a note: measuring a different workload under the same name is how a
 * benchmark starts lying.
 *
 * @param {object} shape - the object {@link describe} returned.
 * @param {object} declared - the manifest's `shape` map: field -> `[min, max]`.
 * @returns {{ok: boolean, problems: string[]}} the verdict.
 */
export function checkShape(shape, declared = {}) {
  const problems = []
  for (const [field, range] of Object.entries(declared)) {
    if (!Array.isArray(range) || range.length !== 2) throw new Error(`shape.${field} must be [min, max]`)
    const [min, max] = range
    const actual = shape[field]
    if (typeof actual !== 'number') throw new Error(`shape.${field} is not a measured field`)
    if (actual < min || actual > max) problems.push(`${field}=${actual} outside [${min}, ${max}]`)
  }
  return { ok: problems.length === 0, problems }
}

/**
 * A content fingerprint of a deterministic sample of the tree.
 *
 * The tree hash above answers "did the input change *during* this run"; this one answers
 * "is this the same software version as the last run". Hashing 2 GB on every run would
 * make the tool too slow to use, so files are chosen by a content-independent rule —
 * sorted relative path, then an even stride — and each chosen file is hashed whole.
 * A version bump touches far more than `count` files, so a sample catches it; one edited
 * file in 66k may not, and the report says so by recording the sample size.
 *
 * @param {string} root - the tree to sample.
 * @param {{count?: number}} [options] - how many files to hash; `0` disables sampling.
 * @returns {{count: number, files: number, bytes: number, hash: string|null}} the sample.
 */
export function sampleHash(root, { count = 32 } = {}) {
  if (!Number.isInteger(count) || count < 0) throw new Error('sample count must be a non-negative integer')
  if (count === 0) return { count: 0, files: 0, bytes: 0, hash: null }
  const resolved = path.resolve(root)
  const inventory = []
  const stack = [[resolved, '']]
  while (stack.length > 0) {
    const [directory, prefix] = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) { stack.push([path.join(directory, entry.name), relative]); continue }
      if (entry.isFile()) inventory.push(relative)
    }
  }
  inventory.sort()
  const stride = Math.max(1, Math.ceil(inventory.length / count))
  const picked = inventory.filter((_, index) => index % stride === 0).slice(0, count)
  const rows = []
  let bytes = 0
  for (const relative of picked) {
    const data = fs.readFileSync(path.join(resolved, relative))
    bytes += data.length
    rows.push(`${relative}:${data.length}:${createHash('sha256').update(data).digest('hex')}`)
  }
  return { count, files: picked.length, bytes, hash: createHash('sha256').update(rows.join('\n')).digest('hex') }
}
/** Round to a fixed number of decimals without pulling in a formatting dependency. */
function round(value, decimals) {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}
