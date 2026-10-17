/**
 * The `symbol` fixture family: one exported function used from forty files,
 * with look-alike symbols that must survive a rename untouched.
 * @module dsh-ops/bench/fixtures/symbol
 */

import { createHash } from 'node:crypto'

import { mulberry32, pad, pick } from './internal.mjs'

/**
 * `symbolTree` — one exported function used from forty files, with two look-alike
 * exports that must survive the rename untouched (PLAN §7.9).
 *
 * A mechanical rename is a rename of a *symbol*, not of a string: `parsePayload` and
 * `parsePayloadLegacy` share a prefix, `parsePayloadAsync` shares it and calls the
 * function being renamed, and a file exists that touches only the look-alike. The
 * verdict is the byte-exact final content of every file in `src/`, so a rename that
 * also catches a look-alike fails, and so does a rename that misses one call site.
 *
 * The generator needs at least five files (`files >= 5`; one per `index % 5`
 * shape) or it throws: the fifth shape is the only one that never mentions the
 * symbol being renamed, and `symbolTree` refuses a tree where every file touches
 * it, because such a tree cannot distinguish a symbol rename from a string
 * replace. Values below five are still clamped to three, then rejected by that
 * invariant rather than by a silent no-op.
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
