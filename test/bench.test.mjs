/**
 * The benchmark corpus gate: fixtures, verify, aggregate, compare-core, tasks.
 *
 * Everything here is the harness's own arithmetic — no model, no server, no dsh,
 * so it runs on any platform in the ordinary `node test/run.mjs` gate. The corpus
 * is the experiment, so the experiment is what gets tested: that a fixture is
 * byte-stable and self-consistent, that every check type can both pass and fail,
 * that a stream of events becomes exact numbers, and that two summaries become a
 * comparison whose gates fire for the right reasons.
 *
 * Fixtures run with small parameters on purpose: the gate has a 120 s per-suite
 * deadline, and a 20000-row CSV proves nothing about determinism that a 200-row
 * one does not.
 *
 * @module dsh-ops/test/bench
 */

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assert, report, test, withTempDir, TEST_HOME } from './lib/harness.mjs'

import { GENERATORS, generate, mulberry32, brokenProject, configTree, deepCorpus, deepModule, gatePipeline, grepTree, largeCsv, logStats, noisySuite, renameTree, symbolTree } from '../bench/lib/fixtures.mjs'
import { CHECK_TYPES, contentLines, countFiles, verifyWorkspace } from '../bench/lib/verify.mjs'
import { aggregateLines, createAggregator, METRICS_FORMAT } from '../bench/lib/aggregate.mjs'
import { aggregateTask, compareSummaries, geometricMeanPct, median, minValue, percentChange } from '../bench/lib/compare-core.mjs'
import { DEFAULT_TIMEOUT_MS, loadTasks, selectTasks, TASKS_DIR, validateTask } from '../bench/lib/tasks.mjs'
import { createObserver, decodeConsoleBytes, describeEvent, formatClock, OBSERVER_LEVELS } from '../bench/lib/observe.mjs'
import { describeModulePath } from '../bench/lib/env.mjs'
import { buildSummary, createLogger, defaultRunFolder, dryRun, extractEndpoints, extractModel, parseArgs, pipedSpawnBlocker, placeholderLines, prepareOut, probeEndpoints, repeatsById, main as runMain } from '../bench/run.mjs'
import { main as compareMain, parseArgs as parseCompareArgs, renderMarkdown, reportDir, resolveSide } from '../bench/compare.mjs'
import { approvalPolicyFor, ensureLlmOverlay, entryConfigValue, inspectLocalBuild, nextStepLines, parseArgs as parseSetupArgs, permissionEntries, planEntryPatch, planPatchEntries, planProfilePatch, poisonedModulePath, specVersion } from '../bench/setup.mjs'
import { nextFolderName } from '../bench/lib/next-folder.mjs'

const LABEL = 'bench'

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

const json = (...objects) => objects.map((object) => JSON.stringify(object)).join('\n')

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
  const byPath = new Map(files.map((file) => [file.path, file.content]))
  for (const match of exports.matches) {
    assert.ok(byPath.get(match).includes(exports.needle), `${match} is declared but has no needle`)
  }
  const withNeedle = files.filter((file) => file.content.includes(exports.needle)).map((file) => file.path).sort()
  assert.deepEqual(withNeedle, exports.matches, 'the tree disagrees with the exported answer')
})

await test('largeCsv exports the sum recomputed from its own bytes', () => {
  const { files, exports } = largeCsv(SMALL.largeCsv)
  assert.equal(files.length, 1)
  const lines = files[0].content.trim().split('\n')
  assert.equal(lines[0], 'id,region,amount')
  assert.equal(lines.length - 1, SMALL.largeCsv.rows)
  let sum = 0
  let hits = 0
  for (const line of lines.slice(1)) {
    const [, region, amount] = line.split(',')
    if (region === exports.targetRegion) {
      sum += Number(amount)
      hits += 1
    }
  }
  assert.equal(exports.sum, sum, 'exported sum must match the file')
  assert.equal(exports.hits, hits, 'exported hit count must match the file')
  assert.ok(hits > 0, 'a fixture nobody matches is not a test')
})

await test('renameTree produces the numbered files and content hashes the prompt describes', () => {
  const { files, exports } = renameTree(SMALL.renameTree)
  assert.equal(exports.count, 6)
  assert.equal(files.length, 6)
  assert.deepEqual(files.map((file) => file.path), [
    'data/TEMP_0001.dat', 'data/TEMP_0002.dat', 'data/TEMP_0003.dat',
    'data/TEMP_0004.dat', 'data/TEMP_0005.dat', 'data/TEMP_0006.dat',
  ])
  assert.equal(files[0].content.trim().split('\n').length, 2)
  // The hash manifest is how "renamed, never rewritten" gets proven: one entry per
  // file, keyed by the POST-rename name, of the content the generator wrote.
  assert.equal(exports.hashes.length, 6)
  assert.deepEqual(exports.hashes.map((entry) => entry.name), [
    'DATA_0001.dat', 'DATA_0002.dat', 'DATA_0003.dat',
    'DATA_0004.dat', 'DATA_0005.dat', 'DATA_0006.dat',
  ])
  for (let i = 0; i < 6; i += 1) {
    const want = createHash('sha256').update(files[i].content, 'utf8').digest('hex')
    assert.equal(exports.hashes[i].sha256, want, `hash ${i} must be of the real bytes`)
  }
})

await test('logStats exports the ERROR counts recomputed from its own bytes', () => {
  const { files, exports } = logStats(SMALL.logStats)
  assert.equal(files.length, 4)
  const expected = files.map((file) => {
    const name = file.path.split('/').pop()
    const count = file.content.split('\n').filter((line) => line.includes('ERROR')).length
    return `${name} ${count}`
  })
  assert.deepEqual(exports.report, expected, 'the exported report must match the logs')
  assert.deepEqual(exports.report, [...exports.report].sort(), 'the report must be in file-name order')
})

await test('brokenProject fails as shipped and passes when repaired', async () => {
  await withTempDir('bench-fixtures-', async (dir) => {
    const { files, exports } = brokenProject(SMALL.brokenProject)
    for (const file of files) {
      const target = path.join(dir, ...file.path.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, file.content, 'utf8')
    }
    // stdio "ignore": the exit code is the whole assertion, and a confined parent
    // (this suite under the DSH sandbox) cannot always open the pipes of a
    // capturing spawn.
    const broken = spawnSync(process.execPath, ['test.js'], { cwd: dir, stdio: 'ignore', timeout: 30000 })
    assert.equal(broken.status, 1, `the broken project must fail on an assertion, got status ${broken.status}`)

    for (const fix of exports.fixes) {
      fs.writeFileSync(path.join(dir, ...fix.path.split('/')), fix.content, 'utf8')
    }
    const fixed = spawnSync(process.execPath, ['test.js'], { cwd: dir, stdio: 'ignore', timeout: 30000 })
    assert.equal(fixed.status, 0, `the repaired project must pass, got status ${fixed.status}`)
    assert.equal(exports.testSource, fs.readFileSync(path.join(dir, 'test.js'), 'utf8'), 'the anti-tamper expectation must be the real test.js')
  })
})

await test('configTree separates the winning layer from every look-alike', () => {
  const { files, exports } = configTree(SMALL.configTree)
  const read = (name) => files.find((file) => file.path === name)?.content ?? ''
  const values = Object.values(exports.layers)
  assert.equal(new Set(values).size, values.length, 'every layer must carry a different number')
  assert.equal(exports.value, exports.layers.local, 'the answer is the last layer to define the key')
  assert.notEqual(exports.value, exports.layers.decoy, 'the package-local file is not part of the merge')
  assert.match(read('README.md'), /config\/defaults\.json[\s\S]*config\/production\.json[\s\S]*config\/production\.local\.json/, 'the README must state the merge order')
  assert.ok(read(exports.source).includes(`"${exports.key}": ${exports.value}`), 'the winning file must really hold the value')
  assert.ok(files.some((file) => file.path.startsWith('packages/') && file.path.endsWith('config.json')), 'the decoy file must exist')
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
  assert.ok(files[0].content.includes(`  ${exports.env}: ${exports.value},`))
  assert.notEqual(exports.value, exports.stale)
  assert.notEqual(exports.value, exports.legacy)
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
    assert.equal(live[0].shard, name, `${name}: the line must name its own shard`)
    // A decoy really is a wrong answer: an unindexed page sits above the live one, so
    // "the highest page anywhere in the file" and "the first SETTLE line" both lose.
    const everyPage = [...shard.content.matchAll(/page=(\d+)/g)].map((match) => Number(match[1]))
    assert.ok(Math.max(...everyPage) > livePage, `${name}: an unindexed page must sit above the live page`)
    derived.push(`${name} ${live[0].amount}`)
  }
  assert.deepEqual(derived, exports.report, 'the exported report must be the one the rule produces')
  assert.deepEqual(exports.report, [...exports.report].sort(), 'the report must be in ascending shard order')
  assert.ok(exports.chars > 0)
  // Bulk prose may never carry a marker, or "search for SETTLE" would not be exact.
  for (const shard of shards) {
    assert.equal(shard.content.split('SETTLE').length, 7, 'each shard carries exactly 4 ledger + 2 void markers')
    const prose = shard.content.split('\n').filter((line) => line.includes('SETTLE') && !line.startsWith('- '))
    assert.deepEqual(prose, [], 'no prose line may mention SETTLE')
  }
})

await test('noisySuite fails once, names it uniquely, and exits non-zero', async () => {
  const { files, exports } = noisySuite(SMALL.noisySuite)
  const runner = files.find((file) => file.path === 'runner.js').content
  assert.equal(runner.split('`not ok ').length, 2, 'the runner must print exactly one not-ok line')
  assert.ok(exports.failingIndex >= 0 && exports.failingIndex < exports.tests)
  await withTempDir('bench-noisy-', async (dir) => {
    for (const file of files) {
      const target = path.join(dir, ...file.path.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, file.content, 'utf8')
    }
    // `stdio: 'ignore'` can only see the exit code, and the exit code is the premise
    // the task rests on; the single failure line is checked structurally above.
    const outcome = spawnSync(process.execPath, ['runner.js'], { cwd: dir, stdio: 'ignore', timeout: 30000 })
    assert.equal(outcome.status, 1, 'the generated suite must exit non-zero')
  })
  const names = [...runner.matchAll(/^  "(.+)",?$/gm)].map((match) => match[1])
  assert.equal(names.length, exports.tests)
  assert.equal(names.filter((name) => name === exports.failingName).length, 1, 'the failing test name must be unique across the suite')
})

await test('symbolTree renames one symbol and leaves its look-alikes alone', () => {
  const { files, exports } = symbolTree(SMALL.symbolTree)
  const broken = new Map(files.filter((file) => file.path.startsWith('src/')).map((file) => [file.path, file.content]))
  const fixed = new Map(exports.fixedFiles.map((file) => [file.path, file.content]))
  assert.equal(broken.size, fixed.size)
  assert.equal(typeof exports.from, 'string')
  const coreBefore = broken.get('src/core.js')
  const coreAfter = fixed.get('src/core.js')
  assert.ok(coreBefore.includes(`export function ${exports.from}(`))
  assert.equal(coreAfter.includes(`export function ${exports.from}(`), false, 'the old definition must be gone')
  assert.ok(coreAfter.includes(`export function ${exports.to}(`))
  for (const lookAlike of [`${exports.from}Legacy`, `${exports.from}Async`]) {
    assert.ok(coreAfter.includes(`export function ${lookAlike}(`), `${lookAlike} must survive the rename`)
  }
  // The call inside the look-alike body is still a call site of the renamed symbol.
  assert.ok(coreAfter.includes(`Promise.resolve(${exports.to}(raw))`), 'a call site inside a look-alike must still be renamed')
  const untouched = [...broken.keys()].filter((name) => broken.get(name) === fixed.get(name))
  assert.ok(untouched.length > 0, 'at least one file must not mention the symbol at all')
  for (const name of untouched) assert.ok(!broken.get(name).includes(`${exports.from}(`), `${name} should not call the renamed symbol`)
  assert.equal(exports.final.length, fixed.size)
  assert.ok(files.some((file) => file.path === 'check.mjs'), 'the smoke check must ship with the fixture')
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
    const write = (file) => {
      const target = path.join(dir, ...file.path.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, file.content, 'utf8')
    }
    files.forEach(write)
    const runGate = () => spawnSync(process.execPath, ['check.js'], { cwd: dir, encoding: 'utf8' })
    const untouched = runGate()
    assert.equal(untouched.status, 1, 'the gate must fail before any repair')
    assert.match(untouched.stdout, /not ok 1 - gate_0/, 'the gate must stop at the first stage')
    exports.fixes.forEach(write)
    const repaired = runGate()
    assert.equal(repaired.status, 0, `the repaired gate must pass: ${repaired.stdout.slice(-400)}`)
    assert.ok(repaired.stdout.includes(`# final value ${exports.answer}`), 'the gate prints the value the task is judged on')
  })
})

await test('generate() rejects an unknown generator by name', () => {
  assert.throws(() => generate('nope', {}), /unknown fixture generator/)
  assert.deepEqual(Object.keys(GENERATORS).sort(), ['brokenProject', 'configTree', 'deepCorpus', 'deepModule', 'gatePipeline', 'grepTree', 'largeCsv', 'logStats', 'noisySuite', 'renameTree', 'symbolTree'])
})

// ---------------------------------------------------------------- verify

await test('verify covers each check type in both directions', async () => {
  await withTempDir('bench-verify-', async (dir) => {
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'answer.txt'), '  42\n', 'utf8')
    fs.writeFileSync(path.join(dir, 'list.txt'), 'a.txt\n\nb.txt\n', 'utf8')
    fs.writeFileSync(path.join(dir, 'sub', 'KEEP_1.txt'), 'x', 'utf8')
    fs.writeFileSync(path.join(dir, 'sub', 'KEEP_2.md'), 'y', 'utf8')
    const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
    const exports = {
      sum: 42,
      matches: ['a.txt', 'b.txt'],
      count: 2,
      hashes: [{ name: 'KEEP_1.txt', sha256: sha('x') }, { name: 'KEEP_2.md', sha256: sha('y') }],
      tamperedHashes: [{ name: 'KEEP_1.txt', sha256: sha('changed') }, { name: 'KEEP_2.md', sha256: sha('y') }],
      missingHashes: [{ name: 'KEEP_1.txt', sha256: sha('x') }, { name: 'KEEP_9.txt', sha256: sha('z') }],
    }

    const pass = await verifyWorkspace(dir, [
      { type: 'fileExists', path: 'answer.txt' },
      { type: 'fileMissing', path: 'gone.txt' },
      { type: 'fileEquals', path: 'answer.txt', expect: 'sum' },
      { type: 'fileContains', path: 'answer.txt', text: '4' },
      { type: 'fileLines', path: 'list.txt', expect: 'matches' },
      { type: 'countFiles', dir: 'sub', prefix: 'KEEP_', expect: 'count' },
      { type: 'contentHashes', dir: 'sub', expect: 'hashes' },
      { type: 'command', command: 'node', args: ['-e', 'process.exit(0)'], exitCode: 0 },
    ], exports)
    assert.equal(pass.passed, true, JSON.stringify(pass.checks))

    const fail = await verifyWorkspace(dir, [
      { type: 'fileExists', path: 'gone.txt' },
      { type: 'fileMissing', path: 'answer.txt' },
      { type: 'fileEquals', path: 'answer.txt', text: '43' },
      { type: 'fileContains', path: 'answer.txt', text: 'zzz' },
      { type: 'fileLines', path: 'list.txt', lines: ['b.txt', 'a.txt'] },
      { type: 'countFiles', dir: 'sub', extension: '.txt', count: 5 },
      { type: 'contentHashes', dir: 'sub', expect: 'tamperedHashes' },
      { type: 'contentHashes', dir: 'sub', expect: 'missingHashes' },
      { type: 'contentHashes', dir: 'sub', expect: 'count' },
      { type: 'command', command: 'node', args: ['-e', 'process.exit(3)'], exitCode: 0 },
    ], exports)
    assert.equal(fail.passed, false)
    assert.equal(fail.checks.length, 10)
    assert.ok(fail.checks.every((check) => check.passed === false), 'every check above was written to fail')
    assert.ok(fail.checks.every((check) => check.detail.length <= 210), 'details must stay short')
    // The contentHashes failure modes must name themselves, not just "failed".
    assert.match(fail.checks[6].detail, /content changed: KEEP_1\.txt/)
    assert.match(fail.checks[7].detail, /missing: KEEP_9\.txt/)
    assert.match(fail.checks[8].detail, /non-empty fixture export/)
  })
})

await test('contentHashes ignores the replace update-lock sidecars and nothing else', async () => {
  await withTempDir('bench-verify-lock-', async (dir) => {
    const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
    const exports = { hashes: [{ name: 'core.js', sha256: sha('renamed') }] }
    const check = [{ type: 'contentHashes', dir: '.', expect: 'hashes' }]
    fs.writeFileSync(path.join(dir, 'core.js'), 'renamed', 'utf8')

    // The candidate's `ops_replace` leaves these beside every file it edits: one per path,
    // created on first use and never unlinked. They are tool state, not tree content.
    fs.writeFileSync(path.join(dir, `.dsh-ops-update-${'a'.repeat(64)}.lock`), '', 'utf8')
    const tolerated = await verifyWorkspace(dir, check, exports)
    assert.equal(tolerated.passed, true, 'a 64-hex update-lock sidecar must not fail a byte-exact check')

    // The tolerance is the documented shape only: a near miss is a real unexpected file.
    fs.writeFileSync(path.join(dir, '.dsh-ops-update-abc.lock'), '', 'utf8')
    const nearMiss = await verifyWorkspace(dir, check, exports)
    assert.equal(nearMiss.passed, false, 'only `.dsh-ops-update-<64 hex>.lock` is tolerated')
    assert.match(nearMiss.checks[0].detail, /unexpected: \.dsh-ops-update-abc\.lock/)
  })
})

await test('a failing check does not stop the sweep', async () => {
  await withTempDir('bench-verify-', async (dir) => {
    fs.writeFileSync(path.join(dir, 'real.txt'), 'content', 'utf8')
    const verdict = await verifyWorkspace(dir, [
      { type: 'fileEquals', path: 'real.txt', text: 'other' },
      { type: 'fileExists', path: 'real.txt' },
    ], {})
    assert.equal(verdict.checks.length, 2, 'both checks must have run')
    assert.equal(verdict.checks[1].passed, true)
    assert.equal(verdict.passed, false)
  })
})

await test('verify reports an unknown expect key instead of guessing', async () => {
  await withTempDir('bench-verify-', async (dir) => {
    fs.writeFileSync(path.join(dir, 'x.txt'), 'x', 'utf8')
    const verdict = await verifyWorkspace(dir, [{ type: 'fileEquals', path: 'x.txt', expect: 'missingKey' }], {})
    assert.equal(verdict.passed, false)
    assert.match(verdict.checks[0].detail, /fixture exports have no key/)
  })
})

await test('verify rejects a command it cannot run', async () => {
  await withTempDir('bench-verify-', async (dir) => {
    const verdict = await verifyWorkspace(dir, [{ type: 'command', command: 'definitely-not-a-real-binary-xyz', exitCode: 0 }], {})
    assert.equal(verdict.passed, false)
    assert.ok(verdict.checks[0].detail !== '')
  })
})

await test('helpers count files and lines the way the checks claim', () => {
  assert.deepEqual(contentLines(' a \n\n b\n'), ['a', 'b'])
  assert.deepEqual(contentLines('a\r\nb\r\n'), ['a', 'b'])
  const dir = fs.mkdtempSync(path.join(TEST_HOME, 'bench-count-'))
  fs.mkdirSync(path.join(dir, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'A_1.txt'), '', 'utf8')
  fs.writeFileSync(path.join(dir, 'B_2.md'), '', 'utf8')
  fs.writeFileSync(path.join(dir, 'nested', 'A_3.txt'), '', 'utf8')
  assert.equal(countFiles(dir, {}), 3)
  assert.equal(countFiles(dir, { prefix: 'A_' }), 2)
  assert.equal(countFiles(dir, { extension: '.txt' }), 2)
  assert.equal(countFiles(dir, { prefix: 'A_', extension: '.txt' }), 2)
  assert.equal(countFiles(path.join(dir, 'nested'), {}), 1)
  assert.equal(countFiles(path.join(dir, 'absent'), {}), 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------- aggregate

await test('a complete stream aggregates exactly', () => {
  const lines = [
    JSON.stringify({ type: 'session', sessionId: 'session-abc', cwd: '/tmp/x' }),
    JSON.stringify({ type: 'status', phase: 'turn_start', turn: 0 }),
    JSON.stringify({ type: 'status', phase: 'step_start', turn: 0, step: 0 }),
    JSON.stringify({ type: 'thinking', text: 'hmm' }),
    JSON.stringify({ type: 'tool_call', callId: 'c1', tool: 'grep', input: { pattern: 'x' } }),
    JSON.stringify({ type: 'tool_result', callId: 'c1', status: 'completed', result: 'a lot' }),
    JSON.stringify({ type: 'tool_call', callId: 'c2', tool: 'ops_grep', input: 'raw string' }),
    JSON.stringify({ type: 'tool_result', callId: 'c2', status: 'error', result: 'boom' }),
    JSON.stringify({ type: 'status', phase: 'step_end', turn: 0, step: 0, usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 7, cacheWriteTokens: 3, reasoningTokens: 5 } }),
    JSON.stringify({ type: 'text', text: 'hello' }),
    JSON.stringify({ type: 'status', phase: 'step_start', turn: 0, step: 1 }),
    JSON.stringify({ type: 'status', phase: 'step_end', turn: 0, step: 1, usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
    JSON.stringify({ type: 'status', phase: 'turn_end', turn: 0, reason: { kind: 'completed' } }),
    JSON.stringify({ type: 'final', text: 'done' }),
  ]
  const metrics = aggregateLines(lines, { label: 'cand', profile: 'bench-ops', taskId: 'csv-sum', repeatIndex: 1 })
  assert.equal(metrics.format, METRICS_FORMAT)
  assert.equal(metrics.label, 'cand')
  assert.equal(metrics.repeatIndex, 1)
  assert.equal(metrics.sessionId, 'session-abc')
  assert.equal(metrics.turnEndReason, 'completed')
  assert.equal(metrics.turns, 1)
  assert.equal(metrics.steps, 2)
  assert.equal(metrics.stepsWithUsage, 2)
  assert.equal(metrics.usageReported, true)
  assert.deepEqual(metrics.usage, { inputTokens: 150, outputTokens: 30, cacheReadTokens: 7, cacheWriteTokens: 3, reasoningTokens: 5, grandTotal: 190 })
  assert.equal(metrics.toolCalls, 2)
  assert.equal(metrics.toolErrors, 1)
  assert.deepEqual(metrics.toolCallsByName, { grep: 1, ops_grep: 1 })
  assert.equal(metrics.textChars, 5)
  assert.equal(metrics.thinkingChars, 3)
  assert.equal(metrics.finalTextBytes, 4)
  assert.equal(metrics.eventCount, 14)
  assert.equal(metrics.malformedLines, 0)
  assert.deepEqual(metrics.errorEvents, [])
})

await test('a step without usage blocks the token verdict', () => {
  const lines = [
    JSON.stringify({ type: 'status', phase: 'step_end', turn: 0, step: 0, usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
    JSON.stringify({ type: 'status', phase: 'step_end', turn: 0, step: 1 }),
    JSON.stringify({ type: 'status', phase: 'turn_end', turn: 0, reason: { kind: 'completed' } }),
  ]
  const metrics = aggregateLines(lines)
  assert.equal(metrics.steps, 2)
  assert.equal(metrics.stepsWithUsage, 1)
  assert.equal(metrics.usageReported, false, 'a partial usage set must never be presented as complete')
  assert.equal(metrics.usage.grandTotal, 11, 'the partial sum is still recorded')
})

await test('a stream with no steps at all is not "usage reported"', () => {
  const metrics = aggregateLines([JSON.stringify({ type: 'text', text: 'x' })])
  assert.equal(metrics.steps, 0)
  assert.equal(metrics.usageReported, false)
  assert.equal(metrics.usage.grandTotal, 0)
})

await test('bad lines, error events and truncation are counted', () => {
  const metrics = aggregateLines([
    '{not json',
    '',
    '   ',
    JSON.stringify({ noType: true }),
    JSON.stringify({ type: 'error', message: 'x'.repeat(400) }),
    JSON.stringify({ type: 'text', text: 'cut', truncated: true }),
  ])
  assert.equal(metrics.malformedLines, 3)
  assert.equal(metrics.eventCount, 2)
  assert.equal(metrics.truncatedLines, 1)
  assert.equal(metrics.errorEvents.length, 1)
  assert.equal(metrics.errorEvents[0].message.length, 201, 'clamped to 200 characters plus the ellipsis')
})

await test('the streaming form and the batch form agree', () => {
  const lines = [
    JSON.stringify({ type: 'session', sessionId: 's' }),
    JSON.stringify({ type: 'tool_call', callId: 'c', tool: 'bash', input: {} }),
    JSON.stringify({ type: 'status', phase: 'step_end', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } }),
  ]
  const streaming = createAggregator({ taskId: 'x' })
  for (const line of lines) streaming.push(`${line}\n`)
  assert.deepEqual(streaming.finish(), aggregateLines(lines, { taskId: 'x' }))
})

await test('optional usage buckets are omitted until the provider reports them', () => {
  const bare = aggregateLines([JSON.stringify({ type: 'status', phase: 'step_end', usage: { inputTokens: 1, outputTokens: 1 } })])
  assert.equal('reasoningTokens' in bare.usage, false)
  assert.deepEqual(bare.usageBucketsSeen, ['inputTokens', 'outputTokens'])
  assert.equal(bare.usage.grandTotal, 2)
})

await test('every step\'s prompt is kept, and a lost first step is never promoted', () => {
  const metrics = aggregateLines([
    JSON.stringify({ type: 'status', phase: 'step_end', turn: 0, step: 0, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 7, cacheWriteTokens: 3 } }),
    JSON.stringify({ type: 'status', phase: 'step_end', turn: 0, step: 1, usage: { inputTokens: 50, outputTokens: 10 } }),
  ])
  assert.equal(metrics.prompt.reported, true)
  assert.equal(metrics.prompt.firstStep, 110, 'input + cache read + cache write, never the output')
  assert.equal(metrics.prompt.total, 160)
  assert.equal(metrics.prompt.max, 110)
  assert.equal(metrics.prompt.median, 80)
  assert.deepEqual(metrics.prompt.perTurn, [{ turn: 0, tokens: 110 }])

  // A provider that reports only the combined figure still yields a prompt size.
  const combined = aggregateLines([JSON.stringify({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { totalTokens: 120, outputTokens: 20 } })])
  assert.equal(combined.prompt.firstStep, 100)

  // The distinction that matters: losing step 1 must leave the first request unknown,
  // not hand step 2's smaller, already-warm prompt the title.
  const lost = aggregateLines([
    JSON.stringify({ type: 'status', phase: 'step_end', turn: 1, step: 1 }),
    JSON.stringify({ type: 'status', phase: 'step_end', turn: 1, step: 2, usage: { inputTokens: 50, outputTokens: 10 } }),
  ])
  assert.equal(lost.prompt.reported, false)
  assert.equal(lost.prompt.firstStep, null)
  assert.equal(lost.prompt.total, 50)

  const empty = aggregateLines([])
  assert.equal(empty.prompt.firstStep, null)
  assert.equal(empty.prompt.total, null)
  assert.deepEqual(empty.prompt.perTurn, [])
})

// ---------------------------------------------------------------- compare-core

await test('median and min behave on odd and even samples', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 2, 3]), 2.5)
  assert.equal(median([]), null)
  assert.equal(minValue([9, 2, 5]), 2)
  assert.equal(percentChange(200, 150), -25)
  assert.equal(percentChange(0, 5), null)
  assert.equal(percentChange(0, 0), 0)
})

/**
 * Build a synthetic metrics document.
 * @param {string} taskId - the task.
 * @param {number} tokens - the grand total.
 * @param {boolean} passed - the verify outcome.
 * @param {object} [extra] - overrides.
 * @returns {object} the metrics document.
 */
function run(taskId, tokens, passed, extra = {}) {
  const input = Math.round(tokens * 0.7)
  const output = tokens - input
  return {
    format: METRICS_FORMAT,
    taskId,
    repeatIndex: extra.repeatIndex ?? 0,
    usage: { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, grandTotal: tokens },
    usageReported: extra.usageReported ?? true,
    steps: extra.steps ?? 4,
    toolCalls: extra.toolCalls ?? 6,
    toolErrors: extra.toolErrors ?? 0,
    toolCallsByName: extra.toolCallsByName ?? {},
    verify: { passed, checks: [] },
    exitCode: extra.exitCode ?? 0,
    timedOut: false,
  }
}

/**
 * Build a synthetic summary document.
 * @param {string} label - the label.
 * @param {object[]} results - the metrics documents.
 * @param {object} [model] - the model identity.
 * @returns {object} the summary.
 */
function summary(label, results, model = { provider: 'bench-server', model: 'tester' }) {
  return { format: 'dsh-ops-bench-summary-v1', label, profile: `bench-${label}`, dshVersion: '0.2.0-rc.2', model, results }
}

/**
 * A metrics document whose usage totals and prompt shape agree with each other, so a
 * test can check the report's decomposition against the same arithmetic it claims:
 * `grandTotal = prompt total + output`, and the first request is the fixed cost.
 * @param {string} taskId - the task.
 * @param {{steps: number, first: number, perStep: number, output: number, repeatIndex?: number, passed?: boolean}} spec - the shape.
 * @returns {object} the metrics document.
 */
function shapedRun(taskId, { steps, first, perStep, output, repeatIndex = 0, passed = true }) {
  const promptTotal = perStep * steps
  return {
    format: METRICS_FORMAT,
    taskId,
    repeatIndex,
    usage: { inputTokens: promptTotal, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, grandTotal: promptTotal + output },
    usageReported: true,
    prompt: { reported: true, firstStep: first, median: perStep, max: perStep, total: promptTotal, perTurn: [{ turn: 1, tokens: first }] },
    steps,
    toolCalls: steps,
    toolErrors: 0,
    toolCallsByName: {},
    verify: { passed, checks: [] },
    exitCode: 0,
    timedOut: false,
  }
}

await test('aggregateTask produces medians, minima and a pass rate', () => {
  const task = aggregateTask([run('csv-sum', 100, true), run('csv-sum', 200, true, { repeatIndex: 1 }), run('csv-sum', 300, false, { repeatIndex: 2 })])
  assert.equal(task.repeats, 3)
  assert.equal(task.grandTotalMedian, 200)
  assert.equal(task.grandTotalMin, 100)
  assert.equal(task.passRate, 2 / 3)
  assert.equal(task.usageComplete, true)
  assert.deepEqual(aggregateTask([]).repeats, 0)
  assert.equal(aggregateTask([]).usageComplete, false)
})

await test('a 37% token win with equal pass rates clears both gates', () => {
  const base = summary('bench-base', [run('csv-sum', 1000, true), run('big-file-paging', 2000, true)])
  const cand = summary('bench-ops', [run('csv-sum', 630, true), run('big-file-paging', 1250, true)])
  const comparison = compareSummaries(base, cand, { failOn: 'both' })
  assert.equal(comparison.totals.baseGrandTotal, 3000)
  assert.equal(comparison.totals.candGrandTotal, 1880)
  assert.equal(comparison.totals.grandTotalPct, -37.3)
  assert.equal(comparison.gate.fail, false)
  assert.equal(comparison.gate.tokensComparable, true)
  assert.deepEqual(comparison.warnings, [])
  const csv = comparison.tasks.find((task) => task.id === 'csv-sum')
  assert.equal(csv.delta.grandTotalPct, -37)
  assert.equal(csv.delta.stepsPct, 0)
})

await test('a token regression fails the gate', () => {
  const base = summary('base', [run('csv-sum', 1000, true)])
  const cand = summary('cand', [run('csv-sum', 1300, true)])
  const comparison = compareSummaries(base, cand, { tolerancePct: 2, failOn: 'both' })
  assert.equal(comparison.gate.regressionFailed, true)
  assert.equal(comparison.gate.fail, true)
  assert.match(comparison.gate.reasons.join(' '), /token regression/)
  assert.equal(compareSummaries(base, cand, { tolerancePct: 40 }).gate.regressionFailed, false, 'inside tolerance the gate holds')
  assert.equal(compareSummaries(base, cand, { failOn: 'pass-drop' }).gate.fail, false, 'the regression gate is opt-in')
})

await test('a pass-rate drop fails the gate even when tokens fall', () => {
  const base = summary('base', [run('csv-sum', 1000, true), run('csv-sum', 1000, true)])
  const cand = summary('cand', [run('csv-sum', 500, true), run('csv-sum', 500, false)])
  const comparison = compareSummaries(base, cand, { failOn: 'both' })
  assert.equal(comparison.gate.regressionFailed, false)
  assert.equal(comparison.gate.passDropFailed, true)
  assert.equal(comparison.gate.fail, true)
  assert.match(comparison.gate.reasons.join(' '), /pass-drop: csv-sum 2\/2 -> 1\/2/)
})

await test('incomplete usage blocks the token gate and warns', () => {
  const base = summary('base', [run('csv-sum', 1000, true, { usageReported: false })])
  const cand = summary('cand', [run('csv-sum', 9000, true)])
  const comparison = compareSummaries(base, cand, { failOn: 'both' })
  assert.equal(comparison.gate.tokensComparable, false)
  assert.equal(comparison.gate.regressionFailed, false, 'a partial total must not be compared as if it were complete')
  assert.ok(comparison.warnings.includes('usage-incomplete:base'))
  assert.equal(comparison.gate.fail, false, 'only pass-drop survives, and passes are equal')
})

await test('the token delta decomposes into overhead, extra steps and context', () => {
  // Baseline: 5 steps, a 6,000-token first request, 7,000 per step thereafter.
  // Candidate: 7 steps, 8,000 first, 9,000 per step. Both sides' usage totals are
  // built from the same numbers, so the decomposition must reconstitute the delta.
  const base = summary('base', [shapedRun('csv-sum', { steps: 5, first: 6000, perStep: 7000, output: 300 })])
  const cand = summary('cand', [shapedRun('csv-sum', { steps: 7, first: 8000, perStep: 9000, output: 600 })])
  const comparison = compareSummaries(base, cand)
  const task = comparison.tasks[0]
  const o = task.overhead
  assert.equal(o.comparable, true)
  assert.equal(o.fixedOverheadTokens, 14000, '(8,000 - 6,000) on each of the candidate\'s 7 steps')
  assert.equal(o.extraStepsTokens, 12000, '2 extra steps at the baseline\'s 6,000-token request')
  assert.equal(o.promptTotalDelta, 63000 - 35000)
  assert.equal(o.residualTokens, 28000 - 14000 - 12000)
  assert.equal(o.outputDelta, 300)
  assert.equal(o.totalDelta, 28300)
  assert.equal(o.totalDelta, task.delta.grandTotalAbs, 'the decomposition must reconstitute the measured delta')
  assert.equal(task.delta.firstRequestPromptAbs, 2000)
  assert.equal(task.delta.firstRequestPromptPct, 33.3)
  assert.equal(comparison.overhead.comparable, true)
  assert.equal(comparison.overhead.comparableTasks, 1)
  assert.equal(comparison.overhead.fixedOverheadTokens, 14000)
  assert.equal(comparison.totals.buckets.grandTotal.delta, 28300)
  assert.equal(comparison.totals.buckets.input.sharePct, 98.9, 'the shares are of the total delta')

  // An archive with no prompt capture is not a zero overhead: it is an unknown one.
  const legacy = compareSummaries(summary('base', [run('csv-sum', 1000, true)]), summary('cand', [run('csv-sum', 1000, true)]))
  assert.equal(legacy.tasks[0].overhead.comparable, false)
  assert.equal(legacy.tasks[0].overhead.fixedOverheadTokens, null)
  assert.equal(legacy.overhead.comparable, false)
  assert.equal(legacy.tasks[0].delta.firstRequestPromptPct, null)
})

await test('a different model on each side is a loud warning', () => {
  const base = summary('base', [run('csv-sum', 1000, true)])
  const cand = summary('cand', [run('csv-sum', 1000, true)], { provider: 'other', model: 'other-model' })
  const comparison = compareSummaries(base, cand)
  assert.ok(comparison.warnings.some((warning) => warning.startsWith('model-mismatch')), comparison.warnings.join('\n'))
})

await test('tasks missing on one side are aligned and reported', () => {
  const base = summary('base', [run('csv-sum', 1000, true), run('only-base', 500, true)])
  const cand = summary('cand', [run('csv-sum', 1000, true)])
  const comparison = compareSummaries(base, cand, { failOn: 'none' })
  assert.equal(comparison.tasks.length, 2)
  const onlyBase = comparison.tasks.find((task) => task.id === 'only-base')
  assert.equal(onlyBase.inBase, true)
  assert.equal(onlyBase.inCand, false)
  assert.equal(onlyBase.cand.repeats, 0)
  assert.ok(comparison.warnings.includes('task-missing:cand:only-base'), comparison.warnings.join('\n'))
})

await test('the min aggregate is available and changes which number is compared', () => {
  const base = summary('base', [run('csv-sum', 100, true), run('csv-sum', 900, true), run('csv-sum', 900, true)])
  const cand = summary('cand', [run('csv-sum', 80, true), run('csv-sum', 900, true), run('csv-sum', 900, true)])
  const asMedian = compareSummaries(base, cand, { aggregate: 'median' })
  const asMin = compareSummaries(base, cand, { aggregate: 'min' })
  assert.equal(asMedian.totals.baseGrandTotal, 900)
  assert.equal(asMedian.totals.candGrandTotal, 900)
  assert.equal(asMin.totals.baseGrandTotal, 100)
  assert.equal(asMin.tasks[0].cand.grandTotalMin, 80)
  assert.equal(asMin.gate.regressionFailed, false, 'on minima the candidate is still cheaper, so the gate holds')
})

await test('CHECK_TYPES stays in step with the verifier the tasks are written against', () => {
  assert.deepEqual(CHECK_TYPES, ['fileExists', 'fileMissing', 'fileEquals', 'fileContains', 'fileLines', 'countFiles', 'contentHashes', 'command'])
})

await test('the per-task regression gate fires even when the summed TOTAL improves', () => {
  // The 2026-10-16 sweep shape, compressed: one big win must not launder a
  // regression on another task into a PASS.
  const base = summary('base', [run('csv-sum', 300000, true), run('big-file-paging', 50000, true)])
  const cand = summary('cand', [run('csv-sum', 100000, true), run('big-file-paging', 130000, true)])
  const asTask = compareSummaries(base, cand, { tolerancePct: 2, failOn: 'both', regressionScope: 'task' })
  assert.equal(asTask.totals.grandTotalPct, -34.3, 'the sum says 34% cheaper overall …')
  assert.equal(asTask.gate.regressionFailed, true, '… and the per-task gate still says no')
  assert.equal(asTask.tasks.find((task) => task.id === 'big-file-paging').regressed, true)
  assert.equal(asTask.tasks.find((task) => task.id === 'csv-sum').regressed, false)
  assert.match(asTask.gate.reasons.join(' '), /token regression: big-file-paging 130,000 > 51,000 \(base 50,000 \+ 2%\)/)
  // The scale-free overall figure: +160% and -66.7% average to about -7%, not -34%.
  assert.equal(asTask.totals.grandTotalGeomeanPct, -7)
  // The old scope is available and shows the masking it used to allow.
  const asTotal = compareSummaries(base, cand, { tolerancePct: 2, failOn: 'both', regressionScope: 'total' })
  assert.equal(asTotal.gate.regressionFailed, false, 'total scope is exactly the hole this change closes')
  const both = compareSummaries(base, cand, { tolerancePct: 2, failOn: 'both', regressionScope: 'both' })
  assert.equal(both.gate.regressionFailed, true, 'both scopes judge independently')
  // When the sum really does regress, its reason is labelled as such.
  const worse = summary('worse', [run('csv-sum', 1000, true)])
  const better = summary('better', [run('csv-sum', 1500, true)])
  const bothReasons = compareSummaries(worse, better, { tolerancePct: 2, failOn: 'regression', regressionScope: 'both' }).gate.reasons
  assert.match(bothReasons.join(' '), /token regression \(TOTAL\)/)
  assert.match(bothReasons.join(' '), /token regression: csv-sum 1,500/)
})

await test('geometricMeanPct skips unusable ratios and round-trips the equal-weight case', () => {
  assert.equal(geometricMeanPct([100, -50]), 0, '+100% and -50% cancel on equal weights')
  assert.equal(geometricMeanPct([-100]), null, 'a -100% ratio has no logarithm')
  assert.equal(geometricMeanPct([]), null)
  assert.equal(geometricMeanPct([null, -25, null]), -25, 'only the usable samples count')
})

// ---------------------------------------------------------------- the corpus itself

await test('the shipped corpus loads and validates', () => {
  const tasks = loadTasks(TASKS_DIR)
  assert.deepEqual(tasks.map((task) => task.id).sort(), ['api-rename', 'big-file-paging', 'config-hunt', 'csv-sum', 'gate-repair-loop', 'noisy-test-triage'])
  for (const task of tasks) {
    assert.ok(task.title.length > 0)
    assert.equal(typeof task.prompt, 'string')
    assert.ok(!task.prompt.startsWith('-'), `${task.id}: a leading "-" would be parsed as an option`)
    assert.ok(task.timeoutMs > 0)
    assert.ok(GENERATORS[task.fixture.generator], `${task.id}: generator must exist`)
    for (const check of task.verify) assert.ok(CHECK_TYPES.includes(check.type), `${task.id}: bad check ${check.type}`)
  }
  assert.equal(tasks.find((task) => task.id === 'csv-sum').timeoutMs, DEFAULT_TIMEOUT_MS)
  // The tiered budgets: every surviving task is sampled twice by default.
  assert.deepEqual(tasks.reduce((acc, task) => ({ ...acc, [task.id]: task.repeat }), {}), {
    'csv-sum': 2, 'config-hunt': 2, 'big-file-paging': 2, 'noisy-test-triage': 2,
    'api-rename': 2, 'gate-repair-loop': 2,
  })
  // The long-run tier: a small workspace split into enough fail-fast stages that
  // the step count cannot stay in single digits.
  const loop = tasks.find((task) => task.id === 'gate-repair-loop')
  assert.ok(loop.fixture.params.gates >= 24, 'the long-run task needs enough stages to force many turns')
  assert.ok(loop.fixture.params.probes >= 20, 'each round must leave a real log behind, not a single line')
  assert.ok(loop.timeoutMs > DEFAULT_TIMEOUT_MS, 'a 24-round repair loop needs more than the default deadline')
  assert.ok(loop.verify.some((check) => check.type === 'command' && check.exitCode === 0), 'the repaired gate is the verdict')
  assert.ok(loop.verify.some((check) => check.invariant === true), 'check.js must be guarded against tampering')
  // The two verdicts that are easy to get wrong: a rename is judged on bytes, and a
  // triage task must prove its premise (the suite really fails) before it runs.
  const apiRename = tasks.find((task) => task.id === 'api-rename')
  assert.ok(apiRename.verify.some((check) => check.type === 'contentHashes'), 'api-rename must be judged on file bytes')
  const triage = tasks.find((task) => task.id === 'noisy-test-triage')
  assert.ok(triage.verify.some((check) => check.type === 'command' && check.exitCode === 1 && check.invariant === true), 'the failing suite is a precondition, not an answer')
})

await test('every task fixture really exports the keys its checks reference', () => {
  const small = { 'csv-sum': SMALL.largeCsv, 'config-hunt': SMALL.configTree, 'big-file-paging': SMALL.deepModule, 'noisy-test-triage': SMALL.noisySuite, 'api-rename': SMALL.symbolTree, 'gate-repair-loop': SMALL.gatePipeline }
  for (const task of loadTasks(TASKS_DIR)) {
    const fixture = generate(task.fixture.generator, small[task.id] ?? task.fixture.params)
    for (const check of task.verify) {
      if (check.expect === undefined) continue
      assert.ok(Object.hasOwn(fixture.exports, check.expect), `${task.id}: verify references "${check.expect}", which ${task.fixture.generator} does not export`)
    }
    // And the answer must be non-trivial: an empty expectation would pass on garbage.
    if (Array.isArray(fixture.exports.matches)) assert.ok(fixture.exports.matches.length > 0)
    if (Array.isArray(fixture.exports.report)) assert.ok(fixture.exports.report.length > 0)
    if (Array.isArray(fixture.exports.final)) assert.ok(fixture.exports.final.length > 0)
    if (fixture.exports.sum !== undefined) assert.ok(Number.isInteger(fixture.exports.sum) && fixture.exports.sum > 0)
    if (fixture.exports.answer !== undefined) assert.ok(fixture.exports.answer.length > 0)
    if (fixture.exports.failingName !== undefined) assert.ok(fixture.exports.failingName.length > 0)
  }
})

await test('every task in the corpus is answerable and its own verify accepts it', async () => {
  // The strongest cheap invariant: write the answer the generator itself produced,
  // then run the task's REAL `verify` list against it. A task whose expected answer
  // its own checks would reject is not a measurement, it is a bug report waiting
  // for a full sweep to notice it. Full-size fixtures here, generated once each.
  for (const task of loadTasks(TASKS_DIR)) {
    const fixture = generate(task.fixture.generator, task.fixture.params ?? {})
    await withTempDir(`bench-answer-${task.id}-`, async (dir) => {
      for (const file of fixture.files) {
        const target = path.join(dir, ...file.path.split('/'))
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, file.content, 'utf8')
      }
      const answers = {
        'csv-sum': () => ['answer.txt', String(fixture.exports.sum)],
        'config-hunt': () => ['answer.txt', fixture.exports.answer],
        'big-file-paging': () => ['answer.txt', fixture.exports.answer],
        'noisy-test-triage': () => ['failure.txt', fixture.exports.failingName],
      }
      if (answers[task.id]) {
        const [answerPath, answerText] = answers[task.id]()
        fs.writeFileSync(path.join(dir, answerPath), `${answerText}\n`, 'utf8')
      } else if (task.id === 'api-rename') {
        for (const fixed of fixture.exports.fixedFiles) fs.writeFileSync(path.join(dir, ...fixed.path.split('/')), fixed.content, 'utf8')
      } else if (task.id === 'gate-repair-loop') {
        // The answer is only reachable through a green gate, so "answer it" means
        // repairing every stage *and* writing the final value the gate prints.
        for (const fix of fixture.exports.fixes) fs.writeFileSync(path.join(dir, ...fix.path.split('/')), fix.content, 'utf8')
        fs.writeFileSync(path.join(dir, 'answer.txt'), `${fixture.exports.answer}\n`, 'utf8')
      } else {
        assert.fail(`${task.id}: this suite does not know how to answer it`)
      }
      const verdict = await verifyWorkspace(dir, task.verify, fixture.exports, { execPath: process.execPath })
      assert.equal(verdict.passed, true, `${task.id}: ${JSON.stringify(verdict.checks)}`)
    })
  }
})

await test('run.mjs --dry-run semantics hold for the whole corpus', async () => {
  // PLAN §5.1: on an untouched workspace every check except fileMissing must fail.
  // This is the same function the CLI calls, so the corpus and the CLI agree.
  const tasks = loadTasks(TASKS_DIR)
  assert.equal(await dryRun(tasks, { keep: false }), true, 'dry-run self-check must pass for the shipped corpus')
  // A check that is already satisfied before the model lifts a finger measures
  // nothing; the self-check has to notice that, or the corpus is quietly toothless.
  const csvSum = selectTasks(tasks, ['csv-sum'])[0]
  const toothless = { ...csvSum, id: 'self-check-must-catch-this', verify: [{ type: 'fileExists', path: 'data.csv' }] }
  assert.equal(await dryRun([toothless], { keep: false }), false, 'an answer check that passes on an untouched workspace must be rejected')
  // ...while an anti-tamper guard on a fixture file is expected to pass there.
  const guarded = { ...csvSum, id: 'guard-is-allowed-to-pass', verify: [{ type: 'fileEquals', path: 'data.csv', text: generate('largeCsv', csvSum.fixture.params).files[0].content.trim(), invariant: true }] }
  assert.equal(await dryRun([guarded], { keep: false }), true, 'an invariant guard must be exempt from the "fail untouched" rule')
  assert.throws(() => validateTask({ ...csvSum, verify: [{ type: 'fileExists', path: 'x', invariant: 'yes' }] }), /"invariant" must be a boolean/)
})

await test('task validation refuses the shapes that would corrupt a run', () => {
  const good = loadTasks(TASKS_DIR)[0]
  assert.throws(() => validateTask({ ...good, prompt: '-rf everything' }), /must not start with "-"/)
  assert.throws(() => validateTask({ ...good, prompt: '  padded' }), /must not start with whitespace/)
  assert.throws(() => validateTask({ ...good, id: 'Bad ID' }), /slug-able id/)
  assert.throws(() => validateTask({ ...good, fixture: { generator: 'nope' } }), /unknown fixture generator/)
  assert.throws(() => validateTask({ ...good, verify: [{ type: 'fileEquals', path: 'x' }] }), /needs one of/)
  assert.throws(() => validateTask({ ...good, verify: [{ type: 'madeUp', path: 'x' }] }), /unknown check type/)
  assert.throws(() => validateTask({ ...good, verify: [] }), /non-empty array/)
  assert.throws(() => validateTask({ ...good, timeoutMs: -1 }), /positive integer/)
  assert.throws(() => validateTask({ ...good, title: '' }), /"title" must be a non-empty string/)
  assert.throws(() => validateTask({ ...good, repeat: 0 }), /"repeat" must be a positive integer/)
  assert.throws(() => validateTask({ ...good, repeat: 1.5 }), /"repeat" must be a positive integer/)
  assert.equal(validateTask({ ...good, repeat: 4 }).repeat, 4)
  assert.throws(() => selectTasks(loadTasks(TASKS_DIR), ['nope']), /unknown task id/)
  assert.equal(validateTask({ ...good, timeoutMs: undefined }).timeoutMs, DEFAULT_TIMEOUT_MS)
})

// ---------------------------------------------------------------- the CLIs (no dsh spawned)

await test('the runner CLI parses the documented shape', () => {
  const options = parseArgs(['--label', 'cand-0.3.1', '--profile', 'bench-ops'])
  assert.equal(options.label, 'cand-0.3.1')
  assert.equal(options.profile, 'bench-ops')
  assert.equal(options.repeat, 3)
  assert.equal(options.repeatExplicit, false, 'an absent --repeat defers to per-task budgets')
  assert.equal(options.timeout, null)
  assert.equal(options.llmPatchExplicit, false)

  const picked = parseArgs(['--label=l', '--profile=p', '--task', 'csv-sum', '--task=noisy-test-triage', '--repeat', '5', '--timeout', '60000', '--sleep-ms', '2000', '--strict', '--keep', '--dsh-home', 'D:/bench/home'])
  assert.deepEqual(picked.taskIds, ['csv-sum', 'noisy-test-triage'])
  assert.equal(picked.repeat, 5)
  assert.equal(picked.repeatExplicit, true, 'an explicit --repeat overrides every per-task budget')
  assert.equal(picked.timeout, 60000)
  assert.equal(picked.sleepMs, 2000)
  assert.equal(picked.strict, true)
  assert.equal(picked.keep, true)
  assert.equal(picked.dshHome, 'D:/bench/home')

  const off = parseArgs(['--label', 'l', '--profile', 'p', '--no-llm-patch'])
  assert.equal(off.llmPatch, null)
  assert.equal(off.llmPatchExplicit, true)

  assert.equal(parseArgs(['--label', 'l', '--profile', 'p']).folder, null, 'no --folder asks for no group of its own: the layout picks the day (see defaultRunFolder)')
  assert.equal(parseArgs(['--label', 'l', '--profile', 'p', '--folder', 'week-30']).folder, 'week-30')
  assert.equal(parseArgs(['--label=l', '--profile=p', '--folder=week-30']).folder, 'week-30', '--folder accepts the inline form')

  assert.throws(() => parseArgs(['--profile', 'p']), /--label is required/)
  assert.throws(() => parseArgs(['--label', 'l']), /--profile is required/)
  assert.throws(() => parseArgs(['--label', 'l', '--profile', 'p', '--nope']), /unknown option "--nope"/)
  assert.throws(() => parseArgs(['--label', 'l', '--profile', 'p', '--repeat']), /needs a value/)
  assert.throws(() => parseArgs(['--label', 'l', '--profile', 'p', '--repeat', 'x']), /non-negative integer/)
  assert.throws(() => parseArgs(['--label', 'l', '--profile', 'p', '--repeat', '0']), /at least 1/)
  assert.throws(() => parseArgs(['--label', 'l', '--profile', 'headless']), /shipped template name/)
  assert.throws(() => parseArgs(['--label', 'l', '--profile', 'p', '--folder', 'a/b']), /safe directory name/)
  assert.throws(() => parseArgs(['--label', 'l', '--profile', 'p', '--folder', '..']), /safe directory name/)
  assert.throws(() => parseArgs(['--label', 'l', '--profile', 'p', '--folder', 'w', '--out', 'somewhere']), /drop one of them/)
  assert.equal(parseArgs(['--list']).list, true, '--list must not need a label')
})

await test('--folder groups one round of runs under a reusable directory', async () => {
  await withTempDir('bench-folder-', async (runsDir) => {
    const ops = prepareOut(parseArgs(['--label', 'ops', '--profile', 'p', '--folder', 'week-30']), runsDir)
    assert.ok(ops.dir.startsWith(path.join(runsDir, 'week-30') + path.sep), `expected ${ops.dir} under the group directory`)
    assert.match(path.basename(ops.dir), /^\d{4}-\d{2}-\d{2}T[\d-]+Z-ops$/, 'the stamp-label name is kept inside the group')
    assert.ok(fs.existsSync(ops.results), 'the group directory is created on demand')
    // A later round of the same comparison reuses the folder; the stamps keep them apart.
    const base = prepareOut(parseArgs(['--label', 'base', '--profile', 'p', '--folder', 'week-30']), runsDir)
    const names = fs.readdirSync(path.join(runsDir, 'week-30')).sort()
    assert.equal(names.length, 2, 'both sides of the round share one group directory')
    assert.ok(base.dir !== ops.dir)
    const flat = prepareOut(parseArgs(['--label', 'ops', '--profile', 'p']), runsDir)
    assert.ok(flat.dir.startsWith(path.join(runsDir, defaultRunFolder()) + path.sep), 'without --folder the run files itself under the day')
    assert.ok(!flat.dir.startsWith(path.join(runsDir, 'week-30')), 'an unnamed run never joins a named round')
  })
})

await test('the run directory defaults to the local date folder', async () => {
  await withTempDir('bench-date-folder-', async (runsDir) => {
    const at = new Date('2026-10-16T09:30:00')
    assert.equal(defaultRunFolder(at), '2026-10-16', 'the date is what a human means by "today"')
    assert.equal(defaultRunFolder(new Date('2026-01-09T00:05:00')), '2026-01-09', 'single digits are zero-padded')

    const dated = prepareOut(parseArgs(['--label', 'ops', '--profile', 'p']), runsDir, at)
    assert.equal(dated.folder, '2026-10-16', 'no --folder: the day is the group')
    assert.ok(dated.dir.startsWith(path.join(runsDir, '2026-10-16') + path.sep), `expected ${dated.dir} under the date directory`)
    assert.match(path.basename(dated.dir), /^\d{4}-\d{2}-\d{2}T[\d-]+Z-ops$/, 'the stamp-label name is unchanged')
    assert.ok(fs.existsSync(dated.results), 'the date directory is created on demand too')
    // The inside stamp stays UTC: the folder is the shelf a person browses, the stamp
    // is the machine record, and compare.mjs sorts on the stamp.
    const sameDay = prepareOut(parseArgs(['--label', 'base', '--profile', 'p']), runsDir, at)
    assert.equal(sameDay.folder, dated.folder, 'a day of runs shares one folder')
    assert.notEqual(sameDay.dir, dated.dir, 'the stamps keep them apart inside it')

    const named = prepareOut(parseArgs(['--label', 'ops', '--profile', 'p', '--folder', 'week-30']), runsDir, at)
    assert.equal(named.folder, 'week-30', 'an explicit --folder wins over the date')
    const scratch = prepareOut(parseArgs(['--label', 'ops', '--profile', 'p', '--out', path.join(runsDir, 'scratch')]), runsDir, at)
    assert.equal(scratch.folder, null, '--out names the directory outright and opts out of grouping')
    assert.equal(scratch.dir, path.resolve(runsDir, 'scratch'))
  })
})

await test('per-task repeat budgets tier the sweep, and an explicit --repeat rules over them', () => {
  const tasks = [
    { id: 'cheap', repeat: 5 },
    { id: 'mid' },
    { id: 'expensive', repeat: 2 },
  ]
  const tiered = repeatsById(tasks, { repeat: 3, repeatExplicit: false })
  assert.deepEqual(tiered, { cheap: 5, mid: 3, expensive: 2 }, 'the task field wins over the default, the default fills the rest')
  const forced = repeatsById(tasks, { repeat: 1, repeatExplicit: true })
  assert.deepEqual(forced, { cheap: 1, mid: 1, expensive: 1 }, 'a smoke run gets exactly one sample per task')
})

await test('extractModel finds the routing in a rendered config tree', () => {
  const dump = [
    'bundle dsh-base',
    '  plugin agent-default-model',
    '    config:',
    '      provider: bench-server',
    '      model: qwen-tester',
    '  plugin llm-pi-ai',
    '    config:',
    '      providers:',
    '        bench-server:',
    '          baseURL: https://example.invalid/v1',
  ].join('\n')
  assert.deepEqual(extractModel(dump), { provider: 'bench-server', model: 'qwen-tester', bestEffort: true })
  assert.equal(extractModel('nothing here'), null)
  assert.equal(extractModel(''), null)
})

await test('buildSummary writes the shape compare.mjs reads', () => {
  const options = { label: 'cand', profile: 'bench-ops', repeat: 2 }
  const setup = { entry: { file: 'C:/npm/bin.js', version: '0.2.0-rc.2' }, llmPatch: 'C:/repo/bench/llm.patch.yml', model: { provider: 'bench-server', model: 'tester', bestEffort: true } }
  const results = [run('csv-sum', 100, true), run('csv-sum', 100, false, { repeatIndex: 1 })]
  const summary = buildSummary(options, setup, results, { startedAt: 'a', finishedAt: 'b', taskIds: ['csv-sum'] })
  assert.equal(summary.format, 'dsh-ops-bench-summary-v1')
  assert.equal(summary.label, 'cand')
  assert.equal(summary.dshEntry, 'C:/npm/bin.js')
  assert.equal(summary.dshVersion, '0.2.0-rc.2')
  assert.match(summary.llmPatch, /llm\.patch\.yml$/)
  assert.deepEqual(summary.taskIds, ['csv-sum'])
  assert.equal(summary.results.length, 2)
  assert.equal(summary.totals.grandTotal, 200)
  assert.equal(summary.totals.passed, 1)
  assert.equal(summary.totals.failed, 1)
  assert.equal(summary.totals.usageComplete, true)
  assert.equal(typeof summary.platform.node, 'string')
  assert.ok(summary.platform.node.startsWith('v'))
  const partial = buildSummary(options, setup, [run('csv-sum', 100, true, { usageReported: false })], { startedAt: 'a', finishedAt: 'b', taskIds: ['csv-sum'] })
  assert.equal(partial.totals.usageComplete, false, 'one incomplete run must mark the whole sweep incomplete')
})

await test('the comparator resolves labels, directories and bad input', () => {
  assert.throws(() => parseCompareArgs(['only-one']), /exactly two sides/)
  assert.throws(() => parseCompareArgs(['a', 'b', '--aggregate', 'mean']), /--aggregate must be one of/)
  assert.throws(() => parseCompareArgs(['a', 'b', '--fail-on', 'vibes']), /--fail-on must be one of/)
  assert.throws(() => parseCompareArgs(['a', 'b', '--tolerance-pct', '-1']), /non-negative/)
  assert.throws(() => parseCompareArgs(['a', 'b', '--folder', 'week/30']), /safe directory name/)
  assert.equal(parseCompareArgs(['a', 'b', '--folder', 'week-30']).folder, 'week-30')
  assert.equal(parseCompareArgs(['a', 'b']).folder, null)
  const parsed = parseCompareArgs(['base', 'cand', '--aggregate', 'min', '--tolerance-pct', '5', '--fail-on', 'regression', '--json', 'out.json'])
  assert.equal(parsed.base, 'base')
  assert.equal(parsed.cand, 'cand')
  assert.equal(parsed.aggregate, 'min')
  assert.equal(parsed.tolerancePct, 5)
  assert.equal(parsed.failOn, 'regression')
  assert.equal(parsed.json, 'out.json')

  const runsDir = path.join(TEST_HOME, 'bench-runs')
  const older = path.join(runsDir, '2026-01-01T00-00-00Z-old')
  const newer = path.join(runsDir, '2026-02-02T00-00-00Z-old')
  fs.mkdirSync(older, { recursive: true })
  fs.mkdirSync(newer, { recursive: true })
  fs.writeFileSync(path.join(older, 'summary.json'), JSON.stringify(summary('old', [])), 'utf8')
  fs.writeFileSync(path.join(newer, 'summary.json'), JSON.stringify(summary('newer-old', [])), 'utf8')
  assert.equal(resolveSide('old', runsDir).summary.label, 'newer-old', 'the newest archived run wins')
  assert.equal(resolveSide(older, runsDir).summary.label, 'old', 'a directory is exact')
  assert.throws(() => resolveSide('nothing-like-this', runsDir), /neither a run directory nor a label/)

  // A grouped run (bench/runs/<folder>/<stamp>-<label>) is found from the runs root,
  // or pinned to its group with --folder so several rounds never mix.
  const grouped = path.join(runsDir, 'week-30', '2026-03-03T00-00-00Z-old')
  fs.mkdirSync(grouped, { recursive: true })
  fs.writeFileSync(path.join(grouped, 'summary.json'), JSON.stringify(summary('grouped-old', [])), 'utf8')
  assert.equal(resolveSide('old', runsDir).summary.label, 'grouped-old', 'the newest stamp across root and groups wins')
  assert.equal(resolveSide('old', runsDir, 'week-30').summary.label, 'grouped-old', '--folder searches only that group')
  assert.throws(() => resolveSide('old', runsDir, 'no-such-week'), /no run folder/)
  fs.writeFileSync(path.join(grouped, 'summary.json'), '{"format":"other"}', 'utf8')
  assert.throws(() => resolveSide('old', runsDir), /unexpected format/)
})

await test('a --folder round archives its report in the group, not inside the run directory', async () => {
  await withTempDir('bench-compare-folder-', async (runsDir) => {
    const group = path.join(runsDir, '2026-10-16')
    const candDir = path.join(group, '2026-10-16T00-00-00Z-bench-ops')
    for (const [label, tokens] of [['bench-base', 1000], ['bench-ops', 600]]) {
      const dir = label === 'bench-ops' ? candDir : path.join(group, `2026-10-16T00-00-00Z-${label}`)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary(label, [run('csv-sum', tokens, true)])), 'utf8')
    }
    assert.equal(await compareMain(['bench-base', 'bench-ops', '--folder', '2026-10-16', '--runs', runsDir]), 0, 'the cheaper side must still pass')
    assert.equal(reportDir({ dir: candDir }), group, 'the report belongs to the round, one level above the run archive')
    assert.ok(fs.existsSync(path.join(group, 'comparison-bench-base-vs-bench-ops.md')), 'the archived report is in the group directory')
    assert.deepEqual(fs.readdirSync(candDir), ['summary.json'], 'a run directory stays the record of one sweep, untouched by comparisons')
  })
})

await test('a full sweep against a stub launcher archives what the comparator reads', async () => {
  // The runner is the only part of the benchmark that MUST capture a child's stdout,
  // because that stream is the measurement. A confined session cannot always open
  // those pipes, so this check says so and moves on rather than reporting a failure
  // the machine cannot answer.
  const blocker = pipedSpawnBlocker()
  if (blocker) {
    console.log(`       (skipped here: spawning a child with captured stdout is blocked: ${blocker})`)
    return
  }
  await withTempDir('bench-e2e-', async (root) => {
    const home = path.join(root, 'home')
    fs.mkdirSync(path.join(home, 'profiles', 'fake-profile'), { recursive: true })
    fs.writeFileSync(path.join(home, 'profiles', 'fake-profile', 'package.json'), '{"name":"fake-profile"}', 'utf8')
    // The stub answers csv-sum the way a competent agent would, and prints the event
    // shapes of PLAN §2.2. Nothing here talks to a model or a server.
    const stub = path.join(root, 'stub-launcher.cjs')
    fs.writeFileSync(stub, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const argv = process.argv.slice(2)
if (argv.includes('--version')) { console.log('0.2.0-rc.2'); process.exit(0) }
if (argv.includes('--dump-config')) {
  const at = argv.indexOf('--patch')
  if (at !== -1) console.log('# injected overlay: ' + fs.readFileSync(argv[at + 1], 'utf8').trim())
  console.log('bundle dsh-base\\n  plugin agent-default-model\\n    config:\\n      provider: bench-server\\n      model: stub\\n  plugin llm-pi-ai\\n    config:\\n      providers: {}')
  process.exit(0)
}
const task = argv[argv.length - 1]
const emit = (object) => process.stdout.write(JSON.stringify(object) + '\\n')
const scale = Number(process.env.STUB_TOKEN_SCALE ?? '1')
const at = (value) => Math.round(value * scale)
emit({ type: 'session', sessionId: 'session-stub', cwd: process.cwd() })
emit({ type: 'status', phase: 'turn_start', turn: 0 })
emit({ type: 'status', phase: 'step_start', turn: 0, step: 0 })
emit({ type: 'tool_call', callId: 'c1', tool: 'ops_bash', input: { command: 'awk -F, ...' } })
const lines = fs.readFileSync(path.join(process.cwd(), 'data.csv'), 'utf8').split('\\n')
let sum = 0
for (const line of lines.slice(1)) {
  const parts = line.split(',')
  if (parts.length === 3 && parts[1] === 'EU') sum += Number(parts[2])
}
fs.writeFileSync(path.join(process.cwd(), 'answer.txt'), sum + '\\n', 'utf8')
emit({ type: 'tool_result', callId: 'c1', status: 'completed', result: String(sum) })
emit({ type: 'status', phase: 'step_end', turn: 0, step: 0, usage: { inputTokens: at(1500), outputTokens: at(260), cacheReadTokens: at(400), cacheWriteTokens: 0, reasoningTokens: at(40) } })
emit({ type: 'status', phase: 'turn_end', turn: 0, reason: { kind: 'completed' } })
emit({ type: 'final', text: 'answer: ' + sum })
process.exit(0)
`, 'utf8')

    const baseDir = path.join(root, 'runs', '2026-01-01T00-00-00Z-stub-base')
    const candDir = path.join(root, 'runs', '2026-01-02T00-00-00Z-stub-cand')
    const sweepWith = async (label, out, scale) => {
      process.env.STUB_TOKEN_SCALE = scale
      try {
        assert.equal(await runMain(['--label', label, '--profile', 'fake-profile', '--dsh', stub, '--dsh-home', home, '--task', 'csv-sum', '--repeat', '1', '--no-llm-patch', '--out', out]), 0)
      } finally {
        delete process.env.STUB_TOKEN_SCALE
      }
      return out
    }

    await sweepWith('stub-base', baseDir, '1')
    await sweepWith('stub-cand', candDir, '0.5')

    // The overlay path, which is how a real sweep is actually run: preflight must
    // inject it, archive the rendered tree with the overlay layer visible, and take
    // the model identity from it rather than guessing.
    const overlay = path.join(root, 'llm.patch.yml')
    fs.writeFileSync(overlay, `- id: llm-pi-ai
  config:
    providers:
      bench-server:
        baseURL: http://127.0.0.1:9/v1
        apiKeyEnv: STUB_E2E_KEY
        api: openai-completions
        models:
          - id: stub-overlay-model
- id: agent-default-model
  config:
    provider: bench-server
    model: stub-overlay-model
`, 'utf8')
    const overlayDir = path.join(root, 'runs', '2026-01-03T00-00-00Z-stub-overlay')
    process.env.STUB_E2E_KEY = 'not-a-real-key'
    let overlayExit
    try {
      overlayExit = await runMain(['--label', 'stub-overlay', '--profile', 'fake-profile', '--dsh', stub, '--dsh-home', home, '--task', 'csv-sum', '--repeat', '1', '--llm-patch', overlay, '--out', overlayDir])
    } finally {
      delete process.env.STUB_E2E_KEY
    }
    assert.equal(overlayExit, 0, 'a sweep with an injected overlay must run, not just pass preflight')
    const overlayDump = fs.readFileSync(path.join(overlayDir, 'dump-config.txt'), 'utf8')
    assert.match(overlayDump, /# injected overlay: - id: llm-pi-ai/, 'the archived tree must show the overlay layer (§10.1 evidence)')
    assert.match(overlayDump, /agent-default-model/)
    const overlayMeta = JSON.parse(fs.readFileSync(path.join(overlayDir, 'meta.json'), 'utf8'))
    assert.equal(overlayMeta.llmPatch, overlay)
    assert.deepEqual(overlayMeta.preflightWarnings.filter((text) => /overlay|dump-config/.test(text)), [], 'the overlay must land cleanly, with nothing left to prove')
    // The identity comes out of the archived tree — and the tree starts with the
    // injected overlay layer, so the overlay's own model wins, exactly as designed.
    const overlaySummary = JSON.parse(fs.readFileSync(path.join(overlayDir, 'summary.json'), 'utf8'))
    assert.equal(overlaySummary.model.provider, 'bench-server')
    assert.equal(overlaySummary.model.model, 'stub-overlay-model')
    assert.equal(overlaySummary.model.bestEffort, true)

    assert.equal(fs.readFileSync(path.join(baseDir, 'dump-config.txt'), 'utf8').includes('agent-default-model'), true, 'the fairness evidence must be archived')
    const meta = JSON.parse(fs.readFileSync(path.join(baseDir, 'meta.json'), 'utf8'))
    assert.equal(meta.profile, 'fake-profile')
    assert.equal(meta.isolatedHome, true)
    const summary = JSON.parse(fs.readFileSync(path.join(baseDir, 'summary.json'), 'utf8'))
    assert.equal(summary.format, 'dsh-ops-bench-summary-v1')
    assert.equal(summary.totals.usageComplete, true)
    assert.equal(summary.totals.passed, 1, 'the stub writes the really computed sum, so verify must pass')
    assert.equal(summary.model.model, 'stub')
    const report = fs.readFileSync(path.join(baseDir, 'report.md'), 'utf8')
    assert.match(report, /# bench run stub-base/)
    assert.match(report, /## Tool calls \(summed over every run\)/)
    assert.match(report, /\| ops_bash \| 1 \|/)
    assert.doesNotMatch(report, /## Footnotes/)
    const metrics = JSON.parse(fs.readFileSync(path.join(baseDir, 'results', 'csv-sum-r0.metrics.json'), 'utf8'))
    assert.equal(metrics.steps, 1)
    assert.equal(metrics.turnEndReason, 'completed')
    assert.equal(metrics.usage.grandTotal, 2160)
    assert.equal(fs.readFileSync(path.join(baseDir, 'results', 'csv-sum-r0.events.ndjson'), 'utf8').split('\n').filter(Boolean).length, 8, 'the raw stream must be archived exactly as it arrived')

    // The narration is part of the archive now: a sweep that hung must leave the
    // evidence of *where* it hung, not only the fact that it did (README §4).
    const narration = fs.readFileSync(path.join(baseDir, 'runner.log'), 'utf8')
    assert.match(narration, /INFO\s+\[csv-sum r0\] spawn provider bench-server\/model stub\b/, 'the log names the routing the run went against')
    assert.match(narration, /startup OK/, 'the log says the launcher booted')
    assert.match(narration, /model connection OK/, 'the log says the model answered')
    assert.match(narration, /dsh exited 0 after \d+m\d{2}s/, 'the log says how the run ended')
    assert.match(narration, /^\d{4}-\d\d-\d\dT\S+ (INFO|WARN|DETAIL) /, 'every logged line is timestamped and levelled')
    assert.match(narration, /DETAIL .*\[csv-sum r0\] event #1 session/, 'chatter the quiet console skipped is still in the file')
    assert.ok(!narration.includes('still running'), 'a run that finished inside one heartbeat period never claims to be waiting')
    const narrationMeta = JSON.parse(fs.readFileSync(path.join(baseDir, 'meta.json'), 'utf8')).narration
    assert.equal(narrationMeta.runnerLog, 'runner.log')
    assert.equal(narrationMeta.verbose, false)
    assert.equal(narrationMeta.heartbeatMs, 15000)
    assert.equal(narrationMeta.stallMs, 60000)
    const live = JSON.parse(fs.readFileSync(path.join(baseDir, 'results', 'csv-sum-r0.metrics.json'), 'utf8')).liveNarration
    assert.equal(live.events, 8, 'the observer counted the same stream the aggregator did')
    assert.equal(live.lastKind, 'final')
    assert.equal(live.stepsWithUsage, 1)

    const loudDir = path.join(root, 'runs', '2026-01-04T00-00-00Z-stub-verbose')
    assert.equal(await runMain(['--label', 'stub-verbose', '--profile', 'fake-profile', '--dsh', stub, '--dsh-home', home, '--task', 'csv-sum', '--repeat', '1', '--no-llm-patch', '--verbose', '--heartbeat-ms', '0', '--out', loudDir]), 0)
    const loudLog = fs.readFileSync(path.join(loudDir, 'runner.log'), 'utf8')
    assert.match(loudLog, /tool call #1: ops_bash/, '--verbose narrates each tool call')
    assert.equal(JSON.parse(fs.readFileSync(path.join(loudDir, 'meta.json'), 'utf8')).narration.verbose, true, 'the archive records how loudly the run was narrated')

    // Without an explicit --repeat the sweep honors the corpus's per-task budgets:
    // csv-sum currently carries repeat 2. The interleave (r0 before r1 across tasks)
    // is preserved for the tiered case too.
    const tieredDir = path.join(root, 'runs', '2026-01-06T00-00-00Z-stub-tiered')
    assert.equal(await runMain(['--label', 'stub-tiered', '--profile', 'fake-profile', '--dsh', stub, '--dsh-home', home, '--task', 'csv-sum', '--no-llm-patch', '--out', tieredDir]), 0)
    const tieredSummary = JSON.parse(fs.readFileSync(path.join(tieredDir, 'summary.json'), 'utf8'))
    assert.equal(tieredSummary.results.length, 2, 'the corpus repeat budget applies when --repeat is absent')
    assert.deepEqual(tieredSummary.taskRepeats, { 'csv-sum': 2 })
    assert.ok(fs.existsSync(path.join(tieredDir, 'results', 'csv-sum-r1.metrics.json')), 'both repeats archived')
    const tieredMeta = JSON.parse(fs.readFileSync(path.join(tieredDir, 'meta.json'), 'utf8'))
    assert.equal(tieredMeta.repeatExplicit, false)
    assert.deepEqual(tieredMeta.taskRepeats, { 'csv-sum': 2 })
    const tieredLog = fs.readFileSync(path.join(tieredDir, 'runner.log'), 'utf8')
    assert.match(tieredLog, /csv-sum:2/, 'the narration says which budgets ran')

    // --preflight-only answers the same questions for the price of a config render: no
    // task, no run directory, nothing to compare.
    const neverDir = path.join(root, 'runs', '2026-01-05T00-00-00Z-preflight-only')
    assert.equal(await runMain(['--preflight-only', '--profile', 'fake-profile', '--dsh', stub, '--dsh-home', home, '--no-llm-patch', '--out', neverDir]), 0)
    assert.equal(fs.existsSync(neverDir), false, 'a check must not leave a run archive behind')
    assert.equal(fs.readdirSync(path.join(root, 'runs')).includes('2026-01-05T00-00-00Z-preflight-only'), false)

    const runsDir = path.join(root, 'runs')
    assert.equal(await compareMain(['stub-base', 'stub-cand', '--runs', runsDir]), 0, 'the cheaper, still-correct candidate must pass both gates')
    // Flat layout: the report sits beside the two archives it compares, so the run
    // directory itself stays the immutable record of one sweep.
    const comparisonFile = fs.readdirSync(runsDir).find((name) => name.startsWith('comparison-'))
    assert.ok(comparisonFile, 'the comparison must be archived in the candidate run\'s parent directory')
    assert.equal(fs.readdirSync(candDir).some((name) => name.startsWith('comparison-')), false, 'a run archive must not collect comparison reports')
    const markdown = fs.readFileSync(path.join(runsDir, comparisonFile), 'utf8')
    assert.match(markdown, /-50\.0%/)
    assert.match(markdown, /2\/2→2\/2|1\/1→1\/1/)

    // And the same two archives, read back the wrong way round, must fail the gate.
    assert.equal(await compareMain(['stub-cand', 'stub-base', '--runs', runsDir]), 1, 'a 100% token regression must not pass')
  })
})

await test('the report shows only the statistic the gate used, with no spread or regression tag', () => {
  const base = summary('base', [run('csv-sum', 1000, true), run('csv-sum', 1400, true)])
  const cand = summary('cand', [run('csv-sum', 600, true), run('csv-sum', 600, true)])
  const asMedian = renderMarkdown(compareSummaries(base, cand, { aggregate: 'median' }), { baseFile: 'b/summary.json', candFile: 'c/summary.json' })
  assert.match(asMedian, /1,200 → 600 \(<span style="color:green">-50\.0%<\/span>\)/)
  assert.match(asMedian, /\| \*\*GEOMEAN Δ\*\* \| <span style="color:green">-50\.0%<\/span>/)
  assert.doesNotMatch(asMedian, /· min /)
  assert.doesNotMatch(asMedian, /⚠regressed/)
  assert.match(asMedian, /# bench compare: base → cand/)
  // The report names the candidate side "Ops", never "Cand".
  assert.match(asMedian, /^Ops: /m)
  assert.doesNotMatch(asMedian, /^Cand: /m)
  assert.match(asMedian, /tokens median base→ops \(Δ%\)/)
  assert.match(asMedian, /## Bucket detail \(median per task\)/)
  assert.match(asMedian, /\| task \| input base→ops \(Δ%\) \| output base→ops \(Δ%\) \| cache read base→ops \(Δ%\) \|/)
  assert.match(asMedian, /\| csv-sum \| 840 → 420 \(<span style="color:green">-50\.0%<\/span>\) \| 360 → 180 \(<span style="color:green">-50\.0%<\/span>\) \| 0 → 0 \(<span style="color:green">0\.0%<\/span>\) \|/)
  assert.match(asMedian, /\| \*\*TOTAL\*\* \| 840 → 420 \(<span style="color:green">-50\.0%<\/span>\) \| 360 → 180 \(<span style="color:green">-50\.0%<\/span>\) \| 0 → 0 \(<span style="color:green">0\.0%<\/span>\) \|/)
  assert.doesNotMatch(asMedian, /\| side \|/)
  assert.match(asMedian, /\| bucket \| base \| ops \| Δ \(Δ%\) \|/)
  assert.match(asMedian, /\| \*\*TOTAL\*\* \| 1,200 → 600/)
  assert.doesNotMatch(asMedian, /cache write|reasoning/)
  assert.doesNotMatch(asMedian, /## Footnotes/)
  const asMin = renderMarkdown(compareSummaries(base, cand, { aggregate: 'min' }), { baseFile: 'b', candFile: 'c' })
  assert.match(asMin, /1,000 → 600 \(<span style="color:green">-40\.0%<\/span>\)/)
  assert.doesNotMatch(asMin, /· median /)
  // A per-task regression still fails the gate and the exit code, but the report
  // no longer carries the verdict or the warnings.
  const regressedComparison = compareSummaries(summary('base', [run('csv-sum', 1000, true)]), summary('cand', [run('csv-sum', 1300, true)]))
  assert.equal(regressedComparison.gate.fail, true)
  const regressed = renderMarkdown(regressedComparison, { baseFile: 'b', candFile: 'c' })
  assert.doesNotMatch(regressed, /\*\*Gate:\*\*/)
  assert.doesNotMatch(regressed, /\*\*Warnings:\*\*/)
  assert.doesNotMatch(regressed, /⚠regressed/)
  // A rise is the expensive direction, so its percent renders red.
  assert.match(regressed, /\(<span style="color:red">\+30\.0%<\/span>\)/)
  const incomplete = renderMarkdown(compareSummaries(summary('base', [run('csv-sum', 1000, true, { usageReported: false })]), cand), { baseFile: 'b', candFile: 'c' })
  assert.match(incomplete, /n\/a \(usage incomplete\)/)
  assert.match(incomplete, /Skipped: at least one side lost a `step_end\.usage`/)
  assert.doesNotMatch(incomplete, /Bucket detail \(median per task\)/)
})

await test('steps and tool calls carry coloured base→ops percentages in the main table', () => {
  const base = summary('base', [run('csv-sum', 1000, true, { steps: 10, toolCalls: 8 })])
  const cand = summary('cand', [run('csv-sum', 1000, true, { steps: 12, toolCalls: 6 })])
  const markdown = renderMarkdown(compareSummaries(base, cand), { baseFile: 'b', candFile: 'c' })
  assert.match(markdown, /\| task \| tokens median base→ops \(Δ%\) \| steps base→ops \(Δ%\) \| tool calls base→ops \(Δ%\) \| tool errors \| pass \|/)
  const row = /\| csv-sum \| 1,000 → 1,000 \(<span style="color:green">0\.0%<\/span>\) \| 10→12 \(<span style="color:red">\+20\.0%<\/span>\) \| 8→6 \(<span style="color:green">-25\.0%<\/span>\) \| 0→0 \| 1\/1→1\/1 \|/
  assert.match(markdown, row)
  const total = /\| \*\*TOTAL\*\* \| 1,000 → 1,000 \(<span style="color:green">0\.0%<\/span>\) \| 10→12 \(<span style="color:red">\+20\.0%<\/span>\) \| 8→6 \(<span style="color:green">-25\.0%<\/span>\) \| 0→0 \| 1\/1→1\/1 \|/
  assert.match(markdown, total)
})

await test('the report counts tool calls by name across every archived run', () => {
  const base = summary('base', [
    run('csv-sum', 1000, true, { toolCallsByName: { pwsh: 3, read: 2, sed: 99, ops_old: 50 } }),
    run('csv-sum', 1000, true, { repeatIndex: 1, toolCallsByName: { pwsh: 1, ops_grep: 0 } }),
  ])
  const cand = summary('cand', [
    run('csv-sum', 1000, true, { toolCallsByName: { pwsh: 2, read: 1, ops_grep: 4 } }),
  ])
  const markdown = renderMarkdown(compareSummaries(base, cand), { baseFile: 'b', candFile: 'c' })
  assert.match(markdown, /## Tool calls \(summed over every archived run on each side\)/)
  assert.match(markdown, /\| pwsh \| 4 \| <span style="color:red">2<\/span> \|/)
  assert.match(markdown, /\| read \| 2 \| <span style="color:red">1<\/span> \|/)
  assert.match(markdown, /\| ops_grep \| 0 \| 4 \|/)
  assert.match(markdown, /\| ops_old \| 50 \| 0 \|/)
  assert.match(markdown, /\| sed \| 99 \| 0 \|/)
  // A built-in tool the Ops side never called stays plain; only a non-zero Ops count
  // on a non-ops_* row is red.
  assert.doesNotMatch(markdown, /\| ops_[a-z_]+ \| [^|]+ \| <span style="color:red">/)
  // ops_* tools come first (even one the Ops side never called), then the rest by
  // Ops count: ops_grep 4, ops_old 0, pwsh 2, read 1, sed 0.
  const rows = ['| ops_grep | 0 | 4 |', '| ops_old | 50 | 0 |', '| pwsh | 4 | <span style="color:red">2</span> |', '| read | 2 | <span style="color:red">1</span> |', '| sed | 99 | 0 |']
    .map((row) => markdown.indexOf(row))
  assert.ok(rows.every((index) => index !== -1))
  assert.ok(rows.every((index, i) => i === 0 || rows[i - 1] < index), 'ops_* tools first, then Ops-count descending')
  // Tool adoption is important enough to sit directly under the main table.
  assert.ok(markdown.indexOf('## Tool calls') < markdown.indexOf('## Bucket detail'), 'Tool calls comes before Bucket detail')
  assert.ok(markdown.indexOf('| tool | base | ops |') < markdown.indexOf('## Token buckets'), 'Tool calls comes before Token buckets')
})

await test('the report leaves out the per-request overhead and delta decomposition', () => {
  const base = summary('base', [shapedRun('csv-sum', { steps: 5, first: 6000, perStep: 7000, output: 300 })])
  const cand = summary('cand', [shapedRun('csv-sum', { steps: 7, first: 8000, perStep: 9000, output: 600 })])
  const comparison = compareSummaries(base, cand)
  const markdown = renderMarkdown(comparison, { baseFile: 'b', candFile: 'c' })
  // The decomposition is still computed, it is just not rendered any more.
  assert.equal(comparison.overhead.comparable, true)
  assert.equal(comparison.overhead.fixedOverheadTokens, 14000)
  assert.doesNotMatch(markdown, /Per-request overhead/)
  assert.doesNotMatch(markdown, /Where the token delta comes from/)
  assert.doesNotMatch(markdown, /Fixed per-request cost/)
  assert.doesNotMatch(markdown, /prompt \/ step/)
  assert.match(markdown, /## Bucket detail \(median per task\)/)
  assert.match(markdown, /## Token buckets \(TOTAL, median\)/)
  assert.match(markdown, /\| cache read \| 0 \| 0 \| 0 \(<span style="color:green">0\.0%<\/span>\) \|/)
})

await test('token bucket deltas carry coloured base→ops percentages', () => {
  const base = summary('base', [run('csv-sum', 1000, true)])
  const cand = summary('cand', [run('csv-sum', 1200, true)])
  const markdown = renderMarkdown(compareSummaries(base, cand), { baseFile: 'b', candFile: 'c' })
  assert.match(markdown, /\| bucket \| base \| ops \| Δ \(Δ%\) \|/)
  assert.match(markdown, /\| uncached input \| 700 \| 840 \| \+140 \(<span style="color:red">\+20\.0%<\/span>\) \|/)
  assert.match(markdown, /\| output \| 300 \| 360 \| \+60 \(<span style="color:red">\+20\.0%<\/span>\) \|/)
  assert.match(markdown, /\| cache read \| 0 \| 0 \| 0 \(<span style="color:green">0\.0%<\/span>\) \|/)
  assert.match(markdown, /\| \*\*TOTAL\*\* \| 1,000 \| 1,200 \| \+200 \(<span style="color:red">\+20\.0%<\/span>\) \|/)
})

await test('an archive without prompt capture renders no overhead zeroes', () => {
  const base = summary('base', [run('csv-sum', 1000, true)])
  const cand = summary('cand', [run('csv-sum', 1000, true)])
  const markdown = renderMarkdown(compareSummaries(base, cand), { baseFile: 'b', candFile: 'c' })
  // No prompt capture is needed for what the report still shows.
  assert.doesNotMatch(markdown, /prompt capture/)
  assert.doesNotMatch(markdown, /Per-request overhead/)
  assert.match(markdown, /## Bucket detail \(median per task\)/)
  assert.match(markdown, /## Token buckets \(TOTAL, median\)/)

  // When usage itself is incomplete, both bucket sections step aside.
  const incomplete = renderMarkdown(compareSummaries(summary('base', [run('csv-sum', 1000, true, { usageReported: false })]), cand), { baseFile: 'b', candFile: 'c' })
  assert.match(incomplete, /Skipped: at least one side lost a `step_end\.usage`, so per-bucket deltas/)
  assert.match(incomplete, /## Token buckets/)
})

// ---------------------------------------------------------------------------
// bench/setup.mjs — the profile patch editor and the environment probe. Both are
// pure, and both guard a measurement condition rather than a convenience: the
// baseline's shell engine, and the PSModulePath leak that kills the candidate's
// shell outright (README §1, §2.1).
// ---------------------------------------------------------------------------

const TEMPLATE_PATCH = '# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists; `!!js` expressions allowed).\n[]\n'
const SHELL = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

await test('setup pins the baseline shell by replacing the empty patch placeholder', () => {
  const plan = planProfilePatch(TEMPLATE_PATCH, SHELL)
  assert.equal(plan.action, 'write')
  assert.match(plan.text, /^- id: pwsh-sandbox\r?$/m)
  assert.ok(plan.text.includes(`    pwshPath: ${SHELL}`), 'the pin is indented under config')
  assert.ok(!plan.text.includes('[]'), 'the template placeholder is gone')
  assert.ok(plan.text.startsWith('# Your patch layer'), 'the template comments survive')
  assert.ok(plan.text.endsWith('\n'), 'the file keeps exactly one trailing newline')
})

await test('setup is idempotent, and refuses to overwrite a foreign pwshPath without --force', () => {
  const first = planProfilePatch(TEMPLATE_PATCH, SHELL)
  assert.equal(planProfilePatch(first.text, SHELL).action, 'noop', 'the same value is not rewritten')
  const other = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
  const conflict = planProfilePatch(first.text, other)
  assert.equal(conflict.action, 'conflict')
  assert.match(conflict.note, /--force/)
  const forced = planProfilePatch(first.text, other, { force: true })
  assert.equal(forced.action, 'write')
  assert.ok(forced.text.includes(`    pwshPath: ${other}`))
  assert.equal(forced.text.split('pwshPath:').length - 1, 1, 'exactly one pwshPath line')
})

await test('setup appends alongside other patch entries and fills a config block that lacks the key', () => {
  const withOther = '- id: llm-pi-ai\n  config:\n    providers: {}\n'
  const appended = planProfilePatch(withOther, SHELL)
  assert.equal(appended.action, 'write')
  assert.ok(appended.text.includes('- id: llm-pi-ai'), 'the foreign entry is untouched')
  assert.ok(appended.text.includes('- id: pwsh-sandbox'))
  const entryOnly = '- id: pwsh-sandbox\n  config:\n    timeoutMs: 60000\n'
  const filled = planProfilePatch(entryOnly, SHELL)
  assert.equal(filled.action, 'write')
  assert.ok(filled.text.includes('timeoutMs: 60000'), 'existing config keys stay')
  assert.ok(filled.text.includes(`    pwshPath: ${SHELL}`))
})

await test('setup refuses shapes it cannot merge safely instead of rewriting them', () => {
  assert.equal(planProfilePatch('id: pwsh-sandbox\n', SHELL).action, 'manual', 'a mapping is not a patch list')
  assert.equal(planProfilePatch('- id: pwsh-sandbox\n  config: { timeoutMs: 60000 }\n', SHELL).action, 'manual', 'an inline config is left alone')
  assert.equal(planProfilePatch('tabs:\n\t- id: x\n', SHELL).action, 'manual')
})

await test('setup pins the permission mode with the approval preset it implies', () => {
  assert.deepEqual(permissionEntries('danger-full-access'), [
    { id: 'sandbox-policy', config: { mode: 'danger-full-access' } },
    { id: 'approval', config: { policy: 'never' } },
  ], 'full access carries the approval policy dsh-base derives')
  assert.deepEqual(permissionEntries('workspace-write')[1].config, { policy: 'ask' })
  assert.equal(approvalPolicyFor('read-only'), 'ask')

  const planned = planPatchEntries(TEMPLATE_PATCH, permissionEntries('danger-full-access'))
  assert.equal(planned.action, 'write')
  assert.match(planned.text, /^- id: sandbox-policy\r?$/m)
  assert.ok(planned.text.includes('    mode: danger-full-access'), 'the mode is indented under config')
  assert.match(planned.text, /^- id: approval\r?$/m)
  assert.ok(planned.text.includes('    policy: never'))
  assert.ok(!planned.text.includes('[]'), 'the template placeholder is gone')
  assert.ok(planned.text.startsWith('# Your patch layer'), 'the template comments survive')
  assert.equal(planPatchEntries(planned.text, permissionEntries('danger-full-access')).action, 'noop', 'the same pin is not rewritten')
})

await test('the permission pin composes with the shell pin and refuses a foreign mode', () => {
  const withShell = `- id: pwsh-sandbox\n  config:\n    pwshPath: ${SHELL}\n`
  const planned = planPatchEntries(withShell, permissionEntries('workspace-write'))
  assert.equal(planned.action, 'write')
  assert.ok(planned.text.includes(`pwshPath: ${SHELL}`), 'the shell pin survives')
  assert.match(planned.text, /- id: sandbox-policy\n  config:\n    mode: workspace-write/)
  assert.match(planned.text, /- id: approval\n  config:\n    policy: ask/)

  const existing = '- id: sandbox-policy\n  name: x\n  config:\n    mode: read-only\n'
  const conflict = planPatchEntries(existing, permissionEntries('danger-full-access'))
  assert.equal(conflict.action, 'conflict', 'a mode this script did not write is not overwritten')
  assert.match(conflict.note, /--force/)
  const forced = planPatchEntries(existing, permissionEntries('danger-full-access'), { force: true })
  assert.equal(forced.action, 'write')
  assert.equal(forced.text.split('mode:').length - 1, 1, 'the key is replaced, not duplicated')
  assert.match(forced.text, /mode: danger-full-access/)
  assert.equal(planEntryPatch('- id: sandbox-policy\n  config: { mode: read-only }\n', permissionEntries('danger-full-access')[0]).action, 'manual', 'an inline config is still refused')
})

await test('the composed-tree reader finds a key under the right entry only', () => {
  const dump = [
    '- id: telemetry', '  config:', '    mode: !!js process.env.DSH_TELEMETRY_MODE', '- id: sandbox-policy', '  config:',
    '    mode: danger-full-access', '    workspaceRoot: !!js process.cwd()', '- id: approval', '  config:', '    policy: never', '',
  ].join('\n')
  assert.equal(entryConfigValue(dump, 'sandbox-policy', 'mode'), 'danger-full-access')
  assert.equal(entryConfigValue(dump, 'approval', 'policy'), 'never')
  assert.equal(entryConfigValue(dump, 'telemetry', 'mode'), '!!js process.env.DSH_TELEMETRY_MODE', 'the reader is scoped to one entry')
  assert.equal(entryConfigValue(dump, 'sandbox-policy', 'approval'), null, 'a key of another entry does not leak in')
  assert.equal(entryConfigValue(dump, 'nope', 'mode'), null)
  assert.equal(entryConfigValue('', 'sandbox-policy', 'mode'), null)
})

await test('the PSModulePath probe flags only a directory that really ships the shadowing module', () => {
  const windows = 'C:\\Windows'
  const inBox = 'C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules'
  const bundled = 'C:\\Users\\x\\.dsh\\profiles\\p\\node_modules\\@dsh-ops\\pwsh-win32-x64\\bin\\Modules'
  const userModules = 'C:\\Users\\x\\Documents\\PowerShell\\Modules'
  const ships = file => file.toLowerCase().startsWith(bundled.toLowerCase())
  // PSModulePath is Windows-shaped even when the host running this suite is not, so the
  // separator is pinned instead of read from `path.delimiter` (":" on macOS/Linux).
  const sep = ';'
  assert.equal(poisonedModulePath(`${bundled}${sep}${inBox}`, windows, ships, sep), bundled, 'the bundled PS7 modules dir is the real poison')
  assert.equal(poisonedModulePath(`${userModules}${sep}${inBox}`, windows, ships, sep), null, 'a PS7 user module folder is harmless')
  assert.equal(poisonedModulePath(`${inBox}${sep}${bundled}`, windows, ships, sep), null, 'order matters: after the in-box dir it cannot shadow')
  assert.equal(poisonedModulePath(undefined, windows, ships, sep), null)
  assert.equal(poisonedModulePath('', windows, ships, sep), null)
})

await test('setup argument handling fails closed on typos and names the plugin it would install', () => {
  const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  // The candidate must measure the working tree: the default install is this checkout, not
  // the published package, so a sweep needs no publish and no version bump to be honest.
  assert.equal(parseSetupArgs([]).plugin, 'local', 'this checkout is the default spec')
  assert.equal(specVersion('local'), version, 'local resolves to the repo version, which is what a stale copy is compared against')
  assert.equal(specVersion('dsh-ops@0.2.1'), '0.2.1', 'an exact npm spec names the version to compare')
  assert.equal(specVersion('dsh-ops@0.3.1-rc.2'), '0.3.1-rc.2')
  assert.equal(specVersion('dsh-ops@latest'), null, 'a dist tag pins nothing to compare against')
  assert.equal(specVersion('./some/checkout.tgz'), null, 'a tarball path pins nothing either')
  assert.equal(parseSetupArgs(['--plugin', 'dsh-ops@0.2.1']).plugin, 'dsh-ops@0.2.1', 'a published spec stays available')
  assert.equal(parseSetupArgs(['--no-plugin']).plugin, 'none')
  assert.equal(parseSetupArgs(['--no-pin']).pinShell, null)
  assert.equal(parseSetupArgs([]).permissionMode, 'danger-full-access', 'both profiles default to full access')
  assert.equal(parseSetupArgs(['--permission-mode', 'workspace-write']).permissionMode, 'workspace-write')
  assert.equal(parseSetupArgs(['--no-permission-mode']).permissionMode, 'none')
  assert.throws(() => parseSetupArgs(['--permission-mode', 'yolo']), /--permission-mode/, 'an unknown mode is refused, not guessed')
  assert.equal(parseSetupArgs(['--plugin', 'local']).plugin, 'local')
  assert.throws(() => parseSetupArgs(['--pin']), /unknown option/, 'a typo must not silently skip the pin')
  assert.throws(() => parseSetupArgs(['--base-profile', 'headless']), /shipped template/)
  assert.throws(() => parseSetupArgs(['--base-profile', 'x', '--cand-profile', 'x']), /must differ/)
})

await test('setup seeds the LLM overlay only when it is missing, and never overwrites one', async () => {
  await withTempDir('bench-overlay-', async (dir) => {
    const example = path.join(dir, 'llm.patch.example.yml')
    const overlay = path.join(dir, 'llm.patch.yml')
    const template = '# 模板\nproviders:\n  bench-server:\n    baseURL: https://<你的服务器>/v1\n    models:\n      - id: <模型id>\n'
    fs.writeFileSync(example, template, 'utf8')
    const lines = []
    const log = line => lines.push(line)

    // No template, no copy: a half-prepared overlay is worse than a named absence.
    assert.equal(ensureLlmOverlay({ overlay, example: path.join(dir, 'gone.yml'), log }), 'missing-example')
    assert.equal(fs.existsSync(overlay), false, 'nothing is invented without a template')

    assert.equal(ensureLlmOverlay({ overlay, example, log }), 'created')
    assert.equal(fs.readFileSync(overlay, 'utf8'), template, 'the copy is the template, verbatim')

    // The operator fills the copy in; the next setup run must not put the placeholders back.
    const filled = 'providers:\n  bench-server:\n    baseURL: https://bench.example/v1\n'
    fs.writeFileSync(overlay, filled, 'utf8')
    assert.equal(ensureLlmOverlay({ overlay, example, log }), 'exists')
    assert.equal(fs.readFileSync(overlay, 'utf8'), filled, 'an existing overlay is the operator\'s file')

    // A plan names the copy and writes nothing.
    fs.unlinkSync(overlay)
    assert.equal(ensureLlmOverlay({ overlay, example, dryRun: true, log }), 'created')
    assert.equal(fs.existsSync(overlay), false, '--dry-run never copies')

    assert.deepEqual(placeholderLines(template), ['baseURL: https://<你的服务器>/v1', '- id: <模型id>'], 'template placeholders are named outside comments')
    assert.deepEqual(placeholderLines('# 注释里的 <占位符> 不算\nbaseURL: https://bench.example/v1\n'), [], 'a comment mentioning one is not an unfilled value')
    assert.match(lines.join('\n'), /没动它/, 'the existing file is reported, not silently accepted')
  })
})

await test('setup checks the local build the candidate will execute, and names each rebuild', async () => {
  await withTempDir('bench-build-', async (dir) => {
    const write = (relative, content = 'x') => {
      const file = path.join(dir, relative)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content)
      return file
    }
    const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

    // A target the plugin does not carry is named, not silently "ok".
    const unsupported = inspectLocalBuild({ root: dir, platform: 'sunos', arch: 'sparc' })
    assert.equal(unsupported.problems.length, 1)
    assert.match(unsupported.problems[0].what, /sunos-sparc/)

    // Empty checkout: the worker is the first thing missing, with its build command.
    let report = inspectLocalBuild({ root: dir, platform: 'win32', arch: 'x64' })
    assert.match(report.problems.map(problem => `${problem.what} ${problem.fix}`).join('\n'), /native worker[\s\S]*npm run build:ptc/)

    // Sources first, then the artifacts built from them — otherwise the worker would look stale.
    for (const name of ['security.h', 'opsipc.cpp', 'opsnt.cpp']) write(`native/bash-ipc/${name}`, `// ${name}\n`)
    write('native/src/main.rs', 'fn main() {}\n')
    write('native/Cargo.toml', '[package]\n')
    write('native/Cargo.lock', '# lock\n')
    write('runtime/win32-x64/dsh-ops-worker.exe')
    write('runtime/win32-x64/provenance.json', JSON.stringify({ version: '1', target: 'win32-x64', executable: 'dsh-ops-worker.exe' }))
    const ipc = 'runtime/win32-x64/bash-ipc'
    write(`${ipc}/opsipc.dll`, 'proxy-a')
    write(`${ipc}/opsnt.dll`, 'proxy-b')
    const ipcReceipt = () => JSON.stringify({
      version: 1, platform: 'win32-x64',
      files: { 'opsipc.dll': sha(path.join(dir, ipc, 'opsipc.dll')), 'opsnt.dll': sha(path.join(dir, ipc, 'opsnt.dll')) },
      sources: Object.fromEntries(['security.h', 'opsipc.cpp', 'opsnt.cpp'].map(name => [name, sha(path.join(dir, 'native', 'bash-ipc', name))])),
    })
    const pristine = ipcReceipt()
    write(`${ipc}/provenance.json`, pristine)

    // The shell payloads are dependencies rather than build output: still reported, but as warnings.
    report = inspectLocalBuild({ root: dir, platform: 'win32', arch: 'x64' })
    assert.deepEqual(report.problems, [], 'a staged worker and current proxies are enough')
    assert.equal(report.warnings.length, 2, 'both payloads are named when neither is installed')
    write('package.json', JSON.stringify({ name: 'fixture', optionalDependencies: { '@dsh-ops/bash-win32-x64': '0.2.1', '@dsh-ops/pwsh-win32-x64': '0.2.1' } }))
    for (const [name, exe] of [['bash', 'bash.exe'], ['pwsh', 'pwsh.exe']]) {
      write(`node_modules/@dsh-ops/${name}-win32-x64/package.json`, JSON.stringify({ name: `@dsh-ops/${name}-win32-x64`, version: '0.2.1' }))
      write(`node_modules/@dsh-ops/${name}-win32-x64/bin/${exe}`)
    }
    report = inspectLocalBuild({ root: dir, platform: 'win32', arch: 'x64' })
    assert.deepEqual(report, { problems: [], warnings: [] }, 'a whole local build is quiet')

    // A proxy swapped behind the receipt's back is caught by the hash, not by hope.
    write(`${ipc}/opsnt.dll`, 'proxy-b-tampered')
    report = inspectLocalBuild({ root: dir, platform: 'win32', arch: 'x64' })
    assert.match(report.problems.map(problem => problem.what).join('\n'), /opsnt\.dll 和回执里的哈希对不上/)
    write(`${ipc}/opsnt.dll`, 'proxy-b')
    write(`${ipc}/provenance.json`, pristine)

    // Rebuilding the proxy sources without rebuilding the proxy is the other silent case.
    write('native/bash-ipc/opsipc.cpp', '// changed\n')
    report = inspectLocalBuild({ root: dir, platform: 'win32', arch: 'x64' })
    assert.match(report.problems.map(problem => problem.what).join('\n'), /opsipc\.cpp 变了，代理还是旧的/)
    write('native/bash-ipc/opsipc.cpp', '// opsipc.cpp\n')
    write(`${ipc}/provenance.json`, pristine)

    // A worker older than the Rust it was built from is a warning: the build may be behind.
    const future = new Date(Date.now() + 60_000)
    fs.utimesSync(path.join(dir, 'native', 'src', 'main.rs'), future, future)
    report = inspectLocalBuild({ root: dir, platform: 'win32', arch: 'x64' })
    assert.deepEqual(report.problems, [])
    assert.match(report.warnings.join('\n'), /本地 worker 比 native[\\/]src[\\/]main\.rs 旧/)

    // Off Windows the payload warning does not apply, and the x64 proxies are not expected.
    fs.utimesSync(path.join(dir, 'native', 'src', 'main.rs'), new Date(0), new Date(0))
    write('runtime/linux-x64/dsh-ops-worker')
    write('runtime/linux-x64/provenance.json', JSON.stringify({ version: '1', target: 'linux-x64', executable: 'dsh-ops-worker' }))
    assert.deepEqual(inspectLocalBuild({ root: dir, platform: 'linux', arch: 'x64' }), { problems: [], warnings: [] })
  })
})

await test('setup ends by pointing at the one command, never at the manual three', () => {
  const defaults = nextStepLines({ baseProfile: 'bench-base', candProfile: 'bench-ops', platform: 'win32' })
  assert.equal(defaults.length, 2, 'Windows is the whole story: run it, or look before running')
  assert.match(defaults[0], /^ {2}npm run bench:baseline {2}——/)
  assert.match(defaults[1], /npm run bench:baseline -- --show/)
  assert.ok(defaults.every(line => !/node bench\/(run|compare)\.mjs/.test(line)), 'the manual commands are gone')

  // A renamed pair travels with the suggestion, and npm needs its own -- before the flags.
  const renamed = nextStepLines({ baseProfile: 'alt-base', candProfile: 'alt-ops', platform: 'win32' })
  assert.match(renamed[0], /npm run bench:baseline -- --base alt-base --cand alt-ops/)
  assert.ok(!renamed.some(line => /--base alt-base --cand alt-ops.*--base alt-base/.test(line)), 'the pair is named once')

  // Off Windows the wrapper does not exist, so the same three commands are spelled out.
  const posix = nextStepLines({ baseProfile: 'bench-base', candProfile: 'bench-ops', platform: 'linux' })
  assert.equal(posix.length, 3)
  assert.match(posix[2], /node bench\/compare\.mjs bench-base bench-ops/)
})

await test('the auto folder walks benchmark-test-NN and skips whatever already answers', async () => {
  await withTempDir('bench-folders-', async (dir) => {
    assert.equal(nextFolderName(dir), 'benchmark-test-01', 'a missing runs root starts at 01')
    for (const name of ['benchmark-test-01', 'benchmark-test-02']) fs.mkdirSync(path.join(dir, name))
    assert.equal(nextFolderName(dir), 'benchmark-test-03', 'the first free number wins')
    // Anything with the name reserves it — an empty directory from a failed sweep, or a file.
    fs.mkdirSync(path.join(dir, 'benchmark-test-04'))
    assert.equal(nextFolderName(dir), 'benchmark-test-03', 'a gap is filled before a higher number')
    fs.writeFileSync(path.join(dir, 'benchmark-test-03'), 'reserved by a file')
    assert.equal(nextFolderName(dir), 'benchmark-test-05', 'a collision is any entry, not just a directory')
    fs.mkdirSync(path.join(dir, 'ops-0.3.1'))
    assert.equal(nextFolderName(dir), 'benchmark-test-05', 'other group names do not consume a number')
    // Windows compares names case-insensitively: the scan must too, or it hands out a twin.
    fs.mkdirSync(path.join(dir, 'BENCHMARK-TEST-05'))
    assert.equal(nextFolderName(dir), 'benchmark-test-06', 'a differently-cased collision blocks the name')
    // Past 99 the width simply grows rather than wrapping or colliding.
    for (let number = 6; number <= 99; number += 1) fs.mkdirSync(path.join(dir, `benchmark-test-${String(number).padStart(2, '0')}`))
    assert.equal(nextFolderName(dir), 'benchmark-test-100')
  })
})

await test('the bench:baseline wrapper runs base, candidate and compare as one command', async () => {
  if (process.platform !== 'win32') return // cmd.exe batch wrapper
  await withTempDir('bench-ab-', async (dir) => {
    // A `node` shim on PATH records each invocation, so the wrapper's three steps run
    // without spawning dsh, spending a token, or needing a prepared profile.
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(bin)
    const log = path.join(dir, 'calls.log')
    fs.writeFileSync(path.join(bin, 'node.cmd'), [
      '@echo off',
      'echo %*>>"%AB_LOG%"',
      'echo %*| findstr /c:"bench/compare.mjs" >nul',
      'if not errorlevel 1 exit /b %AB_COMPARE_RC%',
      'exit /b 0',
      '',
    ].join('\r\n'))
    const bat = fileURLToPath(new URL('../bench/platform/win-ab.bat', import.meta.url))
    const invoke = (args, compareRc = '0') => spawnSync(bat, args, {
      cwd: dir, shell: true, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, AB_LOG: log, AB_COMPARE_RC: compareRc },
    })

    // Launched from an unrelated cwd: the wrapper has to find the checkout on its own.
    const ok = invoke(['--task', 'csv-sum', '--repeat', '1', '--folder', 'ab-test'])
    assert.equal(ok.status, 0, ok.stderr)
    assert.match(ok.stdout, /1\/3 baseline/, 'the baseline side is step one')
    assert.match(ok.stdout, /2\/3 candidate/, 'the candidate side is step two')
    assert.match(ok.stdout, /3\/3 compare/, 'the report is step three')
    const calls = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/)
    assert.equal(calls.length, 3, calls.join('\n'))
    assert.match(calls[0], /bench\/run\.mjs --label bench-base --profile bench-base --task csv-sum --repeat 1 --folder ab-test/)
    assert.match(calls[1], /bench\/run\.mjs --label bench-ops --profile bench-ops --task csv-sum --repeat 1 --folder ab-test/)
    assert.match(calls[2], /bench\/compare\.mjs bench-base bench-ops --folder ab-test/)

    // The compare gate's exit code is the command's exit code — not swallowed by the batch.
    const gate = invoke(['--folder', 'ab-gate'], '3')
    assert.equal(gate.status, 3, 'a failing gate fails the one command')
    assert.match(gate.stdout, /compare exit code 3/)

    // Without --folder the wrapper allocates one fresh group and gives it to all three steps.
    const show = spawnSync(bat, ['--show'], { cwd: dir, shell: true, encoding: 'utf8', windowsHide: true })
    assert.equal(show.status, 0, show.stderr)
    const allocated = show.stdout.match(/folder : bench\\runs\\(benchmark-test-\d+)/)?.[1]
    assert.ok(allocated, show.stdout)
    assert.match(show.stdout, /\[auto\]/, 'the allocated group is marked as an automatic one')
    const shown = show.stdout.split(/\r?\n/).filter(line => line.startsWith('node '))
    assert.equal(shown.length, 3)
    for (const line of shown) assert.match(line, new RegExp(`--folder ${allocated}$`), 'all three commands share the allocated group')
  })
})

// ---------------------------------------------------------------- narration

/**
 * An observer wired to an injected clock, log and heartbeat, so the narration rules
 * can be pinned without a child process or a wall-clock wait.
 * @param {object} [config] - overrides passed to `createObserver`.
 * @returns {{lines: object[], observer: object, advance: Function, tick: Function, feed: Function, feedRaw: Function}} the rig.
 */
function narrate(config = {}) {
  const lines = []
  const timers = []
  let clock = 1_000
  const observer = createObserver({
    log: (level, text) => lines.push({ level, text }),
    now: () => clock,
    setTimer: (fn) => {
      timers.push(fn)
      return { unref() {} }
    },
    clearTimer: () => {
      timers.length = 0
    },
    run: { taskId: 'csv-sum', repeatIndex: 0 },
    heartbeatMs: 10_000,
    stallMs: 30_000,
    ...config,
  })
  return {
    lines,
    timers,
    observer,
    advance(ms) {
      clock += ms
    },
    tick() {
      for (const fn of [...timers]) fn()
    },
    feed(...objects) {
      for (const object of objects) observer.line(JSON.stringify(object))
    },
    feedRaw(...raw) {
      for (const line of raw) observer.line(line)
    },
    texts: (level) => lines.filter((line) => line.level === level).map((line) => line.text),
    count(matcher) {
      return lines.filter((line) => matcher.test(line.text)).length
    },
  }
}

const SESSION = { type: 'session', sessionId: 'sess-1', cwd: 'C:\\w' }
const STEP_WITH_USAGE = (step) => ({ type: 'status', phase: 'step_end', turn: 0, step, usage: { inputTokens: 1500, outputTokens: 260, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 40 } })

await test('every event shape narrates itself, and a missing usage is never laundered', () => {
  assert.match(describeEvent(SESSION).text, /session sess-1/)
  const answered = describeEvent(STEP_WITH_USAGE(3))
  assert.equal(answered.kind, 'step_end')
  assert.match(answered.text, /step 3: model answered/)
  assert.match(answered.text, /in 1,500 \/ out 260 \/ cacheRead 0/)
  assert.match(answered.text, /reasoning 40/)
  const bare = describeEvent({ type: 'status', phase: 'step_end', turn: 0, step: 4 })
  assert.equal(bare.kind, 'step_end_no_usage')
  assert.match(bare.text, /NO usage/)
  assert.match(describeEvent({ type: 'status', phase: 'step_start', turn: 0, step: 0 }).text, /request sent to the model/)
  assert.equal(describeEvent({ type: 'tool_result', callId: 'c', status: 'error', result: 'boom' }).kind, 'tool_result_error')
  assert.equal(describeEvent({ type: 'status', phase: 'turn_end', turn: 0, reason: { kind: 'error' } }).kind, 'turn_end_failed')
  assert.equal(describeEvent({ type: 'status', phase: 'turn_end', turn: 0, reason: { kind: 'completed' } }).kind, 'turn_end')
  assert.match(describeEvent({ type: 'error', message: 'workspace preparation failed' }).text, /dsh reported an error: workspace preparation failed/)
  assert.match(describeEvent({ type: 'tool_call', tool: 'ops_bash', input: { command: 'ls -1' } }).text, /tool ops_bash ← \{"command":"ls -1"\}/)
  assert.match(describeEvent({ type: 'thinking', text: 'x'.repeat(5) }).text, /reasoning \+5 chars/)
  assert.match(describeEvent({ type: 'final', text: 'ok' }).text, /final answer received \(2 bytes\)/)
  assert.equal(describeEvent({ type: 'brand_new', x: 1 }).kind, 'brand_new')
  assert.equal(describeEvent(null), null)
  assert.equal(describeEvent({ noType: 1 }), null)
  assert.equal(OBSERVER_LEVELS.join(','), 'info,detail,warn')
})

await test('the observer answers the four questions once, then keeps the chatter short', () => {
  const run = narrate()
  run.observer.started({ command: 'node', args: ['bin.js', '--profile', 'bench-ops', '--json', 'do it'], pid: 4242, timeoutMs: 900_000, cwd: 'C:\\w', eventsFile: 'results/csv-sum-r0.events.ndjson' })
  run.feed(SESSION)
  run.advance(1000)
  run.feed({ type: 'status', phase: 'step_start', turn: 0, step: 0 })
  run.advance(1000)
  run.feed(STEP_WITH_USAGE(0))
  run.advance(1000)
  run.feed(STEP_WITH_USAGE(1))
  run.observer.finished({ exitCode: 0 })
  const info = run.texts('info')
  assert.ok(info.some((text) => /startup OK/.test(text)), 'boot must be reported')
  assert.equal(run.count(/startup OK/), 1, 'boot is announced once per run')
  assert.equal(run.count(/model connection OK/), 1, 'a healthy later step does not re-announce the connection')
  assert.equal(run.count(/request sent to the model/), 1, 'the first request is the milestone; the rest are detail')
  assert.ok(run.lines.some((line) => line.level === 'detail' && /step 1: model answered/.test(line.text)), 'later steps are still there, as chatter')
  assert.ok(info.some((text) => /pid=4242/.test(text)), 'the pid is printed while the child is alive')
  assert.ok(info.some((text) => /timeout=900s/.test(text)), 'the deadline is printed before it is paid')
  assert.ok(info.some((text) => /exited 0 after 0m03s/.test(text)), 'the outcome names the elapsed time')
  assert.ok(run.lines.some((line) => /\[csv-sum r0\]/.test(line.text)), 'every line carries which run it is')
})

await test('missing usage, tool errors and stderr each report themselves once and then count', () => {
  const run = narrate()
  run.feed({ type: 'status', phase: 'step_end', turn: 0, step: 0 })
  run.feed({ type: 'status', phase: 'step_end', turn: 0, step: 1 })
  assert.equal(run.lines.filter((line) => line.level === 'warn' && /NO usage/.test(line.text)).length, 1, 'the first lost usage is the warning')
  assert.equal(run.count(/NO usage/), 2, 'the later ones are still narration, just not shouting')
  assert.equal(run.observer.snapshot().stepsWithUsage, 0)
  assert.equal(run.observer.snapshot().steps, 2)
  for (let i = 0; i < 8; i += 1) run.feed({ type: 'tool_result', callId: `c${i}`, status: 'error', result: 'denied' })
  assert.equal(run.count(/tool result error/), 5, 'tool errors are named up to the cap')
  assert.equal(run.observer.snapshot().toolErrors, 8, 'and counted past it')
  assert.equal(run.count(/counted but not printed/), 1)

  const quiet = narrate()
  quiet.observer.stderr('stub: workspace preparation failed\nsecond line\n')
  assert.equal(quiet.count(/dsh is writing to stderr/), 1, 'the first stderr line is a milestone')
  assert.ok(!quiet.lines.some((line) => line.level === 'detail' && /second line/.test(line.text)), 'stderr lines are echoed only under --verbose')
  quiet.observer.stderr('split ')
  quiet.observer.stderr('across chunks\n')
  assert.equal(quiet.observer.snapshot().stderrLines, 3, 'a chunk boundary must not lose or double-count a line')

  const loud = narrate({ verbose: true })
  loud.observer.stderr('a\nb\n')
  assert.ok(loud.lines.some((line) => line.level === 'detail' && /stderr \| b/.test(line.text)), 'verbose echoes stderr as it arrives')
})

await test('a silent run speaks for itself: heartbeat, then escalating stall warnings', () => {
  const run = narrate({ heartbeatMs: 10_000, stallMs: 30_000 })
  run.observer.started({ pid: 7, eventsFile: 'results/x.events.ndjson', timeoutMs: 60_000 })
  run.advance(5_000)
  run.tick()
  assert.equal(run.count(/still running/), 0, 'a run that just printed does not also get a heartbeat')
  run.advance(6_000)
  run.tick()
  assert.equal(run.count(/still running/), 1, 'a silent run says it is alive')
  assert.match(run.texts('info').find((text) => /still running/.test(text)), /0 event\(s\), steps=0/)
  run.advance(20_000)
  run.tick()
  assert.equal(run.count(/NO OUTPUT FOR/), 1, 'the stall warning arrives once at 1x')
  run.advance(30_000)
  run.tick()
  assert.equal(run.count(/NO OUTPUT FOR/), 2, 'it escalates at 2x')
  assert.match(run.texts('warn').at(-1), /results\/x\.events\.ndjson/, 'and names the archive to watch')
  for (let i = 0; i < 20; i += 1) {
    run.advance(1_000_000)
    run.tick()
  }
  assert.equal(run.count(/NO OUTPUT FOR/), 4, 'escalation stops at the last step instead of shouting forever')
})

await test('the outcome line tells the truth about a run that never started', () => {
  const run = narrate()
  run.observer.started({ pid: 9, timeoutMs: 60_000, eventsFile: 'results/x.events.ndjson' })
  run.observer.stderr('DSH workspace preparation failed (not a user permission denial)\n')
  run.observer.finished({ timedOut: true, timeoutMs: 60_000 })
  assert.equal(run.count(/TIMEOUT after 60s/), 1)
  assert.ok(run.lines.some((line) => line.level === 'warn' && /not one event/.test(line.text)), 'zero events is a startup problem, and must be said as one')
  assert.ok(run.lines.some((line) => /stderr tail: DSH workspace preparation failed/.test(line.text)), 'the post-mortem quotes the last stderr lines')
  assert.equal(run.timers.length, 0, 'finished() must cancel the heartbeat, or the runner outlives its own report')

  const exit = narrate()
  exit.feed(SESSION)
  exit.observer.finished({ exitCode: 1 })
  assert.ok(exit.lines.some((line) => line.level === 'warn' && /dsh exited 1/.test(line.text)), 'a non-zero exit is not a pass')

  const stopped = narrate()
  stopped.feed(SESSION)
  stopped.observer.finished({ exitCode: null, interrupted: true })
  assert.ok(stopped.lines.some((line) => line.level === 'warn' && /interrupted by the operator/.test(line.text)), 'Ctrl-C is recorded as a stop, not as a finished run')

  const junk = narrate()
  junk.feedRaw('not json at all')
  assert.equal(junk.count(/not JSON/), 1, 'a malformed line is narrated, not swallowed')
  assert.match(formatClock(65_000), /^1m05s$/)
  assert.equal(formatClock(0), '0m00s')
})

await test('the logger keeps chatter off the console but out of no file', async () => {
  await withTempDir('bench-log-', async (dir) => {
    const printed = []
    const real = { log: console.log, error: console.error }
    console.log = (...args) => printed.push(['out', ...args].join(' '))
    console.error = (...args) => printed.push(['err', ...args].join(' '))
    let file = null
    try {
      const quiet = createLogger({ verbose: false })
      quiet.info('an info line')
      quiet.detail('a detail line')
      quiet.warn('a warn line')
      file = quiet.attach(dir)
      await quiet.close()
    } finally {
      Object.assign(console, real)
    }
    const out = printed.filter((line) => line.startsWith('out')).join('\n')
    assert.match(out, /an info line/, 'milestones print on stdout')
    assert.ok(!out.includes('a detail line'), 'chatter stays off a quiet console')
    assert.match(printed.join('\n'), /err .*a warn line/, 'warnings go to stderr')
    const archived = fs.readFileSync(file, 'utf8')
    assert.match(archived, /^\d{4}-\d\d-\d\dT.*Z INFO\s+an info line/, 'the file keeps timestamps and levels')
    assert.match(archived, /DETAIL a detail line/, 'the file keeps what the console skipped')
    assert.match(archived, /WARN\s+a warn line/)

    const loud = []
    const restore = console.log
    console.log = (...args) => loud.push(args.join(' '))
    try {
      const talkative = createLogger({ verbose: true })
      talkative.detail('verbose chatter')
    } finally {
      console.log = restore
    }
    assert.match(loud.join('\n'), /verbose chatter/, '--verbose puts the detail lines back')
  })
})

await test('the endpoint can be named and probed before a token is spent', async () => {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const overlay = `- id: llm-pi-ai\n  config:\n    providers:\n      a:\n        baseURL: http://127.0.0.1:${port}/v1\n      b:\n        baseURL: "https://example.invalid:8443/v1"\n`
    assert.deepEqual(extractEndpoints(overlay), [`http://127.0.0.1:${port}/v1`, 'https://example.invalid:8443/v1'], 'baseURL lines are the routing targets')
    assert.deepEqual(extractEndpoints('provider: x\n'), [], 'a tree without baseURLs names nothing')
    const [open, refused, weird] = await probeEndpoints([`http://127.0.0.1:${port}/v1`, 'http://127.0.0.1:9/v1', 'file:///tmp/x'])
    assert.equal(open.ok, true, 'a listening port answers')
    assert.equal(open.port, port)
    assert.equal(refused.ok, false, 'a closed port is reported as unreachable, not as a hang')
    assert.match(refused.note, /ECONNREFUSED/)
    assert.equal(weird.ok, false, 'a non-TCP scheme is skipped')
    assert.match(weird.note, /nothing to probe/)
  } finally {
    server.close()
  }
})

await test('a stderr written in the local code page arrives readable, not as mojibake', () => {
  // The real zh-CN shape of the failure: Windows PowerShell writes its diagnostics in
  // cp936, every consumer here assumes UTF-8, and the one line that names the cause used
  // to arrive as `??ģ??????`.
  const gbk = Buffer.from([0xce, 0xde, 0xb7, 0xa8, 0xbc, 0xd3, 0xd4, 0xd8, 0xc4, 0xa3, 0xbf, 0xe9, 0x20, ...Buffer.from('Microsoft.PowerShell.Security', 'utf8')])
  const decoded = decodeConsoleBytes(gbk)
  assert.equal(decoded.encoding, 'gbk', 'the local page is identified')
  assert.equal(decoded.text, `无法加载模块 Microsoft.PowerShell.Security`, 'and the line is readable')
  assert.equal(decodeConsoleBytes(Buffer.from('plain ascii', 'utf8')).encoding, null, 'UTF-8 is never second-guessed')
  assert.equal(decodeConsoleBytes(Buffer.from('中文也是 UTF-8', 'utf8')).encoding, null)
  assert.equal(decodeConsoleBytes('already a string').text, 'already a string')

  const run = narrate()
  run.observer.stderr(gbk.subarray(0, 9))
  run.observer.stderr(gbk.subarray(9))
  run.observer.stderr(Buffer.from('\n'))
  assert.equal(run.observer.snapshot().stderrLines, 1, 'a chunk boundary inside a multibyte character must not invent a line')
  assert.ok(run.lines.some((line) => /无法加载模块/.test(line.text)), 'the narrated line is readable')
  assert.ok(run.lines.some((line) => /local code page gbk/.test(line.text)), 'and it says which page it came from')

  const mangled = narrate()
  mangled.feed({ type: 'tool_result', callId: 'c', status: 'error', result: '\uFFFD\uFFFDģ\uFFFD\uFFFD Microsoft.PowerShell.Security' })
  assert.equal(mangled.count(/not valid UTF-8/), 1, 'mojibake that is already unrecoverable is explained once, not silently forwarded')
})

await test('describeModulePath marks the entry that shadows Windows PowerShell', () => {
  const inBox = 'C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules'
  const bundled = 'C:\\Users\\x\\.dsh\\profiles\\p\\node_modules\\@dsh-ops\\pwsh-win32-x64\\bin\\Modules'
  // Pinned to ";" for the same reason as the probe: this is a Windows variable being
  // examined from whichever host happens to run the suite.
  const joined = ['C:\\Users\\x\\Documents\\PowerShell\\Modules', bundled, inBox].join(';')
  const line = describeModulePath(joined, bundled, ';')
  assert.match(line, /1\. C:.*Documents/, 'the search order is printed in order')
  assert.match(line, /2\. C:.*pwsh-win32-x64.*Modules/, 'the bundled dir keeps its slot')
  assert.match(line, /<-- CORE MODULE ROOT AHEAD OF 5\.1/, 'and the shadowing entry is named')
  assert.equal(describeModulePath(undefined), 'PSModulePath is not set')
})

await test('the narration flags parse, and default to talking without shouting', () => {
  assert.equal(parseArgs(['--label', 'l', '--profile', 'p']).verbose, false)
  assert.equal(parseArgs(['--label', 'l', '--profile', 'p', '--verbose']).verbose, true)
  assert.equal(parseArgs(['--label', 'l', '--profile', 'p']).heartbeatMs, 15_000)
  assert.equal(parseArgs(['--label', 'l', '--profile', 'p', '--heartbeat-ms', '0']).heartbeatMs, 0, 'a run can be silenced again')
  assert.equal(parseArgs(['--label', 'l', '--profile', 'p', '--stall-ms=90000']).stallMs, 90_000)
  assert.equal(parseArgs(['--label', 'l', '--profile', 'p']).probeEndpoint, true, 'reachability is checked by default')
  assert.equal(parseArgs(['--label', 'l', '--profile', 'p', '--no-probe-endpoint']).probeEndpoint, false)
  assert.throws(() => parseArgs(['--label', 'l', '--profile', 'p', '--heartbeat-ms', 'soon']), /non-negative integer/)
})

report(LABEL)
