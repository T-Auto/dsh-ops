/**
 * Deterministic workspace generators for the benchmark corpus.
 *
 * Every builder is `(params) => { files, exports }` (PLAN.md §4.2): `files` are
 * `{path, content}` pairs with POSIX-relative paths that `run.mjs` writes into a
 * fresh temporary workspace, and `exports` is the dictionary of expected values
 * the task's `verify` checks reference by name. Nothing is committed to git — the
 * workspace is rebuilt on every run — so the only thing that has to be stable is
 * the bytes that come out of a given `seed`.
 *
 * That is why randomness here is a seeded mulberry32 stream and never `Math.random`
 * or the clock: a corpus that changes shape between the base run and the candidate
 * run would measure the fixture, not the plugin. Each builder also re-checks its
 * own invariants (every declared needle really present, every undeclared file
 * really clean) and throws rather than exporting a number the workspace contradicts.
 *
 * @module dsh-ops/bench/fixtures
 */

import { createHash } from 'node:crypto'

/**
 * mulberry32: a 32-bit seeded PRNG, small enough to inline and stable across
 * engines because it only ever uses `Math.imul` and integer shifts.
 * @param {number} seed - integer seed from the task definition.
 * @returns {() => number} a function returning floats in `[0, 1)`.
 */
export function mulberry32(seed) {
  let state = seed >>> 0
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Inclusive integer draw.
 * @param {() => number} next - the PRNG stream.
 * @param {number} min - lowest value.
 * @param {number} max - highest value.
 * @returns {number} an integer in `[min, max]`.
 */
function randInt(next, min, max) {
  return min + Math.floor(next() * (max - min + 1))
}

/**
 * Uniform element draw.
 * @param {() => number} next - the PRNG stream.
 * @param {unknown[]} from - the pool.
 * @returns {unknown} one element of the pool.
 */
function pick(next, from) {
  return from[Math.floor(next() * from.length)]
}

/**
 * Zero-padded decimal.
 * @param {number} value - the number to render.
 * @param {number} width - the field width.
 * @returns {string} the padded value.
 */
function pad(value, width) {
  return String(value).padStart(width, '0')
}

/**
 * Draw `count` distinct indices from `[0, total)` without sorting the whole pool:
 * a partial Fisher-Yates over the head of the array.
 * @param {() => number} next - the PRNG stream.
 * @param {number} total - the size of the index space.
 * @param {number} count - how many indices to draw.
 * @returns {Set<number>} the drawn indices.
 */
function drawIndices(next, total, count) {
  if (count > total) throw new RangeError(`cannot draw ${count} of ${total} items`)
  const pool = Array.from({ length: total }, (_unused, index) => index)
  const drawn = new Set()
  for (let i = 0; i < count; i += 1) {
    const j = i + Math.floor(next() * (total - i))
    const swap = pool[i]
    pool[i] = pool[j]
    pool[j] = swap
    drawn.add(pool[i])
  }
  return drawn
}

/**
 * Run a generator by name.
 * @param {string} name - the generator name from `fixture.generator`.
 * @param {Record<string, unknown>} [params] - the generator params.
 * @returns {{files: {path: string, content: string}[], exports: Record<string, unknown>}} the fixture.
 */
export function generate(name, params = {}) {
  const builder = GENERATORS[name]
  if (!builder) {
    const known = Object.keys(GENERATORS).sort().join(', ')
    throw new Error(`unknown fixture generator "${name}" (known: ${known})`)
  }
  const fixture = builder(params)
  if (!Array.isArray(fixture?.files)) throw new Error(`generator "${name}" returned no file list`)
  if (fixture.files.some((file) => typeof file?.path !== 'string' || typeof file?.content !== 'string')) {
    throw new Error(`generator "${name}" returned a file entry without string path/content`)
  }
  return { files: fixture.files, exports: fixture.exports ?? {} }
}

/** Lowercase identifier pool for filler text; never contains an uppercase token. */
const WORDS = [
  'alpha', 'bravo', 'cache', 'delta', 'entry', 'final', 'graph', 'host', 'index',
  'json', 'kernel', 'link', 'map', 'node', 'queue', 'route', 'scope', 'token',
  'utf', 'value', 'width', 'yield', 'zero', 'atlas', 'cipher', 'shard', 'vector',
]

/**
 * A run of uppercase hex digits, e.g. `4F2A9C`. Hex alphabet only, so a needle
 * made of letters-and-digits can never appear by accident.
 * @param {() => number} next - the PRNG stream.
 * @param {number} length - how many digits.
 * @returns {string} the run.
 */
function hexRun(next, length) {
  let out = ''
  for (let i = 0; i < length; i += 1) out += '0123456789ABCDEF'[randInt(next, 0, 15)]
  return out
}

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
 * `largeCsv` — one wide CSV plus the exact integer sum of one region's amounts
 * (PLAN.md §7.3). The sum is computed from the same values that are written out,
 * so `answer.txt` has a single defensible expected content.
 * @param {{seed?: number, rows?: number, targetRegion?: string, regions?: string[], maxAmount?: number}} params - the shape of the table.
 * @returns {{files: {path: string, content: string}[], exports: {sum: number, rows: number, targetRegion: string}}} the fixture.
 */
export function largeCsv(params = {}) {
  const seed = params.seed ?? 7
  const rows = params.rows ?? 20000
  const targetRegion = params.targetRegion ?? 'EU'
  const regions = params.regions ?? ['EU', 'US', 'APAC', 'LATAM']
  const maxAmount = params.maxAmount ?? 10000
  if (!regions.includes(targetRegion)) throw new Error(`targetRegion "${targetRegion}" is not in regions`)

  const next = mulberry32(seed)
  const lines = ['id,region,amount']
  let sum = 0
  let hits = 0
  for (let id = 1; id <= rows; id += 1) {
    const region = pick(next, regions)
    const amount = randInt(next, 1, maxAmount)
    if (region === targetRegion) {
      sum += amount
      hits += 1
    }
    lines.push(`${id},${region},${amount}`)
  }
  // Integer arithmetic only: rows * maxAmount stays far below Number.MAX_SAFE_INTEGER.
  if (!Number.isSafeInteger(sum)) throw new Error(`sum ${sum} exceeds safe integer range`)
  return {
    files: [{ path: 'data.csv', content: `${lines.join('\n')}\n` }],
    exports: { sum, rows, hits, targetRegion },
  }
}

/**
 * `brokenProject` — a tiny Node project whose tests fail because of exactly three
 * injected single-line bugs (PLAN.md §7.4). The generator returns both the broken
 * sources (written to the workspace) and the fixed ones (`exports.fixes`), which
 * is what lets `test/bench.test.mjs` prove the other half of the invariant: a
 * correct repair really does turn the suite green.
 * @param {{seed?: number}} params - the project seed.
 * @returns {{files: {path: string, content: string}[], exports: {testSource: string, fixes: {path: string, content: string}[]}}} the fixture.
 */
export function brokenProject(params = {}) {
  const seed = params.seed ?? 11
  const next = mulberry32(seed)
  // Seed only decides which harmless filler the project carries, so two different
  // corpora cannot share a bug layout by accident.
  const label = pick(next, ['inventory', 'shipping', 'ledger'])

  const manifest = {
    name: `fixture-${label}`,
    private: true,
    version: '0.0.0',
    type: 'module',
    scripts: { test: 'node test.js' },
  }

  const testSource = `import assert from 'node:assert/strict'
import { countItems, sumValues } from './src/counter.js'
import { discountPercent, lineTotal } from './src/pricing.js'
import { normalizeNames } from './src/normalize.js'

const items = [{ value: 2 }, { value: 3 }, { value: 4 }]

assert.equal(countItems(items), 3, 'countItems counts the entries it was given')
assert.equal(countItems([]), 0, 'countItems of nothing is nothing')
assert.equal(sumValues(items), 9, 'sumValues adds the values')
assert.equal(discountPercent(9), 0, 'below the threshold there is no discount')
assert.equal(discountPercent(10), 10, 'the threshold itself earns the discount')
assert.equal(lineTotal(100, 10), 900, 'a discounted line total keeps its rounding')
assert.deepEqual(normalizeNames([' Ada ', 'BOB', '']), ['ada', 'bob'], 'names are trimmed, lowered and emptied away')
assert.deepEqual(normalizeNames([]), [], 'nothing normalizes to nothing')

console.log('ok')
`

  const fixedCounter = `export function countItems(list) {
  let total = 0
  for (let i = 0; i < list.length; i += 1) {
    total += 1
  }
  return total
}

export function sumValues(list) {
  let sum = 0
  for (const item of list) {
    sum += item.value
  }
  return sum
}
`

  const fixedPricing = `export function discountPercent(quantity) {
  if (quantity >= 10) {
    return 10
  }
  return 0
}

export function lineTotal(price, quantity) {
  return price * quantity - (price * quantity * discountPercent(quantity)) / 100
}
`

  const fixedNormalize = `export function normalizeNames(raw) {
  return raw
    .map((name) => name.trim())
    .filter((name) => name !== '')
    .map((name) => name.toLowerCase())
}
`

  // Three single-line defects, each a whole-line swap so the model sees one
  // obvious bug per file rather than a refactoring exercise. `pristine` is the
  // line as it appears in the fixed source above; the generator refuses to build
  // a project where that anchor line has gone missing.
  const bugs = [
    {
      path: 'src/counter.js',
      fixed: fixedCounter,
      pristine: '  for (let i = 0; i < list.length; i += 1) {',
      brokenLine: '  for (let i = 0; i <= list.length; i += 1) {',
    },
    {
      path: 'src/pricing.js',
      fixed: fixedPricing,
      pristine: '  if (quantity >= 10) {',
      brokenLine: '  if (quantity > 10) {',
    },
    {
      path: 'src/normalize.js',
      fixed: fixedNormalize,
      pristine: '    .map((name) => name.trim())',
      brokenLine: '    .map((name) => name)',
    },
  ]

  const files = [
    { path: 'package.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
    { path: 'test.js', content: testSource },
  ]
  for (const bug of bugs) files.push({ path: bug.path, content: breakLine(bug) })
  return {
    files,
    exports: {
      testSource,
      fixes: bugs.map((bug) => ({ path: bug.path, content: bug.fixed })),
    },
  }
}

/**
 * Render one source file with its single defect injected.
 * @param {{path: string, fixed: string, pristine: string, brokenLine: string}} bug - the bug declaration.
 * @returns {string} the broken source.
 */
function breakLine(bug) {
  const lines = bug.fixed.split('\n')
  const at = lines.indexOf(bug.pristine)
  if (at === -1 || lines.indexOf(bug.pristine, at + 1) !== -1) {
    throw new Error(`bug anchor is not unique in ${bug.path}: ${bug.pristine}`)
  }
  lines[at] = bug.brokenLine
  return lines.join('\n')
}

/**
 * `logStats` — a directory of log files plus the per-file count of `ERROR` lines
 * (PLAN.md §7.5). Message bodies are lowercase, so "lines containing ERROR" and
 * "lines whose level is ERROR" are the same set: the expected answer cannot be
 * read two ways.
 * @param {{seed?: number, files?: number, linesPerFile?: number}} params - the shape of the logs.
 * @returns {{files: {path: string, content: string}[], exports: {report: string[], files: number}}} the fixture.
 */
export function logStats(params = {}) {
  const seed = params.seed ?? 13
  const fileCount = params.files ?? 50
  const linesPerFile = params.linesPerFile ?? 400
  const levels = ['INFO', 'INFO', 'INFO', 'DEBUG', 'WARN', 'ERROR']

  const next = mulberry32(seed)
  const files = []
  const report = []
  for (let index = 0; index < fileCount; index += 1) {
    const name = `app_${pad(index, 2)}.log`
    let errors = 0
    const lines = []
    for (let line = 0; line < linesPerFile; line += 1) {
      const level = pick(next, levels)
      const stamp = `2025-03-${pad((index % 28) + 1, 2)}T${pad(line % 24, 2)}:${pad(line % 60, 2)}:${pad((line * 7) % 60, 2)}Z`
      const body = `${pick(next, WORDS)} ${pick(next, WORDS)} ${hexRun(next, 8).toLowerCase()}`
      if (level === 'ERROR') errors += 1
      lines.push(`${level}|${stamp}|${body}`)
    }
    const content = `${lines.join('\n')}\n`
    if (content.split('\n').some((line) => line.split('|')[0] !== 'ERROR' && line.includes('ERROR'))) {
      throw new Error(`ambiguous ERROR text in ${name}`)
    }
    files.push({ path: `logs/${name}`, content })
    report.push(`${name} ${errors}`)
  }
  return { files, exports: { report, files: fileCount } }
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

/**
 * `deepModule` — one long source file in which the answer needs two distant ranges:
 * a lookup table in the middle and the function that reads it at the very end
 * (PLAN §7.7).
 *
 * The point is the shape of the file, not its content: a 4,000-line module whose
 * answer is in the fortieth and the four-thousandth line punishes reading from the
 * top and rewards locating a range and reading only that range. A stale comment and a
 * superseded table carry the wrong numbers, so a single grep for the function name
 * still leaves a decision to make.
 * @param {{seed?: number, lines?: number, env?: string, fnName?: string}} params - the shape of the module.
 * @returns {{files: {path: string, content: string}[], exports: {answer: string, value: number, stale: number, legacy: number, fnName: string, env: string, tableName: string}}} the fixture.
 */
export function deepModule(params = {}) {
  const seed = params.seed ?? 23
  const lines = Math.max(400, params.lines ?? 4200)
  const env = params.env ?? 'staging'
  const fnName = params.fnName ?? 'auditLimit'
  const tableName = 'LIMIT_TABLE'
  const legacyTable = 'LEGACY_LIMIT_TABLE'
  const envs = ['dev', 'staging', 'prod']
  const next = mulberry32(seed)

  const values = { dev: randInt(next, 10, 90), staging: randInt(next, 100, 190), prod: randInt(next, 200, 290) }
  // The stale numbers must differ from the live ones, or the decoys would not be wrong.
  const legacy = { dev: values.dev + 1, staging: values.staging + 1, prod: values.prod + 1 }
  const stale = values[env] + 7

  const tableAt = Math.floor(lines * 0.55)
  const fnAt = lines - 12
  const body = []
  for (let line = 0; line < lines; line += 1) body.push(null)

  const renderTable = (name, table) => [
    `const ${name} = Object.freeze({`,
    ...envs.map((name2) => `  ${name2}: ${table[name2]},`),
    '})',
  ]
  const put = (at, block) => {
    for (let offset = 0; offset < block.length; offset += 1) {
      if (at + offset >= body.length) throw new Error(`${tableName}: block overflows the file`)
      body[at + offset] = block[offset]
    }
  }

  // Every filler line is a complete statement, so the generated module is valid
  // JavaScript a model can actually run if it wants to.
  const filler = () => {
    const kind = randInt(next, 0, 3)
    const ident = `${pick(next, WORDS)}_${hexRun(next, 4).toLowerCase()}`
    if (kind === 0) return `// ${ident} ${pick(next, WORDS)} ${pick(next, WORDS)}`
    if (kind === 1) return `export function ${ident}(input) { return input ${pick(next, ['+', '-', '*'])} ${randInt(next, 1, 99)} }`
    if (kind === 2) return `export const ${ident} = (input) => input.length ${pick(next, ['>=', '<=', '==='])} ${randInt(next, 0, 9)}`
    return `const ${ident} = ${randInt(next, 1, 9999)}`
  }

  for (let line = 0; line < lines; line += 1) {
    if (body[line] === null) body[line] = filler()
  }
  put(0, ['// src/pipeline.js — generated module', '// Mechanical filler only: the interesting parts are marked.', ''])
  put(4, [`// Historical note: ${env} used to allow ${stale} concurrent uploads per`, '// account. The number below is the one that is actually read at start-up.'])
  put(tableAt, [
    `// Superseded by ${tableName}; kept because the migration tool still reads it.`,
    ...renderTable(legacyTable, legacy),
    '',
    `// The table ${fnName}() reads.`,
    ...renderTable(tableName, values),
  ])
  put(fnAt, [
    `/**`,
    ` * The per-account upload limit for one environment.`,
    ` * @param {string} environment - dev, staging or prod.`,
    ` * @returns {number} the limit, or undefined for an unknown environment.`,
    ` */`,
    `export function ${fnName}(environment) {`,
    `  return ${tableName}[environment]`,
    `}`,
    '',
  ])

  const content = `${body.join('\n')}\n`
  const value = values[env]
  // Invariants: exactly one live table, the function reads it, and the decoys really
  // carry different numbers — otherwise the task has more than one defensible answer.
  if (content.split(`const ${tableName} = Object.freeze({`).length !== 2) throw new Error(`${tableName} must be defined exactly once`)
  if (!content.includes(`export function ${fnName}(environment) {\n  return ${tableName}[environment]`)) throw new Error(`${fnName} must read ${tableName}`)
  if (!content.includes(`  ${env}: ${value},\n`)) throw new Error(`the live table is missing ${env}`)
  if (new Set([value, legacy[env], stale]).size !== 3) throw new Error('the answer and both decoys must differ')
  return {
    files: [{ path: 'src/pipeline.js', content }],
    exports: { answer: String(value), value, stale, legacy: legacy[env], fnName, env, tableName, lines: body.length },
  }
}

/**
 * `noisySuite` — a test runner that prints thousands of passing lines, one failure,
 * and exits non-zero (PLAN §7.8).
 *
 * Triage from a noisy log is an everyday shape: the answer is one line in a wall of
 * them, and the cost is proportional to how much of the wall reaches the context. The
 * failing test's name is unique across the suite, and it is the only `not ok` line,
 * so the answer is exact and a guess cannot pass.
 * @param {{seed?: number, tests?: number, failAt?: number}} params - the shape of the run.
 * @returns {{files: {path: string, content: string}[], exports: {failingName: string, failingIndex: number, tests: number}}} the fixture.
 */
export function noisySuite(params = {}) {
  const seed = params.seed ?? 29
  const tests = Math.max(200, params.tests ?? 2400)
  const failAt = params.failAt ?? Math.floor(tests * 0.62)
  if (!Number.isInteger(failAt) || failAt < 0 || failAt >= tests) throw new Error('failAt must be a valid index')
  const next = mulberry32(seed)

  const names = []
  const seen = new Set()
  for (let index = 0; index < tests; index += 1) {
    let name = `${pick(next, ['handles', 'rejects', 'round-trips', 'skips', 'coalesces', 'normalises'])} ${pick(next, WORDS)} ${hexRun(next, 6).toLowerCase()}`
    while (seen.has(name)) name = `${name}-${hexRun(next, 2).toLowerCase()}`
    seen.add(name)
    names.push(name)
  }
  names[failAt] = `${names[failAt]} when the queue is drained`
  if (seen.has(names[failAt]) && names.filter((name) => name === names[failAt]).length !== 1) throw new Error('the failing test name must be unique')
  const failingName = names[failAt]
  if (names.filter((name) => name === failingName).length !== 1) throw new Error('the failing test name must be unique')
  if (names.some((name) => name !== failingName && name.includes(failingName))) throw new Error('no passing name may contain the failing name')
  if (names.some((name) => name.includes('not ok'))) throw new Error('a test name must not contain the failure marker')

  const module = `${pick(next, ['queue', 'scheduler', 'ingest'])}`
  const runner = `// generated suite — do not edit
const TESTS = ${JSON.stringify(names, null, 2)}

const FAILING_INDEX = ${failAt}
const FAILING_MODULE = 'src/${module}.js'

let failed = 0
for (let index = 0; index < TESTS.length; index += 1) {
  const name = TESTS[index]
  if (index % 250 === 0) console.log(\`# progress \${index}/\${TESTS.length}\`)
  if (index === FAILING_INDEX) {
    failed += 1
    console.log(\`not ok \${index + 1} - \${name}\`)
    console.log('  ---')
    console.log('  message: \"AssertionError: expected the queue to drain in 250 ms\"')
    console.log(\`  file: \${FAILING_MODULE}\`)
    console.log('    actual: 41')
    console.log('    expected: 0')
    console.log('  ...')
    continue
  }
  console.log(\`ok \${index + 1} - \${name}\`)
}
console.log(\`# \${TESTS.length - failed} passed, \${failed} failed\`)
process.exitCode = failed === 0 ? 0 : 1
`
  return {
    files: [
      { path: 'runner.js', content: runner },
      { path: `src/${module}.js`, content: `// ${module} module under test\nexport const IN_FLIGHT = 41\n` },
    ],
    exports: { failingName, failingIndex: failAt, tests },
  }
}

/**
 * `symbolTree` — one exported function used from forty files, with two look-alike
 * exports that must survive the rename untouched (PLAN §7.9).
 *
 * A mechanical rename is a rename of a *symbol*, not of a string: `parsePayload` and
 * `parsePayloadLegacy` share a prefix, `parsePayloadAsync` shares it and calls the
 * function being renamed, and a file exists that touches only the look-alike. The
 * verdict is the byte-exact final content of every file in `src/`, so a rename that
 * also catches a look-alike fails, and so does a rename that misses one call site.
 * @param {{seed?: number, files?: number, from?: string, to?: string}} params - the shape of the tree.
 * @returns {{files: {path: string, content: string}[], exports: {final: {name: string, sha256: string}[], fixedFiles: {path: string, content: string}[], from: string, to: string}}} the fixture.
 */
export function symbolTree(params = {}) {
  const seed = params.seed ?? 31
  const fileCount = Math.max(3, params.files ?? 40)
  const from = params.from ?? 'parsePayload'
  const to = params.to ?? 'decodePayload'
  if (from === to) throw new Error('from and to must differ')
  const legacy = `${from}Legacy`
  const asyncName = `${from}Async`
  const next = mulberry32(seed)

  const core = (renamed) => `// core: payload decoding
export function ${renamed ? to : from}(raw) {
  if (typeof raw !== 'string') {
    return []
  }
  return raw.split(',').map((part) => part.trim()).filter((part) => part !== '')
}

export function ${legacy}(raw) {
  return String(raw).split(',')
}

export function ${asyncName}(raw) {
  return Promise.resolve(${renamed ? to : from}(raw))
}
`

  // One descriptor per file, rendered twice: the broken version and the renamed one
  // must share a path and a body shape, or the fixture would compare two files that
  // were never the same file.
  const modules = []
  for (let index = 0; index < fileCount; index += 1) {
    const kind = index % 5
    const name = `${pick(next, ['reader', 'writer', 'mapper', 'sorter', 'joiner'])}_${pad(index, 3)}`
    const body = kind === 4
      ? (call) => `  return ${legacy}(input).length`
      : (call) => `  return { parts: ${call}(input), legacy: ${legacy}(input).length }`
    modules.push({
      path: `src/${name}.js`,
      render: (renamed) => {
        const call = renamed ? to : from
        const imports = kind === 4
          ? `import { ${legacy} } from './core.js'`
          : `import { ${call}, ${legacy} } from './core.js'`
        return `${imports}

export function ${name}(input) {
${body(call)}
}
`
      },
      touched: kind !== 4,
    })
  }

  const broken = { 'src/core.js': core(false) }
  const fixed = { 'src/core.js': core(true) }
  for (const module of modules) {
    broken[module.path] = module.render(false)
    fixed[module.path] = module.render(true)
  }

  // The invariant: the look-alikes exist, at least one file never touches the symbol
  // being renamed, and the rename really changes bytes in every file that does.
  if (!broken['src/core.js'].includes(legacy) || !broken['src/core.js'].includes(asyncName)) throw new Error('the look-alike exports must exist')
  const untouched = Object.keys(broken).filter((path) => broken[path] === fixed[path])
  if (untouched.length < 1) throw new Error('at least one file must be unaffected by the rename')
  for (const path of modules.filter((module) => module.touched).map((module) => module.path)) {
    if (broken[path] === fixed[path]) throw new Error(`the rename must change ${path}`)
  }
  if (fixed['src/core.js'].includes(`export function ${from}(`)) throw new Error('the renamed definition must be gone')

  const final = Object.keys(fixed).sort().map((name) => ({
    name: name.split('/').pop(),
    sha256: createHash('sha256').update(fixed[name], 'utf8').digest('hex'),
  }))
  const check = `import assert from 'node:assert/strict'
import { ${to} } from './src/core.js'

assert.deepEqual(${to}(' a, b ,c '), ['a', 'b', 'c'])
assert.deepEqual(${to}(''), [])
assert.deepEqual(${to}(null), [])
console.log('ok')
`
  return {
    files: [...Object.keys(broken).map((path) => ({ path, content: broken[path] })), { path: 'check.mjs', content: check }],
    exports: {
      final,
      fixedFiles: Object.keys(fixed).sort().map((path) => ({ path, content: fixed[path] })),
      from,
      to,
      files: fileCount,
    },
  }
}

/**
 * The rule sheet `deepCorpus` ships as `README.md`: the only place the precedence
 * between an index page and a ledger page is written down.
 *
 * It is prose on purpose. The model has to read it, then apply it once per shard —
 * the corpus is far too large to carry around, so the rule has to survive as a rule.
 */
const SETTLEMENT_README = `# Settlement corpus

\`shards/shard-NN.md\` is one shard review. Every review carries four sections in
order: \`## Charter\`, \`## Index\`, \`## Ledger\` and \`## Archive\`.

A review's **live settlement** is the single \`SETTLE\` line in its \`## Ledger\` whose
\`page=\` number is the highest page listed in that review's \`## Index\`. A \`SETTLE\`
line whose page is missing from the index is a page carried over from an earlier
settlement run and does not count. Pages listed in the index that have no ledger
line carry no amount.

\`VOID SETTLE\` lines are cancellations. They never count, whatever page they name.

The amount of a live settlement is the \`amount=\` value on that line.
`

/**
 * `deepCorpus` — a 256K-token corpus in which every shard has to be visited
 * (PLAN §7.10).
 *
 * The point is the size of the covered set, not of one file: the answer is one line
 * per shard, and no line can be written without opening its shard, so answering at
 * all costs the whole corpus. At ~256K tokens the "read everything into context"
 * strategy no longer fits a 256K window (dsh compacts at 0.8 × contextWindow and
 * keeps 16%), so this measures **bounded traversal** at the size where traversal is
 * the only option: locate the live settlement in each shard, carry two fields
 * forward, and leave the rest of the bytes behind.
 *
 * Each shard is deliberately two-fact: the live page is the maximum of the shuffled
 * `## Index` list, while the `## Ledger` also carries a stale page *above* that
 * maximum and a low unindexed page — so "the first SETTLE line", "the highest page
 * anywhere in the file" and "the highest page in the ledger" are all wrong answers,
 * and only the index decides. Bulk prose fills ~95% of every shard, and it can
 * never contain a marker (the word pool is lowercase), so a search for the structured
 * lines is exact.
 * @param {{seed?: number, shards?: number, charsPerShard?: number, pagesPerShard?: number}} params - the shape of the corpus.
 * @returns {{files: {path: string, content: string}[], exports: {report: string[], shards: number, chars: number}}} the fixture.
 */
export function deepCorpus(params = {}) {
  const seed = params.seed ?? 41
  const shardCount = Math.max(2, params.shards ?? 32)
  const charsPerShard = Math.max(4000, params.charsPerShard ?? 30000)
  const pagesPerShard = Math.max(4, params.pagesPerShard ?? 10)
  const next = mulberry32(seed)
  const width = String(shardCount - 1).length
  const usedAmounts = new Set()

  // Distinct amounts across the whole corpus: no shard's answer can be guessed from
  // another shard's, and a repeated amount cannot mask a mis-joined page.
  const amount = () => {
    let value
    do {
      value = randInt(next, 1000, 99999)
    } while (usedAmounts.has(value))
    usedAmounts.add(value)
    return value
  }

  const note = () => `${pick(next, WORDS)} ${pick(next, WORDS)} ${pick(next, WORDS)}.`
  // Bulk filler: lowercase sentences only, so the markers stay exactly countable.
  const prose = (budget) => {
    const lines = []
    let used = 0
    while (used < budget) {
      const text = `${pick(next, WORDS)} ${pick(next, WORDS)} ${pick(next, WORDS)} ${pick(next, WORDS)} ${pick(next, WORDS)}.`
      lines.push(text)
      used += text.length + 1
      if (lines.length % 6 === 0) {
        lines.push('')
        used += 1
      }
    }
    return lines
  }

  const files = []
  const report = []
  let chars = 0

  for (let index = 0; index < shardCount; index += 1) {
    const name = `shard-${pad(index, width)}`
    const pool = new Set()
    while (pool.size < pagesPerShard) pool.add(randInt(next, 100, 9999))
    const indexed = [...pool].sort((a, b) => a - b)
    const livePage = indexed[indexed.length - 1]
    // Shuffled, so the live page is not simply the last index entry.
    const shuffled = [...indexed]
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1))
      const swap = shuffled[i]
      shuffled[i] = shuffled[j]
      shuffled[j] = swap
    }
    const decoyPage = indexed[Math.max(0, randInt(next, 0, indexed.length - 2))]
    const stalePage = livePage + randInt(next, 20, 200)
    const lowPage = Math.max(1, indexed[0] - randInt(next, 10, 60))

    const liveAmount = amount()
    const ledger = [
      `- SETTLE ${name} page=${livePage} amount=${liveAmount}`,
      `- SETTLE ${name} page=${decoyPage} amount=${amount()}`,
      `- SETTLE ${name} page=${stalePage} amount=${amount()}`,
      `- SETTLE ${name} page=${lowPage} amount=${amount()}`,
    ]
    for (let i = ledger.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1))
      const swap = ledger[i]
      ledger[i] = ledger[j]
      ledger[j] = swap
    }
    const voids = [
      `- VOID SETTLE ${name} page=${stalePage + randInt(next, 5, 90)} amount=${amount()}`,
      `- VOID SETTLE ${name} page=${randInt(next, 10000, 99999)} amount=${amount()}`,
    ]

    const charterBudget = Math.floor(charsPerShard * 0.58)
    const archiveBudget = Math.max(1000, charsPerShard - charterBudget - 1200)
    const content = [
      `# ${name} — settlement review`,
      '',
      '## Charter',
      '',
      ...prose(charterBudget),
      '',
      '## Index',
      '',
      ...shuffled.map((page) => `- page ${page} — ${note()} ${note()}`),
      '',
      '## Ledger',
      '',
      ...ledger,
      '',
      '## Archive',
      '',
      ...prose(archiveBudget),
      '',
      ...voids,
      '',
    ].join('\n')

    // Invariants: the live page is the index maximum, exactly one ledger line names
    // it, and no marker leaked into the prose — otherwise the expected report would
    // not be the only defensible answer.
    const settlements = content.split('\n').filter((line) => line.startsWith('- SETTLE '))
    if (settlements.length !== 4) throw new Error(`${name}: expected 4 SETTLE lines, wrote ${settlements.length}`)
    if (settlements.filter((line) => line.includes(`page=${livePage} `)).length !== 1) {
      throw new Error(`${name}: the live page ${livePage} must be named exactly once`)
    }
    if (settlements.some((line) => line.startsWith('- SETTLE ') && !line.includes(` ${name} `))) {
      throw new Error(`${name}: a SETTLE line names another shard`)
    }
    if (content.split('SETTLE').length !== 7) {
      throw new Error(`${name}: expected exactly 6 SETTLE markers (4 ledger + 2 void)`)
    }
    if (new Set([livePage, decoyPage, stalePage, lowPage]).size !== 4) throw new Error(`${name}: the four candidate pages must differ`)
    if (indexed.includes(stalePage) || indexed.includes(lowPage)) throw new Error(`${name}: the decoy pages must be unindexed`)

    files.push({ path: `shards/${name}.md`, content })
    chars += content.length
    report.push(`${name} ${liveAmount}`)
  }

  return { files: [...files, { path: 'README.md', content: SETTLEMENT_README }], exports: { report, shards: shardCount, chars } }
}

/**
 * The arithmetic templates a pipeline stage may use (PLAN §7.12).
 *
 * `contract`, `bindings`, `expression` and `reference` all describe the same
 * transform, so one stage can be rendered twice from one spec: once as the true
 * implementation and once with exactly one bound constant changed. Keeping the two
 * renders in one place is what makes "exactly one defect, well-posed repair" a
 * property of the generator instead of a promise in a comment.
 */
const GATE_TEMPLATES = {
  addScaleMod: {
    fields: ['a', 'b', 'span'],
    contract: (spec) => `add ${spec.a} to the accumulator, multiply the sum by ${spec.b}, then reduce modulo ${spec.span}`,
    bindings: (spec) => [['offset', spec.a], ['scale', spec.b], ['span', spec.span]],
    expression: '((value + offset) * scale) % span',
    reference: (spec) => (value) => ((value + spec.a) * spec.b) % spec.span,
  },
  scaleAddMod: {
    fields: ['a', 'b', 'span'],
    contract: (spec) => `multiply the accumulator by ${spec.a}, add ${spec.b}, then reduce modulo ${spec.span}`,
    bindings: (spec) => [['factor', spec.a], ['offset', spec.b], ['span', spec.span]],
    expression: '((value * factor) + offset) % span',
    reference: (spec) => (value) => ((value * spec.a) + spec.b) % spec.span,
  },
  twistMod: {
    fields: ['a', 'b', 'c', 'span'],
    contract: (spec) => `add ${spec.a} to the accumulator, multiply the sum by ${spec.b}, add ${spec.c}, then reduce modulo ${spec.span}`,
    bindings: (spec) => [['offset', spec.a], ['scale', spec.b], ['twist', spec.c], ['span', spec.span]],
    expression: '(((value + offset) * scale) + twist) % span',
    reference: (spec) => (value) => (((value + spec.a) * spec.b) + spec.c) % spec.span,
  },
}

/**
 * One inert scaffolding line for a stage module. Every identifier carries the gate
 * and line index, so two filler lines can never collide into a duplicate
 * declaration, and no filler line can be mistaken for the stage's real work.
 * @param {() => number} next - the PRNG stream.
 * @param {number} gateIndex - the stage index.
 * @param {number} lineIndex - the line index within the stage.
 * @returns {string} one line of valid module-scope JavaScript.
 */
function gateFillerLine(next, gateIndex, lineIndex) {
  const ident = `${pick(next, WORDS)}_${hexRun(next, 4).toLowerCase()}_${gateIndex}_${lineIndex}`
  const kind = randInt(next, 0, 3)
  if (kind === 0) return `// ${ident} ${pick(next, WORDS)} ${pick(next, WORDS)} - inert scaffolding`
  if (kind === 1) return `const ${ident} = ${randInt(next, 1, 9999)}`
  if (kind === 2) return `function ${ident}(input) { return input ${pick(next, ['+', '-', '*'])} ${randInt(next, 1, 99)} }`
  return `const ${ident} = (input) => input ${pick(next, ['>=', '<=', '==='])} ${randInt(next, 0, 9)}`
}

/**
 * Render one stage module. The contract line always describes the *true* spec; only
 * the bound constants come from `codeSpec`. That is how a stage carries exactly one
 * defect while still documenting the behavior it is supposed to have — the repair is
 * "make the code agree with the contract", never "guess what the author meant".
 * @param {{name: string, index: number, template: object, spec: object, codeSpec: object, filler: string[]}} stage - the render inputs.
 * @returns {string} the module source.
 */
function renderGateModule({ name, index, template, spec, codeSpec, filler }) {
  return [
    `// ${name} - stage ${index} of the release pipeline.`,
    '//',
    `// Contract: ${template.contract(spec)}.`,
    '// The stage is pure: it returns the new accumulator and touches no other state.',
    '',
    ...filler,
    '',
    'export function run(value) {',
    ...template.bindings(codeSpec).map(([binding, value]) => `  const ${binding} = ${value}`),
    `  return ${template.expression}`,
    '}',
    '',
  ].join('\n')
}

/**
 * Draw a one-constant variant of a stage spec that really disagrees with the true
 * spec on at least one probe. Fields are tried in a fixed order, so the defect a
 * given seed produces is stable, and a spec that cannot be broken throws instead of
 * shipping a stage that already passes.
 * @param {() => number} next - the PRNG stream.
 * @param {object} spec - the true spec.
 * @param {object} template - its template.
 * @param {number[]} probes - the probe inputs.
 * @returns {object} the broken spec.
 */
function breakGateConstant(next, spec, template, probes) {
  const reference = template.reference(spec)
  for (const field of template.fields) {
    const delta = field === 'span' ? randInt(next, 11, 97) : randInt(next, 1, 9)
    const candidate = { ...spec, [field]: spec[field] + delta }
    if (probes.some((probe) => template.reference(candidate)(probe) !== reference(probe))) return candidate
  }
  throw new Error(`gatePipeline: could not break a ${spec.kind} stage`)
}

/**
 * `gatePipeline` — a fail-fast release gate over many stage modules, each carrying
 * exactly one defect (PLAN §7.12).
 *
 * This is the corpus's **long-run** shape, and it is a different question from the
 * 256K tier: there the workspace is enormous and the transcript has to stay small,
 * here the workspace is small and the *number of turns* is large. `check.js` loads
 * the stages in order, validates each against golden values, and stops at the first
 * disagreement — so one repaired stage buys exactly one stage of progress, and
 * twenty-four stages cost at least twenty-four runs. Each run prints a fresh block
 * of passing lines, so what compounds across the run is the per-request cost of
 * every step: the same tool surface, re-sent on each of dozens of turns, plus
 * whatever the previous runs' output left in the history.
 *
 * Two details keep the repair well-posed rather than a guessing game. Every stage's
 * contract is written in the stage module itself (what it adds, multiplies and
 * reduces by) while the *code* binds a different constant, so the fix is to make the
 * two agree. And the chain seed is never one of the probes, so a stage that hardcodes
 * the golden values instead of implementing the contract still produces the wrong
 * final value — which is exactly what `answer.txt` is checked against.
 * @param {{seed?: number, gates?: number, probes?: number, linesPerGate?: number, seedValue?: number}} params - the shape of the pipeline.
 * @returns {{files: {path: string, content: string}[], exports: Record<string, unknown>}} the fixture.
 */
export function gatePipeline(params = {}) {
  const seed = params.seed ?? 53
  const gateCount = Math.max(2, params.gates ?? 24)
  const probeCount = Math.max(2, params.probes ?? 12)
  const fillerLines = Math.max(0, params.linesPerGate ?? 70)
  const seedValue = params.seedValue ?? 7
  const next = mulberry32(seed)
  const width = String(gateCount - 1).length

  // The chain input is never a probe: a stage that memorises golden outputs fails
  // the final value instead of sneaking through the per-stage checks.
  const probes = []
  const probeTaken = new Set([seedValue])
  while (probes.length < probeCount) {
    const value = randInt(next, 2, 97)
    if (probeTaken.has(value)) continue
    probeTaken.add(value)
    probes.push(value)
  }

  const kinds = ['addScaleMod', 'scaleAddMod', 'twistMod']
  const gates = []
  for (let index = 0; index < gateCount; index += 1) {
    const kind = kinds[index % kinds.length]
    const template = GATE_TEMPLATES[kind]
    const spec = { kind, a: randInt(next, 3, 41), b: randInt(next, 2, 9), c: randInt(next, 2, 61), span: randInt(next, 900, 9000) }
    const filler = []
    for (let line = 0; line < fillerLines; line += 1) filler.push(gateFillerLine(next, index, line))
    const codeSpec = breakGateConstant(next, spec, template, probes)
    const name = `gate_${pad(index, width)}`
    const fixed = renderGateModule({ name, index, template, spec, codeSpec: spec, filler })
    const broken = renderGateModule({ name, index, template, spec, codeSpec, filler })
    // The one-defect promise, checked instead of asserted in prose: the two renders
    // differ on exactly one line, and that line is a bound constant.
    const fixedLines = fixed.split('\n')
    const brokenLines = broken.split('\n')
    const changed = fixedLines.filter((line, at) => line !== brokenLines[at])
    if (changed.length !== 1) throw new Error(`${name}: expected exactly one changed line, got ${changed.length}`)
    if (!/^  const \w+ = \d+$/.test(changed[0])) throw new Error(`${name}: the defect must be a bound constant, got "${changed[0]}"`)
    gates.push({ name, spec, broken, fixed })
  }

  const golden = gates.map((gate) => probes.map((probe) => GATE_TEMPLATES[gate.spec.kind].reference(gate.spec)(probe)))
  let value = seedValue
  for (const gate of gates) value = GATE_TEMPLATES[gate.spec.kind].reference(gate.spec)(value)
  if (probes.includes(seedValue)) throw new Error('gatePipeline: the chain seed must not be a probe')
  if (gates.length === 0) throw new Error('gatePipeline: a pipeline needs at least one stage')

  const imports = gates.map((gate) => `import { run as ${gate.name} } from './gates/${gate.name}.js'`)
  const checkSource = [
    '// release gate - generated file, do not edit',
    ...imports,
    '',
    `const PROBES = ${JSON.stringify(probes)}`,
    `const GOLDEN = ${JSON.stringify(golden)}`,
    `const SEED = ${seedValue}`,
    `const NAMES = ${JSON.stringify(gates.map((gate) => gate.name))}`,
    `const GATES = [${gates.map((gate) => gate.name).join(', ')}]`,
    '',
    "console.log('# release gate')",
    `console.log('# ${gates.length} stage(s), ${probes.length} probe(s) each, chain seed ' + SEED)`,
    "console.log('# every stage must match its golden values before the next stage runs')",
    '',
    'let value = SEED',
    'let stoppedAt = null',
    'outer: for (let index = 0; index < GATES.length; index += 1) {',
    '  const name = NAMES[index]',
    '  for (let probeIndex = 0; probeIndex < PROBES.length; probeIndex += 1) {',
    '    const probe = PROBES[probeIndex]',
    '    const actual = GATES[index](probe)',
    '    const expected = GOLDEN[index][probeIndex]',
    '    if (actual !== expected) {',
    '      console.log(`not ok ${index + 1} - ${name} probe ${probe}`)',
    "      console.log('  ---')",
    '      console.log(`  message: "AssertionError: ${name}(${probe}) returned ${actual}, expected ${expected}"`)',
    '      console.log(`  file: gates/${name}.js`)',
    '      console.log(`    actual: ${actual}`)',
    '      console.log(`    expected: ${expected}`)',
    "      console.log('  ...')",
    '      stoppedAt = name',
    '      break outer',
    '    }',
    '    console.log(`ok ${index + 1} - ${name} probe ${probe}`)',
    '  }',
    '  value = GATES[index](value)',
    '}',
    'if (stoppedAt !== null) {',
    '  console.log(`# stopped at ${stoppedAt}`)',
    '  process.exitCode = 1',
    '} else {',
    '  console.log(`# ${GATES.length} stage(s) passed`)',
    '  console.log(`# final value ${value}`)',
    '}',
    '',
  ].join('\n')

  const manifest = {
    name: 'fixture-gate-pipeline',
    private: true,
    version: '0.0.0',
    type: 'module',
    scripts: { gate: 'node check.js' },
  }

  return {
    files: [
      ...gates.map((gate) => ({ path: `gates/${gate.name}.js`, content: gate.broken })),
      { path: 'check.js', content: checkSource },
      { path: 'package.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
    ],
    exports: {
      answer: String(value),
      final: value,
      checkSource,
      gates: gateCount,
      probes,
      fixes: gates.map((gate) => ({ path: `gates/${gate.name}.js`, content: gate.fixed })),
    },
  }
}

/** The generator registry: `fixture.generator` in a task file names one of these. */
export const GENERATORS = { grepTree, renameTree, largeCsv, brokenProject, logStats, configTree, deepModule, deepCorpus, noisySuite, symbolTree, gatePipeline }
