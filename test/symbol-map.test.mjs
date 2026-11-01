/**
 * The symbol map: its contract, its bounds, and the fence in front of it.
 *
 * `symbol_map` is the only member of `FILE_TOOLS` that answers in-process, and it is the only one
 * whose whole product is a set of line numbers. Both facts make silent drift cheap and invisible:
 * a wrong `name` filter, an offset that counts lines instead of symbols, or a page that loses a row
 * produces output that still *looks* like an outline. Every check below is therefore written
 * against a fixture whose line numbers are fixed in the test, and the expected values are the ones
 * the engine was measured to produce, not the ones its documentation described.
 *
 * Four layers are covered:
 *
 * - **Contract** — four fields per symbol, 1-based inclusive ranges, outer-first order, a revision
 *   that hashes the exact parsed bytes, and no code body anywhere in the receipt.
 * - **Bounds** — `offset` counts symbols, `nextOffset` loses nothing, `omitted` is defined against
 *   the scan position rather than the row count, and both truncation reasons are reachable.
 * - **Tolerance** — a file with a syntax error still yields the symbols below the error, the
 *   recovery pass is what rescues them, it de-duplicates, and its work is bounded.
 * - **Fence** — the credential fence runs before anchoring, a bad argument is the caller's code
 *   rather than `EXECUTOR_UNAVAILABLE`, the missing-grammar case names its install command, and
 *   the tool answers without the subprocess service every other file tool requires.
 *
 * The optional grammar packages are not dependencies of dsh-ops. A checkout without them skips the
 * suite visibly (`skipSuite`) instead of failing, and `DSH_OPS_REQUIRE_RUNTIME=1` turns that skip
 * into a gate failure, so a machine that claims to run this suite cannot pass by having nothing
 * installed.
 *
 * One expectation is recorded rather than endorsed, and it says so at the assertion:
 * `prune: true` returns a symbol outside the window. It is unreachable from the tool's schema and
 * needs a decision from the author who owns `engine.ts`. A path outside the session anchors used
 * to be listed here too; reading `worker.ts` settled it — the spawning tools do not confine an
 * absolute read either, so serving it is parity with `ops_inspect_local_file`, not a gap.
 *
 * @module dsh-ops/test/symbol-map
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { assert, canonical, PACKAGE_ROOT, report, skipSuite, TEST_HOME, test } from './lib/harness.mjs'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { NativeFileTools } from '../lib/file/runtime.js'
import { invoke } from '../lib/file/worker.js'
import { FILE_TOOLS, NO_WORKER_FILE_TOOLS, OBSERVED_READ_TOOLS } from '../lib/capabilities/registry.js'
import { canonicalOutput } from '../lib/ptc/projection/canonical-schema.js'
import { continuationFor, decodeContinuation } from '../lib/ptc/projection/continuation.js'
import { toOutcome } from '../lib/ptc/projection/outcome.js'
import { outcomeSchema } from '../lib/ptc/projection/schema.js'
import { renderNative } from '../lib/projections/native/render.js'
import { publicToolName } from '../lib/policy.js'
import {
  INSTALL_HINT,
  compareSymbols,
  getSymbolMap,
  mapSource,
  normalizeScope,
  paginate,
  querySource,
  resetCaches,
  stats,
  verifySymbolMap,
} from '../lib/symbol-map/index.js'
// The recovery ceilings are not part of the package's public surface; the test bounds itself
// against the same numbers the engine enforces rather than repeating them.
import { RECOVERY_BUDGET } from '../lib/symbol-map/engine.js'

/**
 * Find a directory the optional grammars can be required from.
 *
 * `grammar.ts` anchors `createRequire` at the package root and honours `DSH_OPS_SYMBOL_MAP_ROOT`.
 * The standalone blueprint package (`ops-symbol-map`) keeps the same install next to the checkout,
 * so both the ancestors of this repository and an `ops-symbol-map` sibling of each are probed. The
 * first anchor that resolves all three packages wins; nothing is guessed beyond that.
 * @returns {string | undefined} an anchor directory, or `undefined` when nothing resolves.
 */
function grammarRoot() {
  const candidates = []
  const configured = process.env.DSH_OPS_SYMBOL_MAP_ROOT
  if (configured !== undefined && configured !== '') candidates.push(configured)
  let dir = PACKAGE_ROOT
  for (let depth = 0; depth < 4; depth += 1) {
    candidates.push(dir, path.join(dir, 'ops-symbol-map'))
    dir = path.dirname(dir)
  }
  for (const candidate of candidates) {
    try {
      const require = createRequire(path.join(candidate, 'package.json'))
      require.resolve('tree-sitter')
      require.resolve('tree-sitter-typescript')
      require.resolve('tree-sitter-javascript')
      return candidate
    } catch { /* try the next anchor */ }
  }
  return undefined
}

const GRAMMAR_ROOT = grammarRoot()
if (GRAMMAR_ROOT === undefined) skipSuite('symbol-map', `the optional tree-sitter grammars are not installed; ${INSTALL_HINT}`)
// Set before the first parse: `grammar.ts` reads the override once, when it creates its require.
process.env.DSH_OPS_SYMBOL_MAP_ROOT = GRAMMAR_ROOT

import {
  bridge,
  BROKEN,
  BROKEN_CLASS,
  CASED,
  GOOD,
  GOOD_SYMBOLS,
  NAMED,
  seed,
  withFixture,
} from './lib/symbol-map-fixtures.mjs'

/* ------------------------------------------------------------------ contract */

await test('every symbol is four fields and a 1-based inclusive range inside the file', async () => {
  await withFixture('symbol-map-contract', async dir => {
    seed(dir, { 'good.ts': GOOD })
    const map = getSymbolMap(path.join(dir, 'good.ts'))
    const lines = GOOD.split('\n').length
    assert.equal(map.total, map.symbols.length)
    for (const symbol of map.symbols) {
      assert.deepEqual(Object.keys(symbol).sort(), ['endLine', 'name', 'startLine', 'type'])
      assert.ok(['function', 'class', 'method'].includes(symbol.type), `unexpected type ${symbol.type}`)
      assert.ok(Number.isInteger(symbol.startLine) && symbol.startLine >= 1, `bad startLine ${symbol.startLine}`)
      assert.ok(symbol.endLine >= symbol.startLine, `bad range ${symbol.startLine}-${symbol.endLine}`)
      assert.ok(symbol.endLine <= lines, `${symbol.name} ends past the file (${symbol.endLine} > ${lines})`)
      assert.equal(typeof symbol.name, 'string')
      assert.notEqual(symbol.name, '')
    }
  })
})

await test('a class precedes its methods, functions keep source order, and a generator is a function', async () => {
  await withFixture('symbol-map-order', async dir => {
    seed(dir, { 'good.ts': GOOD })
    const map = mapSource(GOOD, { lang: 'typescript' })
    assert.deepEqual(map.symbols, GOOD_SYMBOLS)
    assert.deepEqual(map.symbols.map(symbol => symbol.type), ['function', 'class', 'method', 'method', 'function'])
    assert.deepEqual(map.symbols, getSymbolMap(path.join(dir, 'good.ts')).symbols, 'the disk path and the memory path must agree')
  })
})

await test('a private, computed, quoted or accessor method is a method too, and an object literal is not', async () => {
  const map = mapSource(NAMED, { lang: 'typescript' })
  assert.deepEqual(map.symbols.map(symbol => `${symbol.startLine} ${symbol.type} ${symbol.name}`), [
    '1 class Named',
    '2 method plain',
    '3 method #secret',
    '4 method value',
    '5 method [Symbol.iterator]',
    "6 method 'quoted-name'",
  ])
  assert.equal(map.symbols.some(symbol => symbol.name === 'notAMethod'), false, 'a method in an object literal is not a class member')
  // The same source must behave identically under the other two grammars, which is the reason the
  // query avoids per-language node names everywhere except the class name.
  assert.deepEqual(mapSource(NAMED, { lang: 'javascript' }).symbols, map.symbols)
  assert.deepEqual(mapSource(NAMED, { lang: 'tsx' }).symbols, map.symbols)
})

await test('the revision hashes the parsed bytes and the hash is its first sixteen characters', async () => {
  await withFixture('symbol-map-revision', async dir => {
    const file = path.join(dir, 'good.ts')
    seed(dir, { 'good.ts': GOOD })
    const map = getSymbolMap(file)
    const bytes = fs.readFileSync(file)
    const expected = createHash('sha256').update(bytes).digest('hex')
    assert.equal(map.revision, expected)
    assert.equal(map.hash, expected.slice(0, 16))
    assert.equal(map.bytes, bytes.length)
    assert.match(map.revision, /^[a-f0-9]{64}$/u)
  })
})

await test('symbols sort by start, then by the longer span, then by name', async () => {
  const compared = [
    { name: 'b', type: 'function', startLine: 7, endLine: 7 },
    { name: 'a', type: 'function', startLine: 7, endLine: 7 },
    { name: 'wide', type: 'class', startLine: 7, endLine: 9 },
    { name: 'earlier', type: 'function', startLine: 2, endLine: 3 },
  ].sort(compareSymbols)
  assert.deepEqual(compared.map(symbol => symbol.name), ['earlier', 'wide', 'a', 'b'])
})

await test('a scope window is normalised from every shape the API accepts', async () => {
  assert.deepEqual(normalizeScope('40-120'), { lo: 40, hi: 120 })
  assert.deepEqual(normalizeScope(' 40 : 120 '), { lo: 40, hi: 120 })
  assert.deepEqual(normalizeScope('120-40'), { lo: 40, hi: 120 }, 'a reversed pair means the same range')
  assert.deepEqual(normalizeScope('0-3'), { lo: 1, hi: 3 }, 'a start below 1 is clamped')
  assert.deepEqual(normalizeScope({ lo: 5, hi: 9 }), { lo: 5, hi: 9 })
  assert.deepEqual(normalizeScope({ startLine: 9, endLine: 5 }), { lo: 5, hi: 9 })
  for (const bad of ['abc', {}, 7]) {
    assert.throws(() => normalizeScope(bad), error => error.code === 'E_ARGS', `scope ${JSON.stringify(bad)} must be E_ARGS`)
  }
})

await test('the extended tier adds variable-bound functions and the core tier omits them', async () => {
  const core = mapSource(GOOD, { lang: 'typescript' })
  const extended = mapSource(GOOD, { lang: 'typescript', extended: true })
  assert.equal(core.symbols.some(symbol => symbol.name === 'handler'), false)
  assert.deepEqual(extended.symbols.at(-1), { name: 'handler', type: 'function', startLine: 19, endLine: 21 })
  assert.equal(extended.total, core.total + 1)
  assert.equal(extended.revision, core.revision, 'the tier is not part of the file identity')
})

await test('the pruned walk finds declarations the query finds, including nested ones', async () => {
  // The walk replaced `query.matches` for the core tier, and the only acceptable failure mode is
  // "identical output". The shapes below are the ones a naive pruner drops: a declaration under a
  // try, under an if, and inside a method body. `ptc/worker.ts:86` really does declare inside a
  // try, and the first version of this walk silently lost it.
  const source = [
    'export function outer() {',
    '  try {',
    '    function inner() {}',
    '    const ignored = 1',
    '  } catch { /* nothing */ }',
    '  if (true) { class Local {} }',
    '}',
    '',
    'export class A {',
    '  m() { function nested() {} }',
    '}',
    '',
  ].join(String.fromCharCode(10))
  const map = mapSource(source, { lang: 'typescript' })
  assert.deepEqual(map.symbols.map(symbol => `${symbol.type}:${symbol.name}`), [
    'function:outer', 'function:inner', 'class:Local', 'class:A', 'method:m', 'function:nested',
  ])
})

await test('bodyless declarations are symbols, not gaps in the outline', async () => {
  // A `.d.ts` and an abstract class are written entirely out of nodes the grammar distinguishes by
  // "has no body": `function_signature`, `method_signature`, `abstract_method_signature`, and
  // `abstract_class_declaration` for the class itself. None of them existed in the first version,
  // and the failure was silent — the outline was simply shorter than the file, which is the one
  // thing a reader cannot notice. `namespace N {}` was lost the same way: it parses as
  // `expression_statement > internal_module`, and the legacy `module M {}` spelling did not.
  const source = [
    'declare function ambient(): void',
    'declare namespace NS { function nested(): void }',
    'namespace Modern { export function inside() {} }',
    'export abstract class Base {',
    '  abstract run(): void',
    '  concrete() {}',
    '}',
    'export declare class Ambient { m(): void }',
    '',
  ].join(String.fromCharCode(10))
  const map = mapSource(source, { lang: 'typescript' })
  assert.deepEqual(map.symbols.map(symbol => `${symbol.type}:${symbol.name}`), [
    'function:ambient', 'function:nested', 'function:inside',
    'class:Base', 'method:run', 'method:concrete',
    'class:Ambient', 'method:m',
  ])

  // The same source through the compiled query, which is the path the extended tier and a pruned
  // scope use. Two tiers that disagree on one file is a map that changes under the reader.
  const viaQuery = mapSource(source, { lang: 'typescript', extended: true })
  assert.deepEqual(viaQuery.symbols, map.symbols, 'the walk and the query must report the same file')

  // An anonymous `export default class {}` has no name to report, but its methods are real
  // declarations at real lines, so both tiers keep them and neither invents a class name.
  const anonymous = 'export default class {' + String.fromCharCode(10) + '  m() {}' + String.fromCharCode(10) + '}' + String.fromCharCode(10)
  assert.deepEqual(mapSource(anonymous, { lang: 'typescript' }).symbols.map(symbol => symbol.name), ['m'])
  assert.deepEqual(mapSource(anonymous, { lang: 'typescript', extended: true }).symbols.map(symbol => symbol.name), ['m'])
})

await test('the javascript grammar gets a query it can actually compile', async () => {
  // `abstract_class_declaration` does not exist outside the TypeScript grammars, and a query that
  // names it fails to compile there rather than returning fewer matches — so the source is built
  // per grammar family. A shared string would break every `.js` file at the first extended call.
  assert.equal(querySource('javascript', false).includes('abstract_class_declaration'), false)
  assert.equal(querySource('javascript', true).includes('function_signature'), false)
  assert.equal(querySource('typescript', false).includes('abstract_class_declaration'), true)
  assert.equal(querySource('tsx', true).includes('function_signature'), true)
  const js = mapSource('export class A {' + String.fromCharCode(10) + '  m() {}' + String.fromCharCode(10) + '}' + String.fromCharCode(10), { lang: 'javascript', extended: true })
  assert.deepEqual(js.symbols.map(symbol => `${symbol.type}:${symbol.name}`), ['class:A', 'method:m'])
})

await test('the extended tier stays on the compiled query and compiles it exactly once', async () => {
  resetCaches()
  mapSource(GOOD, { lang: 'typescript', extended: true })
  const first = stats()
  assert.equal(first.queryCompiles, 1, 'the extended tier needs the query; the core tier does not')
  mapSource(GOOD, { lang: 'typescript', extended: true })
  assert.equal(stats().queryCompiles, 1, 'a second extended map reuses the compiled query')
})

/* --------------------------------------------------------------------- paging */

await test('offset counts symbols, not lines', async () => {
  const map = mapSource(GOOD, { lang: 'typescript' })
  assert.deepEqual(paginate(map, { offset: 1 }).symbols.map(symbol => symbol.name), ['Widget', 'render', 'make', 'stream'])
  // Line 1 holds `alpha` and line 5 holds `Widget`: an offset of 1 must still land on the second
  // symbol, not on the second line.
  assert.equal(paginate(map, { offset: 1 }).symbols[0].startLine, 5)
})

await test('walking nextOffset reproduces the whole map with no gap and no repeat', async () => {
  const map = mapSource(GOOD, { lang: 'typescript' })
  const collected = []
  for (let offset = 0, guard = 0; guard < 10; guard += 1) {
    const page = paginate(map, { offset, limit: 2 })
    collected.push(...page.symbols)
    if (page.complete) break
    assert.ok(Number.isInteger(page.nextOffset), 'a partial page must name where to resume')
    assert.ok(page.nextOffset > offset, 'a partial page must advance')
    offset = page.nextOffset
  }
  assert.deepEqual(collected, map.symbols)
})

await test('a filtered page pages the filtered set, so omitted counts only what the filter kept', async () => {
  // The engine filters first and pages second. The scan position is therefore an index into the
  // FILTERED list, not into the file: with two rows returned, the next unread row is 2 and the
  // omitted count is measured from there. Reporting a position in the unfiltered list (the old
  // behaviour) made `nextOffset` skip a matching symbol, so the caller lost one row per page.
  const map = mapSource(GOOD, { lang: 'typescript' })
  const page = paginate(map, { limit: 2, name: 'e' })
  assert.deepEqual(page.symbols.map(symbol => symbol.name), ['Widget', 'render'])
  assert.equal(page.nextOffset, 2, 'the scan resumes at the first symbol the page did not return')
  assert.equal(page.omitted, page.total - page.nextOffset)
  assert.equal(page.truncatedBy, 'row-limit')
  assert.equal(page.complete, false)
})

await test('both bounds are reachable and each names itself', async () => {
  const map = mapSource(GOOD, { lang: 'typescript' })
  const rows = paginate(map, { limit: 2 })
  assert.equal(rows.symbols.length, 2)
  assert.equal(rows.truncatedBy, 'row-limit')
  // The budget is charged in encoded lines ("1-3 f alpha"), so the same ceiling now holds fewer
  // symbols than the old object form did. 50 bytes is exactly three of GOOD's five (the floor is 256).
  const bytes = paginate(map, { budgetBytes: 50 })
  assert.equal(bytes.symbols.length, 3)
  assert.equal(bytes.nextOffset, 3)
  assert.equal(bytes.omitted, 2)
  assert.equal(bytes.truncatedBy, 'output-budget')
})

await test('zero means unbounded and an out-of-range offset clamps instead of failing', async () => {
  const map = mapSource(GOOD, { lang: 'typescript' })
  assert.deepEqual(paginate(map, { limit: 0 }).symbols, map.symbols)
  assert.deepEqual(paginate(map, { budgetBytes: 0 }).symbols, map.symbols)
  const far = paginate(map, { offset: 99 })
  assert.deepEqual(far.symbols, [])
  assert.equal(far.offset, map.total, 'the offset is clamped to the end')
  assert.equal(far.complete, true, 'reading past the end is finished, not truncated')
  assert.equal(far.nextOffset, undefined)
  const negative = paginate(map, { offset: -5 })
  assert.equal(negative.offset, 0)
  assert.equal(negative.symbols.length, map.total)
})

/* ------------------------------------------------------------------ filtering */

await test('the name filter is case-sensitive', async () => {
  const map = mapSource(CASED, { lang: 'typescript' })
  assert.deepEqual(map.symbols.map(symbol => symbol.name), ['get', 'GetValue'])
  assert.deepEqual(paginate(map, { name: 'get' }).symbols.map(symbol => symbol.name), ['get'], 'folding case would return GetValue too')
  assert.deepEqual(paginate(map, { name: 'Get' }).symbols.map(symbol => symbol.name), ['GetValue'])
  assert.deepEqual(paginate(map, { name: 'GET' }).symbols, [])
})

await test('a scope window keeps a class that starts above it', async () => {
  const map = mapSource(GOOD, { lang: 'typescript', scope: '6-12' })
  assert.deepEqual(map.symbols.map(symbol => `${symbol.name}@${symbol.startLine}`), ['Widget@5', 'render@6', 'make@10'])
  const narrow = mapSource(GOOD, { lang: 'typescript', scope: '7-8' })
  assert.deepEqual(narrow.symbols.map(symbol => symbol.name), ['Widget', 'render'])
})

await test('prune true hands the window to the query and returns a symbol outside it', async () => {
  const pruned = mapSource(GOOD, { lang: 'typescript', scope: '7-8', prune: true })
  const unpruned = mapSource(GOOD, { lang: 'typescript', scope: '7-8' })
  // RECORDED, NOT ENDORSED. `make` spans lines 10-12 and the window is 7-8, so this row is outside
  // the range the caller asked for; `engine.ts` documents the opposite ("a symbol that begins above
  // the window is invisible"). Nothing reachable from `symbol_map` passes `prune`, so the tool is
  // unaffected — the day the author rewrites this branch, this expectation is the one to change.
  assert.deepEqual(pruned.symbols.map(symbol => `${symbol.name}@${symbol.startLine}`), ['Widget@5', 'render@6', 'make@10'])
  assert.deepEqual(unpruned.symbols.map(symbol => `${symbol.name}@${symbol.startLine}`), ['Widget@5', 'render@6'])
})

/* ------------------------------------------------------------------ tolerance */

await test('a pruned window never runs the recovery pass, so a broken file yields nothing', async () => {
  resetCaches()
  const plain = mapSource(BROKEN, { lang: 'typescript' })
  assert.equal(plain.total, 3, 'the unpruned path collects three symbols')
  assert.ok(stats().recoveryParses > 0, 'and pays for the recovery parses that found them')
  resetCaches()
  // `engine.ts:210` gates recovery on `cursor === undefined`. A window handed to the query sets a
  // cursor, so a chunk-local re-parse — whose line numbers would be window-relative — is skipped
  // and the broken file reports no symbols at all. The tool never passes `prune`, so this is the
  // internal tier only, but it is the reason the recovery test above must not also pass a scope.
  const pruned = mapSource(BROKEN, { lang: 'typescript', scope: '1-11', prune: true })
  assert.equal(pruned.partial, true, 'the parse still reports its syntax error')
  assert.deepEqual(pruned.symbols, [])
  assert.equal(stats().recoveryParses, 0, 'a pruned view must not spawn recovery parses')
})

await test('a file broken on line 1 still yields every symbol below the break', async () => {
  const map = mapSource(BROKEN, { lang: 'typescript' })
  assert.equal(map.partial, true)
  assert.ok(map.syntaxErrors >= 1)
  assert.deepEqual(map.symbols, [
    { name: 'alpha', type: 'function', startLine: 3, endLine: 5 },
    { name: 'Widget', type: 'class', startLine: 7, endLine: 11 },
    { name: 'render', type: 'method', startLine: 8, endLine: 10 },
  ])
})

await test('the recovery pass is what rescues those symbols, and it never reports one twice', async () => {
  const recovered = mapSource(BROKEN, { lang: 'typescript' })
  const bare = mapSource(BROKEN, { lang: 'typescript', recover: false })
  assert.deepEqual(bare.symbols, [], 'an un-recovered parse loses everything after the error')
  assert.equal(recovered.total, 3)
  const keys = recovered.symbols.map(symbol => `${symbol.type}:${symbol.name}:${symbol.startLine}`)
  assert.equal(new Set(keys).size, keys.length, `duplicate symbols: ${keys.join(', ')}`)
})

await test('recovery work is bounded on a file that is broken everywhere', async () => {
  const wrecked = Array.from({ length: 40 }, (_, index) => `function broken${index}( {{{`).join('\n\n')
  resetCaches()
  const map = mapSource(wrecked, { lang: 'typescript' })
  assert.equal(map.partial, true)
  assert.ok(map.syntaxErrors <= 100, `syntax errors must be capped, got ${map.syntaxErrors}`)
  assert.ok(stats().recoveryParses <= RECOVERY_BUDGET.chunks, `recovery parses must be capped, got ${stats().recoveryParses}`)
  // One chunk per declaration is the whole budget on a file where every declaration is broken:
  // 40 broken functions, 40 parses, nothing recovered. A chunking rule that kept re-parsing the
  // same text would show up here as a larger number.
  assert.equal(stats().recoveryParses, 40, 'a file of N broken declarations costs N parses, not more')
})

await test('recovery re-parses only the declaration the error is in', async () => {
  // 40 declarations, one of them broken. The old pass split by blank line and re-parsed the whole
  // file, so it paid 40 parses to add nothing: the main tree already returned every symbol outside
  // the ERROR node. The scoped pass pays one.
  const many = Array.from({ length: 40 }, (_, index) => (index === 17
    ? `export function fn${index}(input: number): number {\n  return ${index} @@@\n}`
    : `export function fn${index}(input: number): number {\n  return ${index}\n}`)).join('\n\n')
  resetCaches()
  const map = mapSource(many, { lang: 'typescript' })
  assert.equal(map.partial, true)
  assert.equal(map.total, 40, 'every declaration is still reported')
  assert.equal(stats().recoveryParses, 1, `only the broken declaration is re-parsed, got ${stats().recoveryParses}`)
})

await test('a class keeps its methods when recovery runs, blank line inside the body or not', async () => {
  // `BROKEN_CLASS` has a blank line between `render` and `static make`. Splitting on blank lines
  // puts `class Widget {` in one chunk and `static make()` in another, and a method fragment on
  // its own is a syntax error — so a paragraph-splitting recovery loses `make` without failing.
  // Splitting on top-level declarations keeps the class whole.
  const map = mapSource(BROKEN_CLASS, { lang: 'typescript' })
  assert.deepEqual(map.symbols.map(symbol => `${symbol.name}@${symbol.startLine}`), [
    'Widget@3', 'render@4', 'make@8',
  ])
})

await test('the extended tier recovers a variable-bound function from a broken file', async () => {
  // The recovery pass used to run the core walk unconditionally, so a broken file silently lost
  // every `const handler = () => {}` that the clean file reports. Both tiers now share one
  // extractor.
  const core = mapSource(BROKEN_CLASS, { lang: 'typescript' })
  const extended = mapSource(BROKEN_CLASS, { lang: 'typescript', extended: true })
  assert.equal(core.symbols.some(symbol => symbol.name === 'handler'), false, 'the core tier does not report a binding')
  assert.deepEqual(extended.symbols.at(-1), { name: 'handler', type: 'function', startLine: 13, endLine: 13 })
})

/* ---------------------------------------------------------------------- fence */

await test('symbol_map answers without a subprocess service while the spawning tools refuse', async () => {
  await withFixture('symbol-map-fence', async workspace => {
    seed(workspace, { 'good.ts': GOOD })
    const { call } = bridge({ workspace })
    const mapped = await call('symbol_map', { path: 'good.ts' })
    assert.equal(mapped.status, 'completed', JSON.stringify(mapped))
    assert.equal(mapped.total, 5)
    assert.equal(mapped.sandbox.boundary, 'in-process-symbol-map')
    const gated = await call('inspect_local_file', { path: 'good.ts' })
    assert.equal(gated.error.code, 'EXECUTOR_UNAVAILABLE', 'the spawn branch still needs the subprocess service')
  })
})

await test('the receipt carries positions and identity but never the code', async () => {
  await withFixture('symbol-map-receipt', async workspace => {
    const file = path.join(workspace, 'good.ts')
    seed(workspace, { 'good.ts': GOOD })
    const { call } = bridge({ workspace })
    const receipt = await call('symbol_map', { path: 'good.ts' })
    // `fileHash` is the change fingerprint, carried on every page so a caller paging through a
    // large file can still tell whether the file it is paging is the one it started on.
    assert.deepEqual(Object.keys(receipt).sort(), [
      'bytes', 'complete', 'file', 'fileHash', 'hash', 'lang', 'offset', 'omitted', 'partial',
      'revision', 'sandbox', 'status', 'symbols', 'total',
    ])
    assert.equal(receipt.file, 'good.ts', 'a path inside the cwd is shown relative to it')
    assert.equal(receipt.revision, createHash('sha256').update(fs.readFileSync(file)).digest('hex'))
    assert.equal(receipt.hash, receipt.revision.slice(0, 16))
    assert.equal(receipt.partial, false)
    assert.equal(receipt.offset, 0)
    assert.equal(receipt.complete, true)
    const serialised = JSON.stringify(receipt)
    for (const body of ['return 1', 'return 2', 'new Widget()', 'yield 1']) {
      assert.equal(serialised.includes(body), false, `the receipt leaked code: ${body}`)
    }
  })
})

await test('a paged receipt is partial, names its bound and where to resume', async () => {
  await withFixture('symbol-map-paged-receipt', async workspace => {
    seed(workspace, { 'good.ts': GOOD })
    const { call } = bridge({ workspace })
    const page = await call('symbol_map', { path: 'good.ts', limit: 2 })
    assert.equal(page.status, 'partial')
    assert.equal(page.complete, false)
    assert.equal(page.nextOffset, 2)
    assert.equal(page.truncatedBy, 'row-limit')
    assert.deepEqual(page.symbols, ['1-3 f alpha', '5-13 c Widget'])
    const resumed = await call('symbol_map', { path: 'good.ts', offset: page.nextOffset, limit: 2 })
    assert.deepEqual(resumed.symbols, ['6-8 m render', '10-12 m make'])
  })
})

await test('an unknown extension is unsupported until the caller names the language', async () => {
  await withFixture('symbol-map-lang', async workspace => {
    seed(workspace, { 'notes.txt': GOOD })
    const { call } = bridge({ workspace })
    const refused = await call('symbol_map', { path: 'notes.txt' })
    assert.equal(refused.error.code, 'UNSUPPORTED_DOCUMENT')
    assert.match(refused.error.message, /pass lang explicitly/)
    const mapped = await call('symbol_map', { path: 'notes.txt', lang: 'typescript' })
    assert.equal(mapped.total, 5, 'an explicit lang wins over the extension')
  })
})

await test('a language outside the enum is unsupported, a malformed scope or offset is invalid', async () => {
  await withFixture('symbol-map-args', async workspace => {
    seed(workspace, { 'good.ts': GOOD })
    const { call } = bridge({ workspace })
    const lang = await call('symbol_map', { path: 'good.ts', lang: 'python' })
    assert.equal(lang.error.code, 'UNSUPPORTED_DOCUMENT')
    assert.match(lang.error.message, /must be one of typescript, tsx, javascript/)
    const scope = await call('symbol_map', { path: 'good.ts', scope: 'abc' })
    assert.equal(scope.error.code, 'INVALID_ARGUMENT', 'a wrong scope is the caller\'s mistake, not a host failure')
    assert.match(scope.error.message, /START-END/)
    const offset = await call('symbol_map', { path: 'good.ts', offset: 'x' })
    assert.equal(offset.error.code, 'INVALID_ARGUMENT')
    const limit = await call('symbol_map', { path: 'good.ts', limit: 'x' })
    assert.equal(limit.error.code, 'INVALID_ARGUMENT')
  })
})

await test('a missing session, a relative cwd or a missing policy all refuse before reading', async () => {
  await withFixture('symbol-map-authority', async workspace => {
    seed(workspace, { 'good.ts': GOOD })
    const policyOnly = { get: () => ({ sandboxPolicy: { resolve: () => ({ mode: 'read-only', workspaceRoot: workspace }) } }) }
    const noSession = await invoke(policyOnly, '', 'symbol_map', { path: 'good.ts' }, { agent: {} }, undefined, {})
    assert.equal(noSession.error.code, 'EXECUTOR_UNAVAILABLE')
    assert.match(noSession.error.message, /session identity/)

    const relative = await invoke(
      { get: () => ({ sandboxPolicy: { resolve: () => ({ mode: 'read-only', workspaceRoot: workspace }) } }) },
      '', 'symbol_map', { path: 'good.ts' },
      { agent: { session: { id: 'symbol-map-relative', header: { cwd: 'relative-dir' } } } }, undefined, {},
    )
    assert.equal(relative.error.code, 'EXECUTOR_UNAVAILABLE')
    assert.match(relative.error.message, /cwd/)

    const policyLess = bridge({ workspace, policy: false })
    const refused = await policyLess.call('symbol_map', { path: 'good.ts' })
    assert.equal(refused.error.code, 'EXECUTOR_UNAVAILABLE')
    assert.match(refused.error.message, /policy resolution is required/)
  })
})

await test('a directory is IS_DIRECTORY and a missing file is NOT_FOUND', async () => {
  await withFixture('symbol-map-paths', async workspace => {
    seed(workspace, { 'good.ts': GOOD })
    fs.mkdirSync(path.join(workspace, 'nested'))
    const { call } = bridge({ workspace })
    const directory = await call('symbol_map', { path: 'nested' })
    assert.equal(directory.error.code, 'IS_DIRECTORY')
    assert.equal(directory.status, 'error')
    const missing = await call('symbol_map', { path: 'nope.ts' })
    assert.equal(missing.error.code, 'NOT_FOUND')
  })
})

await test('the credential fence sees the requested path, before any anchor is applied', async () => {
  await withFixture('symbol-map-credential', async workspace => {
    const nested = path.join(workspace, '.ssh')
    fs.mkdirSync(nested)
    fs.writeFileSync(path.join(nested, 'id_rsa'), 'PRIVATE')
    seed(workspace, { 'good.ts': GOOD })
    const { call } = bridge({ workspace })
    const inside = await call('symbol_map', { path: '.ssh/id_rsa' })
    assert.equal(inside.error.code, 'CREDENTIAL_DENIED')
    assert.equal(inside.status, 'rejected')
    // Outside the workspace as well: if the anchor ran first and rewrote or admitted the path, this
    // would be a read instead of a refusal.
    const outside = await call('symbol_map', { path: path.join(workspace, '..', 'outside', '.ssh', 'id_rsa') })
    assert.equal(outside.error.code, 'CREDENTIAL_DENIED', JSON.stringify(outside))
    assert.match(outside.error.message, /credential location/)
    const optedOut = await call('symbol_map', { path: '.ssh/id_rsa' }, { denyCredentialReads: false })
    assert.notEqual(optedOut.error?.code, 'CREDENTIAL_DENIED', 'the row-level opt-out must reach this fence too')
  })
})

await test('a file outside every anchor is served, because this branch has no root to confine it', async () => {
  await withFixture('symbol-map-outside', async root => {
    const workspace = path.join(root, 'workspace')
    const elsewhere = path.join(root, 'elsewhere')
    fs.mkdirSync(workspace)
    fs.mkdirSync(elsewhere)
    seed(workspace, { 'good.ts': GOOD })
    seed(elsewhere, { 'other.ts': GOOD })
    const { call } = bridge({ workspace })
    const reached = await call('symbol_map', { path: path.join(elsewhere, 'other.ts') })
    // RECORDED, AND NOW KNOWN TO BE PARITY RATHER THAN A GAP. `invokeTrusted` refuses an absolute
    // path outside the anchors only for a *mutation*; for a read it rewrites the path and forwards
    // it with `root: <cwd>`, which resolves the worker's relative work but does not confine an
    // absolute one — confinement is the DSH kernel's job, not this plugin's fence. So the outcome
    // below is what `ops_inspect_local_file` would also produce under the same policy. The test
    // still belongs here: it is the only place that proves the anchor step is not silently
    // *widening* what the caller asked for, and it fails the day reads start being confined on
    // this branch or that branch starts being confined elsewhere.
    assert.equal(reached.status, 'completed', JSON.stringify(reached))
    assert.equal(reached.file, path.join(elsewhere, 'other.ts'), 'a path outside the cwd is shown absolute')
  })
})

await test('a missing grammar refuses with the exact install command instead of an empty outline', async () => {
  await withFixture('symbol-map-no-grammar', async root => {
    const workspace = path.join(root, 'workspace')
    const empty = path.join(root, 'empty')
    fs.mkdirSync(workspace)
    fs.mkdirSync(empty)
    seed(workspace, { 'good.ts': GOOD })
    const previous = process.env.DSH_OPS_SYMBOL_MAP_ROOT
    process.env.DSH_OPS_SYMBOL_MAP_ROOT = empty
    resetCaches()
    try {
      const { call } = bridge({ workspace })
      const refused = await call('symbol_map', { path: 'good.ts' })
      assert.equal(refused.error.code, 'EXECUTOR_UNAVAILABLE')
      assert.match(refused.error.message, /tree-sitter is not available/)
      assert.ok(refused.error.message.includes(INSTALL_HINT), 'the refusal must carry the install command')
      assert.match(refused.error.nextAction, /Install the optional grammar packages/)
    } finally {
      process.env.DSH_OPS_SYMBOL_MAP_ROOT = previous
      resetCaches()
    }
  })
})

/* -------------------------------------------------------------------- wiring */

await test('only symbol_map is in-process, and it is a file tool', async () => {
  assert.deepEqual([...NO_WORKER_FILE_TOOLS], ['symbol_map'])
  assert.ok(FILE_TOOLS.includes('symbol_map'))
  assert.equal(publicToolName('symbol_map'), 'ops_symbol_map')
  // A map is positions, not content: it must never satisfy the host's read-before-edit table, or a
  // model could "read" a file by outlining it and then edit against bytes it never saw.
  assert.equal(OBSERVED_READ_TOOLS.includes('symbol_map'), false)
})

await test('a runtime with no worker still publishes the in-process tool and nothing else', async () => {
  const registered = []
  const runtime = new NativeFileTools({ ctx: { tools: { register(definition) { registered.push(definition.name); return () => {} } } }, config: {} })
  assert.deepEqual(await runtime.start(), ['ops_symbol_map'])
  assert.deepEqual(registered, ['ops_symbol_map'])
  await runtime.stop()
})

await test('a continuation advances the symbol offset and leaves the filters alone', async () => {
  const args = { path: 'good.ts', name: 'render', limit: 2, scope: '1-40' }
  const token = continuationFor('symbol_map', args, { total: 5, offset: 0, symbols: [], omitted: 3, complete: false, nextOffset: 2 })
  assert.equal(typeof token, 'string')
  const decoded = decodeContinuation(token)
  assert.equal(decoded.tool, 'symbol_map')
  assert.deepEqual(decoded.args, { ...args, offset: 2 })
  assert.equal(continuationFor('symbol_map', args, { total: 5, offset: 2, symbols: [], omitted: 0, complete: true }), undefined, 'a finished page has nothing to continue')
})

await test('the PTC envelope accepts a settled and a paged symbol_map result', async () => {
  await withFixture('symbol-map-ptc', async workspace => {
    seed(workspace, { 'good.ts': GOOD })
    const { call } = bridge({ workspace })
    const schema = outcomeSchema(canonicalOutput('symbol_map'))
    assertSupportedJsonSchema(schema)
    const settled = await call('symbol_map', { path: 'good.ts' })
    assert.deepEqual(validateJsonSchemaValue(schema, toOutcome('symbol_map', { path: 'good.ts' }, settled)), [],
      'a completed receipt, sandbox block included, must validate against the canonical envelope')
    const paged = await call('symbol_map', { path: 'good.ts', limit: 2 })
    const envelope = toOutcome('symbol_map', { path: 'good.ts', limit: 2 }, paged)
    assert.equal(envelope.status, 'partial')
    assert.equal(typeof envelope.continuation, 'string', 'a paged result must carry a continuation into PTC')
    assert.deepEqual(validateJsonSchemaValue(schema, envelope), [])
    const wrongType = { ...settled, symbols: [{ name: 'alpha', type: 'function', startLine: '1', endLine: 3 }] }
    assert.ok(validateJsonSchemaValue(schema, toOutcome('symbol_map', { path: 'good.ts' }, wrongType)).length > 0,
      'the legacy object form must be rejected by the canonical schema')
  })
})

await test('the native projection is one position line per symbol and warns when positions were recovered', async () => {
  const clean = renderNative('symbol_map', { path: 'good.ts' }, {
    status: 'completed', file: 'good.ts', lang: 'typescript', total: 5, partial: false,
    revision: 'a'.repeat(64), hash: 'a'.repeat(16), bytes: 219, offset: 0, omitted: 0, complete: true, symbols: GOOD_SYMBOLS.map(symbol => `${symbol.startLine}-${symbol.endLine} ${symbol.type[0]} ${symbol.name}`),
  })
  assert.match(clean, /=== SYMBOLS: good\.ts \(typescript, 5 symbols\) ===/)
  assert.ok(clean.includes('1-3 f alpha'), clean)
  assert.ok(clean.includes('5-13 c Widget'), clean)
  assert.equal(/function alpha|class Widget/.test(clean), false, 'the kind is one letter on the wire')
  assert.equal(clean.includes('hash='), false, 'hash is revision.slice(0,16) and is not repeated')
  assert.equal(/recovered best-effort/.test(clean), false)

  const broken = renderNative('symbol_map', { path: 'broken.ts' }, {
    status: 'completed', file: 'broken.ts', lang: 'typescript', total: 3, partial: true, syntaxErrors: 1,
    revision: 'b'.repeat(64), hash: 'b'.repeat(16), bytes: 123, offset: 0, omitted: 0, complete: true,
    symbols: ['3-5 f alpha'],
  })
  assert.match(broken, /recovered best-effort/)
  assert.ok(broken.includes('3-5 f alpha'), broken)
})

await test('a recovered symbol is always a symbol of the clean file, range for range', async () => {
  // The recovery pass re-parses the rows the main tree failed on. That is only safe if it can add
  // symbols but never invent one: a chunk-local tree reports rows relative to the chunk, and an
  // off-by-one in the shift would produce a plausible name at a plausible line that points at
  // something else. So the invariant is set containment against the clean map, not a count.
  const module = (methods) => {
    const body = ['export function head() {', '  return 1', '}']
    for (let c = 0; c < 6; c += 1) {
      body.push('', `export class C${c} {`)
      for (let m = 0; m < methods; m += 1) body.push(`  m${c}_${m}() {`, '    return 2', '  }', '')
      body.push('}')
    }
    body.push('', 'export function tail() {', '  return 3', '}')
    return body
  }
  const clean = module(4).join('\n')
  const key = symbol => `${symbol.type}|${symbol.name}|${symbol.startLine}|${symbol.endLine}`
  const truth = new Set(mapSource(clean, { lang: 'typescript' }).symbols.map(key))

  // An unclosed brace where a method's body ends: the shape a half-finished edit leaves behind.
  const lines = module(4)
  for (const at of [12, 34, 56, 78]) lines[at] = lines[at].replace('}', '{')
  const broken = lines.join('\n')
  const map = mapSource(broken, { lang: 'typescript' })
  assert.equal(map.partial, true, 'the fixture must actually be broken')
  assert.ok(map.total > 0, 'a broken file still has an outline')
  const invented = map.symbols.filter(symbol => !truth.has(key(symbol)))
  assert.deepEqual(invented, [], 'recovery may shorten the outline, never move a symbol')
  // And the pass has to be doing something: dropping it must lose rows, or the test proves nothing.
  const bare = mapSource(broken, { lang: 'typescript', recover: false })
  assert.ok(bare.total < map.total || map.total === truth.size, `recovery added nothing (${bare.total} vs ${map.total})`)
})

/* --------------------------------------------------------------------- cache */
await test('a second map of an unchanged file is served from the cache, with one parser and no query', async () => {
  await withFixture('symbol-map-cache', async workspace => {
    seed(workspace, { 'good.ts': GOOD })
    const file = path.join(workspace, 'good.ts')
    resetCaches()
    const first = getSymbolMap(file)
    // Asserted before the second call: a cache hit returns the *same* map object and re-marks it,
    // so `first.cacheHit` would read `true` afterwards without a byte being parsed again.
    assert.equal(first.cacheHit, false)
    const second = getSymbolMap(file)
    assert.equal(second.cacheHit, true)
    assert.equal(second, first, 'a hit is the stored map, not a copy of it')
    assert.equal(second.revision, first.revision)
    const counted = stats()
    assert.equal(counted.parses, 1, 'the cached call must not parse again')
    assert.equal(counted.parserCreations, 1)
    // The default path walks the tree instead of running a query, so nothing is compiled at all.
    // A non-zero value here would mean the pool is back on the query path and the 34x saving is gone.
    assert.equal(counted.queryCompiles, 0, 'the walk path needs no compiled query')
    assert.equal(counted.cachedFiles, 1)
    assert.equal(counted.cachedUnits, GOOD.length, 'retained source is counted in the units the ceiling uses')
  })
})

await test('the cache is bounded, so a long session cannot keep every tree it ever parsed', async () => {
  // Each entry holds the source text and, through `treeOfMap`, a native tree. Without a ceiling a
  // plugin process that runs for days keeps one tree per file it has ever mapped.
  await withFixture('symbol-map-cache-bound', async workspace => {
    resetCaches()
    const body = 'export function f() {\n  return 1\n}\n'
    const total = 520
    for (let index = 0; index < total; index += 1) {
      fs.writeFileSync(path.join(workspace, `f${index}.ts`), body)
      getSymbolMap(path.join(workspace, `f${index}.ts`))
    }
    const counted = stats()
    assert.equal(counted.parses, total, 'every file was parsed once')
    assert.ok(counted.cachedFiles <= 512, `cachedFiles ${counted.cachedFiles} exceeds the entry ceiling`)
    assert.ok(counted.cachedUnits <= 32 * 1024 * 1024, `cachedUnits ${counted.cachedUnits} exceeds the byte ceiling`)
    assert.ok(counted.cachedUnits >= body.length * 500, 'eviction must not empty the cache')
  })
})

await test('a changed revision is re-parsed incrementally and lands on the same symbols', async () => {
  await withFixture('symbol-map-incremental', async workspace => {
    const file = path.join(workspace, 'inc.ts')
    // A multi-byte header on purpose: the binding indexes in UTF-16 code units, so an edit computed
    // from byte offsets would shift every node after the comment and the reused nodes would report
    // whatever text now sits at their old offsets — a silently wrong map, not a slow one.
    const source = method => [
      '// 中文注释：编辑前的标题保持不变', // 1
      'export class Widget {',            // 2
      '  render() {',                     // 3
      '    return 1',                     // 4
      '  }',                              // 5
      '',                                 // 6
      `  ${method}() {}`,                 // 7
      '}',                                // 8
      '',                                 // 9
      'export function tail() {}',        // 10
      '',
    ].join('\n')
    seed(workspace, { 'inc.ts': source('resize') })
    resetCaches()
    const cold = getSymbolMap(file)
    assert.deepEqual(cold.symbols.map(symbol => symbol.name), ['Widget', 'render', 'resize', 'tail'])

    // A longer name: one contiguous edit whose length changes, which is the case a same-length
    // shortcut would silently mis-handle.
    fs.writeFileSync(file, source('resizeToFit'))
    const warm = getSymbolMap(file)
    const full = getSymbolMap(file, { force: true })
    assert.equal(warm.cacheHit, false, 'a changed revision is a miss, not a hit')
    assert.deepEqual(warm.symbols, full.symbols, 'the incremental map equals a full rebuild')
    assert.deepEqual(warm.symbols.map(symbol => symbol.name), ['Widget', 'render', 'resizeToFit', 'tail'])
    const counted = stats()
    assert.equal(counted.parses, 3, 'cold, incremental and forced each parsed once')
    assert.equal(counted.queryCompiles, 0, 'incremental re-parse also stays on the queryless walk')
  })
})

await test('a scoped view is never cached and cannot poison the full map', async () => {
  await withFixture('symbol-map-scope-cache', async workspace => {
    seed(workspace, { 'good.ts': GOOD })
    const file = path.join(workspace, 'good.ts')
    resetCaches()
    getSymbolMap(file)
    const scoped = getSymbolMap(file, { scope: '6-12' })
    assert.equal(scoped.cacheHit, false)
    assert.equal(scoped.total, 3)
    assert.equal(getSymbolMap(file, { scope: '6-12' }).cacheHit, false, 'a window is a view, not a map')
    const full = getSymbolMap(file)
    assert.equal(full.cacheHit, true)
    assert.equal(full.total, 5, 'the cached full map is still the full map')
    assert.equal(stats().cachedFiles, 1)
  })
})

await test('the snapshot knows when it has gone stale, and says which of the three cases it is', async () => {
  await withFixture('symbol-map-snapshot', async workspace => {
    const file = path.join(workspace, 'good.ts')
    seed(workspace, { 'good.ts': GOOD })
    const map = getSymbolMap(file)
    assert.equal(verifySymbolMap(map).reason, 'fresh')
    assert.equal(verifySymbolMap(map).valid, true)
    assert.equal(verifySymbolMap({ file, hash: map.hash }).reason, 'fresh', 'the short hash is accepted as the expected identity')
    assert.equal(verifySymbolMap(map, path.join(workspace, 'nope.ts')).reason, 'missing')
    assert.equal(verifySymbolMap(map, path.join(workspace, 'nope.ts')).revision, null)
    fs.appendFileSync(file, '\n// touched\n')
    const stale = verifySymbolMap(map)
    assert.equal(stale.valid, false)
    assert.equal(stale.reason, 'stale')
    assert.equal(stale.expected, map.revision)
    assert.notEqual(stale.revision, map.revision)
  })
})

report('symbol-map')
