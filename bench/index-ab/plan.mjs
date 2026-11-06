/**
 * G4 (#614): the reproducible corpus recipe and query plan for the index-versus-walk
 * A/B. Dependency-free on purpose: the same file runs on every platform Node supports,
 * and every byte of the corpus derives from the recipe below, never from the machine.
 *
 * @module dsh-ops/bench/index-ab/plan
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

/** Report format tag; a reader that does not know it refuses the file. */
export const INDEX_AB_FORMAT = 'dsh-ops-index-ab-v1'

/** The corpus recipe. Changing a field changes the tree hash, which changes the evidence. */
export const RECIPE = Object.freeze({
  id: 'g4-source',
  seed: 0xA1B2C3D4,
  packages: 12,
  dirsPerPackage: 7,
  filesPerDir: 18,
  maxContentBytes: 4096,
  minContentBytes: 48,
})

/**
 * The query plan. Patterns use the documented ops_glob grammar; every case is a
 * read-only glob, so the A/B never mutates the corpus. The no-hit case is the
 * coverage case: it must scan the whole tree and still report a complete answer.
 */
export const QUERIES = Object.freeze([
  { id: 'ext-rs', patterns: ['**/*.rs'] },
  { id: 'basename-json', patterns: ['*.json'] },
  { id: 'nested-js', patterns: ['packages/**/src/**/*.js'] },
  { id: 'name-mod-rs', patterns: ['**/mod.rs'] },
  { id: 'no-hit', patterns: ['**/*.nomatch'] },
])

/** The extension/style classes the generator draws from. */
const EXTENSIONS = ['.rs', '.js', '.json', '.md', '.toml', '.txt', '.yaml']
const STEMS = ['index', 'mod', 'lib', 'main', 'util', 'parse', 'render', 'store', 'query', 'plan', 'test', 'fixture', 'data', 'config', 'report']
const WORDS = ['alpha', 'bravo', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo']

/** Mulberry32: small, deterministic, and not a cryptographic claim. */
function random(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/** Stable, platform-independent relative path spelling (forward slashes). */
export function toPosix(relative) {
  return relative.split(path.sep).join('/')
}

/**
 * Describe the generated tree from the outside: counts, depth, total content bytes.
 * @param {string} root - the corpus root.
 * @returns {{files: number, dirs: number, symlinks: number, bytes: number, maxDepth: number, layout: {files: number, dirs: number}}}
 */
export function describeCorpus(root) {
  let files = 0
  let dirs = 0
  let symlinks = 0
  let bytes = 0
  let maxDepth = 0
  const walk = (dir, depth) => {
    maxDepth = Math.max(maxDepth, depth)
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) { symlinks += 1; continue }
      if (entry.isDirectory()) { dirs += 1; walk(file, depth + 1) }
      else if (entry.isFile()) { files += 1; bytes += fs.statSync(file).size }
    }
  }
  walk(root, 0)
  return { files, dirs, symlinks, bytes, maxDepth, layout: { files, dirs } }
}

/**
 * Hash the tree identity: every relative path, its size and a content hash. This is
 * what proves a later run measured the same workload, independent of inode numbers
 * or timestamps.
 * @param {string} root - the corpus root.
 * @returns {string} the sha256 hex digest.
 */
export function corpusHash(root) {
  const hash = createHash('sha256')
  const visit = (dir, prefix) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
      const file = path.join(dir, entry.name)
      const relative = prefix ? prefix + '/' + entry.name : entry.name
      if (entry.isSymbolicLink()) { hash.update('link|' + relative + '|'); continue }
      if (entry.isDirectory()) { hash.update('dir|' + relative + '|'); visit(file, relative) }
      else if (entry.isFile()) {
        hash.update('file|' + relative + '|' + fs.statSync(file).size + '|')
        hash.update(createHash('sha256').update(fs.readFileSync(file)).digest())
      } else throw new Error('cannot hash a non-regular corpus entry: ' + file)
    }
  }
  visit(root, '')
  return hash.digest('hex')
}

/** Content of one generated file, derived only from its position in the plan. */
function fileContent(randomValue, bytes) {
  const parts = []
  let written = 0
  while (written < bytes) {
    const word = WORDS[Math.floor(randomValue() * WORDS.length)] + '-' + Math.floor(randomValue() * 1000)
    parts.push(word)
    written += word.length + 1
  }
  return parts.join(' ').slice(0, bytes - 1) + '\n'
}

/**
 * Create the corpus under root. An existing corpus is refused so a half-prepared
 * tree is never measured; pass fresh: true to replace one created by this module.
 * @param {string} root - directory to create the corpus under.
 * @param {{fresh?: boolean}} [options] - whether to replace an existing corpus.
 * @returns {{root: string, recipe: object}} the created root and recipe.
 */
export function prepareCorpus(root, options = {}) {
  if (fs.existsSync(root)) {
    if (!options.fresh) throw new Error('refusing to reuse an existing corpus: ' + root + ' (pass --fresh to rebuild)')
    fs.rmSync(root, { recursive: true, force: true })
  }
  fs.mkdirSync(root, { recursive: true })
  const randomValue = random(RECIPE.seed)
  const write = (relative, bytes) => {
    const file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, fileContent(randomValue, bytes))
  }
  // Hidden and dependency-shaped directories exist on purpose: both are excluded by
  // the traversal contract, so their presence proves the A/B did not secretly expand
  // the scan surface.
  for (let index = 0; index < 6; index += 1) write('.hidden/ignored-' + index + '.rs', 64)
  for (let index = 0; index < 6; index += 1) write('node_modules/dep-' + index + '/index.js', 128)
  for (let index = 0; index < 3; index += 1) write('target/artifact-' + index + '.json', 128)
  for (let packageIndex = 0; packageIndex < RECIPE.packages; packageIndex += 1) {
    const packageName = 'pkg-' + String(packageIndex).padStart(2, '0')
    for (let dirIndex = 0; dirIndex < RECIPE.dirsPerPackage; dirIndex += 1) {
      const area = ['src', 'test', 'docs', 'fixtures'][dirIndex % 4]
      const dirName = 'packages/' + packageName + '/' + area + '/group-' + dirIndex
      for (let fileIndex = 0; fileIndex < RECIPE.filesPerDir; fileIndex += 1) {
        const stem = STEMS[Math.floor(randomValue() * STEMS.length)]
        const extension = EXTENSIONS[Math.floor(randomValue() * EXTENSIONS.length)]
        const suffix = fileIndex === 0 && area === 'src' ? 'mod.rs' : stem + '-' + fileIndex + extension
        const bytes = RECIPE.minContentBytes + Math.floor(randomValue() * (RECIPE.maxContentBytes - RECIPE.minContentBytes))
        write(dirName + '/' + suffix, bytes)
      }
    }
    write('packages/' + packageName + '/src/mod.rs', 256)
    write('packages/' + packageName + '/' + packageName + '.json', 512)
  }
  write('README.md', 1024)
  return { root, recipe: RECIPE }
}

/** Median of a numeric list (null when empty); even counts average the middle pair. */
export function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

/** Nearest-rank 95th percentile of a numeric list (null when empty). */
export function percentile95(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
}

/** Round a duration or byte count for display without pretending extra precision. */
export function round(value, digits = 1) {
  if (value === null || value === undefined) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
