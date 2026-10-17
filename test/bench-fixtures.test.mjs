/**
 * The fixture-family gate: the csv / log / tree / symbol builders (P2) plus the
 * corpus / deep / repair families (P3), the seeded PRNG they share, and the
 * derivation functions that prove every exported expectation is recomputable from
 * the bytes the builder itself wrote.
 *
 * `test/bench.test.mjs` keeps the whole-corpus gate; this suite is the split
 * slice's own gate and runs standalone in the ordinary `node test/run.mjs` sweep.
 * The parameters are small on purpose — the deadline is 120s, and a 20000-row CSV
 * proves nothing about determinism that a 200-row one does not.
 *
 * @module dsh-ops/test/bench-fixtures
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { assert, report, test, withTempDir } from './lib/harness.mjs'

import {
  brokenProject, configTree, deepCorpus, deepModule, deriveConfigTree, deriveDeepModule,
  deriveGrepTree, deriveLargeCsv, deriveLogStats, deriveNoisySuite, deriveRenameTree,
  deriveSymbolTree, gatePipeline, generate, GENERATORS, grepTree, largeCsv, logStats,
  mulberry32, noisySuite, renameTree, symbolTree,
} from '../bench/lib/fixtures/index.mjs'

const LABEL = 'bench-fixtures'

/** Small parameters: the same shapes as the shipped corpus, cheap to build. */
const SMALL = {
  grepTree: { seed: 1, dirs: 2, filesPerDir: 6, linesPerFile: 8, needle: 'NEEDLE_X7Q', needleFiles: 3 },
  renameTree: { seed: 2, count: 6, lines: 2 },
  largeCsv: { seed: 7, rows: 200, targetRegion: 'EU', regions: ['EU', 'US', 'APAC', 'LATAM'] },
  brokenProject: { seed: 11 },
  logStats: { seed: 13, files: 4, linesPerFile: 20 },
  configTree: { seed: 21, packages: 3, env: 'production' },
  deepModule: { seed: 23, lines: 400, env: 'staging' },
  deepCorpus: { seed: 41, shards: 3, charsPerShard: 4000, pagesPerShard: 6 },
  noisySuite: { seed: 29, tests: 200 },
  symbolTree: { seed: 31, files: 6 },
  gatePipeline: { seed: 53, gates: 4, probes: 3, linesPerGate: 4 },
}

/** The complete registry: every family builder, in the order `GENERATORS` lists them. */
const ALL_GENERATORS = [
  'brokenProject', 'configTree', 'deepCorpus', 'deepModule', 'gatePipeline', 'grepTree',
  'largeCsv', 'logStats', 'noisySuite', 'renameTree', 'symbolTree',
]

/** Write one generated file into a workspace, creating its parents. */
const write = (dir, file) => {
  const target = path.join(dir, ...file.path.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, file.content, 'utf8')
}

// ---------------------------------------------------------------- fixtures

await test('the PRNG is deterministic and in range', () => {
  const a = mulberry32(42)
  const b = mulberry32(42)
  const values = []
  for (let i = 0; i < 500; i += 1) {
    const value = a()
    values.push(value)
    assert.equal(value, b())
    assert.ok(value >= 0 && value < 1, `value ${value} out of range`)
  }
  assert.notEqual(mulberry32(43)(), values[0], 'a different seed must produce a different stream')
})

await test('every generator is byte-stable for one seed', () => {
  for (const [name, params] of Object.entries(SMALL)) {
    const first = generate(name, params)
    const second = generate(name, params)
    assert.deepEqual(first, second, `${name} changed between two runs of the same seed`)
    assert.ok(first.files.length > 0, `${name} produced no files`)
  }
})

await test('generated paths are POSIX-relative and never escape the workspace', () => {
  for (const [name, params] of Object.entries(SMALL)) {
    for (const file of generate(name, params).files) {
      assert.ok(!file.path.startsWith('/'), `${name}: absolute path ${file.path}`)
      assert.ok(!file.path.includes('\\'), `${name}: backslash in ${file.path}`)
      assert.ok(!file.path.includes('..'), `${name}: escaping path ${file.path}`)
    }
  }
})

await test('grepTree marks exactly the declared files and no others', () => {
  const { files, exports } = grepTree(SMALL.grepTree)
  assert.equal(files.length, 12)
  assert.equal(exports.matches.length, 3)
  assert.deepEqual(exports.matches, [...exports.matches].sort(), 'matches must be sorted')
  assert.deepEqual(deriveGrepTree(files, exports.needle), exports, 'the tree must produce the exported answer')
  const byPath = new Map(files.map((file) => [file.path, file.content]))
  for (const match of exports.matches) {
    assert.ok(byPath.get(match).includes(exports.needle), `${match} is declared but has no needle`)
  }
})

await test('largeCsv exports the sum recomputed from its own bytes', () => {
  const { files, exports } = largeCsv(SMALL.largeCsv)
  assert.equal(files.length, 1)
  const lines = files[0].content.trim().split('\n')
  assert.equal(lines[0], 'id,region,amount')
  assert.equal(lines.length - 1, SMALL.largeCsv.rows)
  assert.deepEqual(deriveLargeCsv(files, exports.targetRegion), exports, 'the sum must come from the file')
  assert.ok(exports.hits > 0, 'a fixture nobody matches is not a test')
})

await test('renameTree produces the numbered files and content hashes the prompt describes', () => {
  const { files, exports } = renameTree(SMALL.renameTree)
  const numbered = Array.from({ length: 6 }, (_unused, index) => `data/TEMP_${String(index + 1).padStart(4, '0')}.dat`)
  assert.deepEqual(files.map((file) => file.path), numbered)
  assert.equal(files[0].content.trim().split('\n').length, 2)
  assert.deepEqual(deriveRenameTree(files), exports, 'the hash manifest must be of the real bytes')
  const renamed = Array.from({ length: 6 }, (_unused, index) => `DATA_${String(index + 1).padStart(4, '0')}.dat`)
  assert.deepEqual(exports.hashes.map((entry) => entry.name), renamed)
})

await test('logStats exports the ERROR counts recomputed from its own bytes', () => {
  const { files, exports } = logStats(SMALL.logStats)
  assert.equal(files.length, 4)
  assert.deepEqual(deriveLogStats(files), exports, 'the exported report must match the logs')
  assert.deepEqual(exports.report, [...exports.report].sort(), 'the report must be in file-name order')
})

await test('configTree separates the winning layer from every look-alike', () => {
  const { files, exports } = configTree(SMALL.configTree)
  const read = (name) => files.find((file) => file.path === name)?.content ?? ''
  const layers = Object.values(exports.layers)
  assert.equal(new Set(layers).size, layers.length, 'every layer must carry a different number')
  assert.deepEqual(deriveConfigTree(files, { key: exports.key, env: exports.env }), exports, 'the winner must follow the precedence')
  assert.match(read('README.md'), /config\/defaults\.json[\s\S]*config\/production\.json[\s\S]*config\/production\.local\.json/, 'the README must state the merge order')
  assert.ok(files.some((file) => file.path.startsWith('packages/') && file.path.endsWith('config.json')), 'the decoy file must exist')
  // The degenerate input is refused, not silently undefined: with no package-local
  // config there is no byte to read the decoy back from.
  assert.throws(
    () => deriveConfigTree(configTree({ seed: 21, packages: 0 }).files, { key: exports.key, env: exports.env }),
    /cannot be derived/,
  )
})

await test('deepModule puts the table and the function far apart, with wrong decoys', () => {
  const { files, exports } = deepModule(SMALL.deepModule)
  const lines = files[0].content.replace(/\n$/, '').split('\n')
  assert.equal(lines.length, exports.lines)
  const tableAt = lines.findIndex((line) => line.startsWith(`const ${exports.tableName} =`))
  const fnAt = lines.findIndex((line) => line.startsWith(`export function ${exports.fnName}(`))
  assert.ok(tableAt > lines.length * 0.4 && tableAt < lines.length * 0.7, `the table must sit in the middle, found at ${tableAt}`)
  assert.ok(fnAt > lines.length - 20, `the function must sit at the end, found at ${fnAt}`)
  assert.ok(fnAt - tableAt > lines.length / 3, 'the two ranges must be genuinely distant')
  assert.deepEqual(deriveDeepModule(files, { env: exports.env }), exports, 'the answer and both decoys must come from the module')
})

await test('noisySuite fails once, names it uniquely, and exits non-zero', async () => {
  const { files, exports } = noisySuite(SMALL.noisySuite)
  const runner = files.find((file) => file.path === 'runner.js').content
  assert.equal(runner.split('`not ok ').length, 2, 'the runner must print exactly one not-ok line')
  assert.deepEqual(deriveNoisySuite(files), exports, 'the failure the runner prints must be the exported one')
  await withTempDir('bench-fixtures-', async (dir) => {
    files.forEach((file) => write(dir, file))
    // stdio "ignore": the exit code is the premise the task rests on, and the one
    // failure line is checked structurally above.
    const outcome = spawnSync(process.execPath, ['runner.js'], { cwd: dir, stdio: 'ignore', timeout: 30000 })
    assert.equal(outcome.status, 1, 'the generated suite must exit non-zero')
  })
})

await test('symbolTree renames one symbol and leaves its look-alikes alone', () => {
  const { files, exports } = symbolTree(SMALL.symbolTree)
  const broken = new Map(files.filter((file) => file.path.startsWith('src/')).map((file) => [file.path, file.content]))
  const fixed = new Map(exports.fixedFiles.map((file) => [file.path, file.content]))
  assert.equal(broken.size, fixed.size)
  const coreAfter = fixed.get('src/core.js')
  assert.ok(broken.get('src/core.js').includes(`export function ${exports.from}(`))
  assert.equal(coreAfter.includes(`export function ${exports.from}(`), false, 'the old definition must be gone')
  assert.ok(coreAfter.includes(`export function ${exports.to}(`))
  for (const lookAlike of [`${exports.from}Legacy`, `${exports.from}Async`]) {
    assert.ok(coreAfter.includes(`export function ${lookAlike}(`), `${lookAlike} must survive the rename`)
  }
  assert.ok(coreAfter.includes(`Promise.resolve(${exports.to}(raw))`), 'a call site inside a look-alike must still be renamed')
  const untouched = [...broken.keys()].filter((name) => broken.get(name) === fixed.get(name))
  assert.ok(untouched.length > 0, 'at least one file must not mention the symbol at all')
  for (const name of untouched) assert.ok(!broken.get(name).includes(`${exports.from}(`), `${name} should not call the renamed symbol`)
  assert.deepEqual(
    deriveSymbolTree(files, { from: exports.from, to: exports.to }),
    { final: exports.final, fixedFiles: exports.fixedFiles, files: exports.files },
    'the rename must be recomputable from the broken bytes alone',
  )
  const alt = symbolTree({ seed: 32, files: 5, from: 'loadThing', to: 'fetchThing' })
  assert.deepEqual(
    deriveSymbolTree(alt.files, { from: alt.exports.from, to: alt.exports.to }).fixedFiles,
    alt.exports.fixedFiles,
    'a non-default rename must be recomputable too',
  )
  assert.ok(files.some((file) => file.path === 'check.mjs'), 'the smoke check must ship with the fixture')
  // The documented floor: fewer than five files cannot include the never-touched
  // shape, and the generator refuses rather than shipping a rename with no survivor.
  assert.throws(() => symbolTree({ seed: 31, files: 3 }), /at least one file must be unaffected/)
})

await test('deepCorpus answers come from the index maximum and nowhere else', () => {
  const { files, exports } = deepCorpus(SMALL.deepCorpus)
  const readme = files.find((file) => file.path === 'README.md').content
  assert.ok(readme.includes('## Index') && readme.includes('VOID SETTLE'), 'the rule sheet must state the rule')
  const shards = files.filter((file) => file.path.startsWith('shards/'))
  assert.equal(shards.length, exports.shards)
  assert.equal(exports.report.length, exports.shards)
  // Re-derive the whole report from the bytes: the highest *indexed* page decides.
  const derived = []
  for (const shard of shards) {
    const name = shard.path.split('/').pop().replace(/\.md$/, '')
    const indexed = [...shard.content.matchAll(/^- page (\d+) —/gm)].map((match) => Number(match[1]))
    assert.ok(indexed.length >= 4, `${name}: the index must list pages`)
    const livePage = Math.max(...indexed)
    const candidates = [...shard.content.matchAll(/^- SETTLE (\S+) page=(\d+) amount=(\d+)$/gm)]
      .map((match) => ({ shard: match[1], page: Number(match[2]), amount: match[3] }))
    assert.equal(candidates.length, 4, `${name}: four candidate settlements`)
    const live = candidates.filter((line) => line.page === livePage)
    assert.equal(live.length, 1, `${name}: exactly one candidate names the index maximum`)
    derived.push(`${name} ${live[0].amount}`)
    // A decoy really is a wrong answer: an unindexed page sits above the live one, so
    // "the highest page anywhere" and "the first SETTLE line" both lose.
    const everyPage = [...shard.content.matchAll(/page=(\d+)/g)].map((match) => Number(match[1]))
    assert.ok(Math.max(...everyPage) > livePage, `${name}: an unindexed page must sit above the live page`)
    // Bulk prose may never carry a marker, or "search for SETTLE" would not be exact.
    assert.equal(shard.content.split('SETTLE').length, 7, 'each shard carries exactly 4 ledger + 2 void markers')
  }
  assert.deepEqual(derived, exports.report, 'the exported report must be the one the rule produces')
  assert.deepEqual(exports.report, [...exports.report].sort(), 'the report must be in ascending shard order')
  assert.ok(exports.chars > 0)
})

await test('brokenProject fails as shipped and passes when repaired', async () => {
  const { files, exports } = brokenProject(SMALL.brokenProject)
  assert.equal(exports.fixes.length, 3, 'exactly three defects, one per source file')
  await withTempDir('bench-broken-', async (dir) => {
    files.forEach((file) => write(dir, file))
    // stdio "ignore": the exit code is the whole assertion, and a confined parent
    // (this suite under the DSH sandbox) cannot always open the pipes of a capturing spawn.
    const broken = spawnSync(process.execPath, ['test.js'], { cwd: dir, stdio: 'ignore', timeout: 30000 })
    assert.equal(broken.status, 1, `the broken project must fail on an assertion, got status ${broken.status}`)
    exports.fixes.forEach((fix) => write(dir, fix))
    const fixed = spawnSync(process.execPath, ['test.js'], { cwd: dir, stdio: 'ignore', timeout: 30000 })
    assert.equal(fixed.status, 0, `the repaired project must pass, got status ${fixed.status}`)
    assert.equal(exports.testSource, fs.readFileSync(path.join(dir, 'test.js'), 'utf8'), 'the anti-tamper expectation must be the real test.js')
  })
})

await test('gatePipeline breaks exactly one constant per stage and its repairs green the gate', async () => {
  const { files, exports } = gatePipeline(SMALL.gatePipeline)
  const broken = new Map(files.map((file) => [file.path, file.content]))
  assert.equal(exports.fixes.length, exports.gates, 'every stage needs a repair')
  for (const fix of exports.fixes) {
    const before = broken.get(fix.path).split('\n')
    const after = fix.content.split('\n')
    assert.equal(before.length, after.length, `${fix.path}: a repair may not change the shape`)
    assert.equal(before.filter((line, at) => line !== after[at]).length, 1, `${fix.path}: exactly one line may differ`)
  }
  // The chain input is never a probe, so a stage that memorises the golden values
  // instead of implementing its contract cannot produce the final answer.
  assert.ok(!exports.probes.includes(7), 'the chain seed must not be one of the probes')
  await withTempDir('bench-gates-', async (dir) => {
    files.forEach((file) => write(dir, file))
    const runGate = () => spawnSync(process.execPath, ['check.js'], { cwd: dir, encoding: 'utf8', timeout: 30000 })
    const untouched = runGate()
    assert.equal(untouched.status, 1, 'the gate must fail before any repair')
    assert.match(untouched.stdout, /not ok 1 - gate_0/, 'the gate must stop at the first stage')
    exports.fixes.forEach((fix) => write(dir, fix))
    const repaired = runGate()
    assert.equal(repaired.status, 0, `the repaired gate must pass: ${repaired.stdout.slice(-400)}`)
    assert.ok(repaired.stdout.includes(`# final value ${exports.answer}`), 'the gate prints the value the task is judged on')
  })
})

await test('generate() rejects an unknown generator by name', () => {
  assert.throws(() => generate('nope', {}), /unknown fixture generator/)
  // The complete registry, asserted as an exact list *and* a count: a family that
  // exists but was never registered (or never re-exported) is unreachable, and a
  // duplicate or a stray extra key has to fail here rather than in a task run.
  assert.deepEqual(Object.keys(GENERATORS).sort(), ALL_GENERATORS)
  assert.equal(Object.keys(GENERATORS).length, 11)
  assert.deepEqual(Object.keys(SMALL).sort(), ALL_GENERATORS, 'the small-parameter table must cover every registered generator')
  for (const [name, builder] of Object.entries(GENERATORS)) assert.equal(typeof builder, 'function', `${name} must be exported as a builder`)
})

report(LABEL)
