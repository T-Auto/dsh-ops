/**
 * The `deep` fixture family: the long-range shapes. One enormous module whose
 * answer needs two distant ranges, with a stale comment and a superseded table
 * left in place so a single grep still leaves a decision to make.
 * @module dsh-ops/bench/fixtures/deep
 */

import { createHash } from 'node:crypto'

import { hexRun, mulberry32, pick, randInt, WORDS } from './internal.mjs'

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
