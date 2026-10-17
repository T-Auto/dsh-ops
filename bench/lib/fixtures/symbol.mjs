/**
 * The `symbol` fixture family: renames and long-range reads — one exported
 * function used from many files, with look-alike symbols that must survive the
 * rename, and a module whose answer needs two distant ranges while a stale
 * comment and a superseded table mislead a single grep.
 * @module dsh-ops/bench/fixtures/symbol
 */

import { createHash } from 'node:crypto'

import { hexRun, mulberry32, pad, pick, randInt, WORDS } from './index.mjs'

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

/** Recompute `symbolTree`'s `{final, fixedFiles, files}` by renaming `from` -> `to` on word boundaries. */
export function deriveSymbolTree(files, { from, to }) {
  const pattern = new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')
  const fixedFiles = files
    .filter((file) => file.path.startsWith('src/'))
    .map((file) => ({ path: file.path, content: file.content.replace(pattern, to) }))
    .sort((left, right) => (left.path < right.path ? -1 : 1))
  const final = fixedFiles.map((file) => ({
    name: file.path.split('/').pop(),
    sha256: createHash('sha256').update(file.content, 'utf8').digest('hex'),
  }))
  return { final, fixedFiles, files: fixedFiles.length - 1 }
}

/** Recompute `deepModule`'s answer and both decoys from `files` and `{env}`. */
export function deriveDeepModule(files, { env }) {
  const content = files.find((file) => file.path === 'src/pipeline.js')?.content ?? ''
  const lines = content.replace(/\n$/, '').split('\n')
  const table = (name) => {
    const values = {}
    const at = lines.indexOf(`const ${name} = Object.freeze({`)
    for (let index = at + 1; index < lines.length && lines[index] !== '})'; index += 1) {
      const match = /^  (\w+): (\d+),$/.exec(lines[index])
      if (match) values[match[1]] = Number(match[2])
    }
    return values
  }
  const value = table('LIMIT_TABLE')[env]
  return {
    answer: String(value),
    value,
    stale: Number(/Historical note: \w+ used to allow (\d+) concurrent uploads/.exec(content)?.[1]),
    legacy: table('LEGACY_LIMIT_TABLE')[env],
    fnName: /^export function (\w+)\(environment\) \{$/m.exec(content)?.[1],
    env,
    tableName: 'LIMIT_TABLE',
    lines: lines.length,
  }
}
