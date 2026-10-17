/**
 * The `tree` fixture family: trees whose answer is a set of files or a
 * precedence, never the first hit a search returns — a needle in a fixed set of
 * files, numbered blobs that must be renamed without being rewritten, and three
 * configuration layers with a package-local look-alike.
 * @module dsh-ops/bench/fixtures/tree
 */

import { createHash } from 'node:crypto'

import { drawIndices, hexRun, mulberry32, pad, pick, randInt, WORDS } from './internal.mjs'

/**
 * `grepTree` — a source tree in which a needle token appears in a fixed set of
 * files and nowhere else (PLAN.md §7.1).
 * @param {{seed?: number, dirs?: number, filesPerDir?: number, linesPerFile?: number, needle?: string, needleFiles?: number}} params - the shape of the tree.
 * @returns {{files: {path: string, content: string}[], exports: {matches: string[], needle: string}}} the fixture.
 */
export function grepTree(params = {}) {
  const seed = params.seed ?? 1
  const dirs = params.dirs ?? 10
  const filesPerDir = params.filesPerDir ?? 30
  const linesPerFile = params.linesPerFile ?? 40
  const needle = params.needle ?? 'NEEDLE_X7Q'
  const needleFiles = params.needleFiles ?? 12
  if (needle.includes('\n')) throw new TypeError('needle must be a single line')

  const next = mulberry32(seed)
  const total = dirs * filesPerDir
  const marked = drawIndices(next, total, needleFiles)
  const files = []
  const matches = []

  for (let index = 0; index < total; index += 1) {
    const dir = Math.floor(index / filesPerDir)
    const relPath = `src/dir${pad(dir, 2)}/file${pad(index, 3)}.js`
    const lines = []
    for (let line = 0; line < linesPerFile; line += 1) {
      const ident = `${pick(next, WORDS)}_${pad(index, 3)}_${pad(line, 2)}`
      const kind = randInt(next, 0, 2)
      if (kind === 0) lines.push(`const ${ident} = ${randInt(next, 0, 9999)};`)
      else if (kind === 1) lines.push(`const ${ident} = '${hexRun(next, 6)}';`)
      else lines.push(`// ${ident} ${pick(next, WORDS)}`)
    }
    if (marked.has(index)) {
      lines[randInt(next, 0, linesPerFile - 1)] = `const MARK = "${needle}";`
      matches.push(relPath)
    }
    const content = `// module ${relPath}\n${lines.join('\n')}\n`
    // Invariant, not a nicety: a stray needle would silently change the expected
    // answer, and a missing one would make the task unanswerable.
    if (marked.has(index) && !content.includes(needle)) throw new Error(`needle lost in ${relPath}`)
    if (!marked.has(index) && content.includes(needle)) throw new Error(`needle leaked into ${relPath}`)
    files.push({ path: relPath, content })
  }

  matches.sort()
  if (matches.length !== needleFiles) throw new Error(`expected ${needleFiles} marked files, produced ${matches.length}`)
  return { files, exports: { matches, needle } }
}

/**
 * `renameTree` — a flat directory of numbered `TEMP_*.dat` files (PLAN.md §7.2).
 * The exports carry the SHA-256 of every original file's bytes under its expected
 * post-rename name, so `contentHashes` can prove "renamed, never rewritten": the
 * prompt forbids touching content, and a name-count check alone would accept a
 * model that deleted and recreated files (or truncated them) as a pass.
 * @param {{seed?: number, count?: number, lines?: number}} params - the shape of the tree.
 * @returns {{files: {path: string, content: string}[], exports: {count: number, hashes: {name: string, sha256: string}[]}}} the fixture.
 */
export function renameTree(params = {}) {
  const seed = params.seed ?? 2
  const count = params.count ?? 120
  const linesPerFile = params.lines ?? 5
  const next = mulberry32(seed)
  const files = []
  const hashes = []
  for (let i = 1; i <= count; i += 1) {
    const body = []
    for (let line = 0; line < linesPerFile; line += 1) body.push(hexRun(next, 40))
    const content = `${body.join('\n')}\n`
    files.push({ path: `data/TEMP_${pad(i, 4)}.dat`, content })
    hashes.push({ name: `DATA_${pad(i, 4)}.dat`, sha256: createHash('sha256').update(content, 'utf8').digest('hex') })
  }
  return { files, exports: { count, hashes } }
}

/**
 * `configTree` — a small multi-package repository whose configuration is assembled
 * from three JSON layers, with a package-local file that looks authoritative and is
 * documented as not being merged (PLAN §7.6).
 *
 * This is the "where does this setting actually come from" question, which is daily
 * work in any repository bigger than one file: the answer is not the first value a
 * search finds, it is the value the documented precedence produces. Every layer uses
 * a different number, so a model that greps the key and stops has a 1-in-4 chance and
 * a confident wrong answer; the README is the only place the order is written down.
 * @param {{seed?: number, packages?: number, env?: string}} params - the shape of the repository.
 * @returns {{files: {path: string, content: string}[], exports: {answer: string, value: number, decoy: number, source: string, key: string, env: string}}} the fixture.
 */
export function configTree(params = {}) {
  const seed = params.seed ?? 21
  const packages = params.packages ?? 12
  const env = params.env ?? 'production'
  const key = 'MAX_UPLOAD_MB'
  const next = mulberry32(seed)

  // Three layers plus one decoy, all distinct by construction, so no two files can be
  // mistaken for each other and the expected answer has exactly one source.
  const defaults = randInt(next, 100, 400)
  const envValue = defaults + randInt(next, 50, 200)
  const localValue = envValue + randInt(next, 50, 200)
  const decoy = localValue + randInt(next, 50, 200)

  const files = []
  files.push({
    path: 'README.md',
    content: `# fixture-config

Application configuration is JSON and is loaded in three layers. A key defined in a
later layer replaces the same key from an earlier one:

1. \`config/defaults.json\`
2. \`config/${env}.json\`
3. \`config/${env}.local.json\`

The environment is named by \`APP_ENV\` and defaults to \`development\`.

\`packages/*/config.json\` holds package-local build settings. It is **not** merged
into the application configuration.
`,
  })
  files.push({
    path: 'config/defaults.json',
    content: `${JSON.stringify({ [key]: defaults, CACHE_TTL_S: randInt(next, 10, 600), LOG_LEVEL: 'info' }, null, 2)}\n`,
  })
  files.push({
    path: `config/${env}.json`,
    content: `${JSON.stringify({ [key]: envValue, LOG_LEVEL: 'warn' }, null, 2)}\n`,
  })
  files.push({
    path: `config/${env}.local.json`,
    content: `${JSON.stringify({ [key]: localValue }, null, 2)}\n`,
  })
  // The development layer exists and defines the key too, so a model that ignores
  // APP_ENV still finds a plausible number instead of a missing key.
  files.push({
    path: 'config/development.json',
    content: `${JSON.stringify({ [key]: defaults + 1 }, null, 2)}\n`,
  })

  for (let index = 0; index < packages; index += 1) {
    const name = `${pick(next, ['auth', 'billing', 'search', 'media', 'audit', 'sync'])}-${pad(index, 2)}`
    files.push({
      path: `packages/${name}/config.json`,
      content: `${JSON.stringify({ [key]: decoy, BUILD_TARGET: 'es2022' }, null, 2)}\n`,
    })
    files.push({
      path: `packages/${name}/src/index.js`,
      content: `// ${name}: reads the merged application configuration (see README.md)
export function uploadLimit() {
  return settings.read('${key}')
}
`,
    })
  }

  const sources = { defaults, env: envValue, local: localValue, decoy }
  if (new Set(Object.values(sources)).size !== 4) throw new Error('config layers must all differ')
  return {
    files,
    exports: { answer: String(localValue), value: localValue, decoy, source: `config/${env}.local.json`, key, env, layers: sources },
  }
}

/** Recompute `grepTree`'s `{matches, needle}` by searching the generated tree. */
export function deriveGrepTree(files, needle) {
  const matches = files.filter((file) => file.content.includes(needle)).map((file) => file.path).sort()
  return { matches, needle }
}

/** Recompute `renameTree`'s `{count, hashes}` from the bytes, keyed by the post-rename name. */
export function deriveRenameTree(files) {
  const hashes = [...files]
    .sort((left, right) => (left.path < right.path ? -1 : 1))
    .map((file) => ({
      name: file.path.split('/').pop().replace(/^TEMP_/, 'DATA_'),
      sha256: createHash('sha256').update(file.content, 'utf8').digest('hex'),
    }))
  return { count: files.length, hashes }
}

/**
 * Recompute `configTree`'s winner from `files` and `{key, env}` by applying the
 * documented precedence.
 *
 * Requires at least one package-local config (`packages >= 1`). The decoy value is
 * only ever written into the package-local `config.json` files, so with
 * `packages: 0` there is no byte to read it back from and the derivation is
 * impossible — that is a `RangeError`, never a silent `undefined`.
 * @param {{path: string, content: string}[]} files - the generated tree.
 * @param {{key: string, env: string}} spec - the key and environment the fixture was built for.
 * @returns {object} the recomputed expectation.
 */
export function deriveConfigTree(files, { key, env }) {
  const read = (name) => JSON.parse(files.find((file) => file.path === name)?.content ?? '{}')
  const packages = files.filter((file) => file.path.startsWith('packages/') && file.path.endsWith('/config.json'))
  if (packages.length === 0) {
    throw new RangeError(`deriveConfigTree: no packages/*/config.json in the tree, so the decoy for "${key}" cannot be derived (configTree needs packages >= 1)`)
  }
  const decoy = [...new Set(packages.map((file) => JSON.parse(file.content)[key]))][0]
  const local = read(`config/${env}.local.json`)[key]
  return {
    answer: String(local),
    value: local,
    decoy,
    source: `config/${env}.local.json`,
    key,
    env,
    layers: {
      defaults: read('config/defaults.json')[key],
      env: read(`config/${env}.json`)[key],
      local,
      decoy,
    },
  }
}
