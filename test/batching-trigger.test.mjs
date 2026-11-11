/**
 * The program-shape analyzer behind the batching trigger.
 *
 * The module is a pure kernel: literal rules over the program text, no host, no
 * worker, no disk. These cases pin the rules the trigger relies on, including the
 * ones a naive implementation gets wrong: the plan comment must be the first
 * physical line, a full-width semicolon separates entries too, a program that
 * dispatches nothing has no call shape to correct, and comment or string text is
 * never mistaken for raw file IO.
 */
import { assert, test, report } from './lib/harness.mjs'
import { analyzeProgram, parsePlan, violationsOf, createProgramLatch, noticeText, CATEGORY_PRIORITY, PLAN_DIRECTIVE, THIN_CODE_CHARS } from '../lib/ptc/batching-guidance.js'

await test('the plan comment is read from the first physical line only', () => {
  assert.deepEqual(parsePlan('// plan: read the config; read the test'), ['read the config', 'read the test'])
  // The full-width semicolon separates entries as well; both are typed on a CJK layout.
  assert.deepEqual(parsePlan('// plan: 读取配置；运行测试'), ['读取配置', '运行测试'])
  // Indentation and a UTF-8 BOM are tolerated; neither hides the first line.
  assert.deepEqual(parsePlan('  // plan: one ; two'), ['one', 'two'])
  assert.deepEqual(parsePlan('\ufeff// plan: one'), ['one'])
  // A blank line or any code before it makes the declaration late, so it does not count.
  assert.deepEqual(parsePlan('\n// plan: late'), [])
  assert.deepEqual(parsePlan('const x = 1\n// plan: late'), [])
  // A plan line with no entries declares nothing.
  assert.deepEqual(parsePlan('// plan:'), [])
  assert.deepEqual(parsePlan(undefined), [])
  assert.equal(PLAN_DIRECTIVE, '// plan:')
})

await test('the analyzer counts dispatch sites and reads structure from the text', () => {
  const single = analyzeProgram('const row = await tools.ops_stat({ path: "a" })\nreturn row.status')
  assert.equal(single.dispatchSites, 1)
  assert.equal(single.hasBatchingStructure, false)
  assert.equal(single.hasFirstLinePlan, false)

  // A bracket call is the same dispatch site as a dotted one.
  assert.equal(analyzeProgram('return await tools["ops_read_files"]({ path: "a" })').dispatchSites, 1)
  // A loop or a map is one site, not its runtime fan-out: this is a text heuristic.
  const mapped = analyzeProgram('const rows = await Promise.all(paths.map(p => tools.ops_stat({ path: p })))\nreturn rows')
  assert.equal(mapped.dispatchSites, 1)
  assert.equal(mapped.hasBatchingStructure, true)

  assert.equal(analyzeProgram('const r = await tools.job_output({ job_id: "b", wait: true })').isWaiting, true)
  assert.equal(analyzeProgram('if (x) { await tools.ops_stat({ path: "a" }) }').hasBranching, true)
  assert.equal(analyzeProgram(undefined).dispatchSites, 0)
  assert.equal(analyzeProgram('').chars, 0)
})

await test('the bypass rule separates shell file work from shell process work', () => {
  // A shell call that only starts a process is not a bypass.
  assert.equal(analyzeProgram('const r = await tools.ops_bash({ description: "build", command: "npm run build" })').bypassesFileTools, false)
  // The same shell tool listing files is, because the listing API exists.
  assert.equal(analyzeProgram('const r = await tools.ops_bash({ description: "list", command: "ls -la" })').bypassesFileTools, true)
  assert.equal(analyzeProgram('const r = await tools.ops_bash({ description: "cat", command: "cat package.json" })').bypassesFileTools, true)
  assert.equal(analyzeProgram('const raw = require("node:fs").readFileSync("a")').bypassesFileTools, true)
})

await test('comments and strings are not a bypass, while real module IO still is', () => {
  // The rule text itself names node:fs; mentioning it is not doing it.
  assert.equal(analyzeProgram('// plan: read the manifest\n// never call node:fs or fs.readFileSync directly\nconst r = await tools.ops_read_files({ files: [{ path: "a" }] })\nreturn r').bypassesFileTools, false)
  assert.equal(analyzeProgram('/* node:fs and node:child_process are forbidden */\nconst r = await tools.ops_stat({ path: "a" })\nreturn r').bypassesFileTools, false)
  assert.equal(analyzeProgram('const r = await tools.ops_stat({ path: "a" })\nreturn { rule: "node:fs is forbidden" }').bypassesFileTools, false)
  assert.equal(analyzeProgram('const note = \x60use ops_read_files, not node:fs\x60\nconst r = await tools.ops_stat({ path: "a" })\nreturn note').bypassesFileTools, false)
  // A comment that names a shell listing is not the program running one.
  assert.equal(analyzeProgram('const r = await tools.ops_bash({ description: "build", command: "npm run build" })\n// ls -la would be a bypass\nreturn r').bypassesFileTools, false)
  // Real module access still counts: import, require, the fs namespace, and an
  // interpolated expression that really reads a file.
  assert.equal(analyzeProgram('import fs from "node:fs"\nconst r = await tools.ops_stat({ path: "a" })\nreturn fs.readFileSync("a", "utf8")').bypassesFileTools, true)
  assert.equal(analyzeProgram('const cp = require("node:child_process")\nconst r = await tools.ops_stat({ path: "a" })\nreturn cp').bypassesFileTools, true)
  assert.equal(analyzeProgram('const r = await tools.ops_stat({ path: "a" })\nreturn fs.readFileSync("a")').bypassesFileTools, true)
  assert.equal(analyzeProgram('const r = await tools.ops_stat({ path: "a" })\nreturn \x60\x24{fs.readFileSync("a")}\x60').bypassesFileTools, true)
})

await test('a program with no dispatch site earns no category', () => {
  // A value program and a comment-only program have no call shape to correct.
  for (const code of ['return 1', '// plan: read nothing\n// a note about node:fs\nreturn 1', '// tools.ops_stat({ path: "a" })\nreturn 1']) {
    assert.equal(analyzeProgram(code).dispatchSites, 0, 'a commented-out call is not a dispatch site')
    assert.deepEqual(violationsOf(analyzeProgram(code)), { plan: false, bypass: false, shape: false })
  }
  // The latch stays silent, so the model is never accused of a shape it did not take.
  const latch = createProgramLatch(), agent = {}
  assert.equal(latch.observe(agent, 'return 1'), undefined)
  assert.equal(latch.observe(agent, '// plan: read nothing\n// a note\nreturn 1'), undefined)
  assert.equal(latch.stats(agent).total, 0, 'no category was spent')
  // One dispatch site restores the normal verdict: the gate is not a blanket silence.
  assert.deepEqual(violationsOf(analyzeProgram('const r = await tools.ops_stat({ path: "a" })\nreturn r')),
    { plan: true, bypass: false, shape: true })
})

await test('each of the three categories is decided independently', () => {
  const good = analyzeProgram('// plan: list the sources; read the manifest\nconst [a, b] = await Promise.all([tools.ops_glob({ pattern: ["src/**"] }), tools.ops_read_files({ files: [{ path: "package.json" }] })])\nreturn { a, b }')
  assert.deepEqual(violationsOf(good), { plan: false, bypass: false, shape: false })

  // One program can break two categories at once; a single verdict would hide one.
  const both = analyzeProgram('const r = await tools.ops_bash({ description: "list", command: "ls -la" })\nreturn r')
  assert.deepEqual(violationsOf(both), { plan: true, bypass: true, shape: true })

  // Waiting on a job is a legitimate non-batched shape, so only the plan is missing.
  const waiting = analyzeProgram('const r = await tools.ops_bash({ description: "run", command: "npm test" })\nconst j = await tools.job_output({ job_id: "b", wait: true })\nreturn j.text')
  assert.equal(violationsOf(waiting).shape, false)

  // A long unstructured program is not judged from its text alone.
  const long = analyzeProgram('const pad = "' + 'x'.repeat(THIN_CODE_CHARS) + '"\nreturn pad.length')
  assert.equal(violationsOf(long).shape, false)
})


// ---- the per-turn latch (option 4a: re-armed by compliance, no per-turn cap) ----

/** One program that breaks every category: no plan line, shell listing, one dispatch. */
const BYPASS = 'const r = await tools.ops_bash({ description: "list", command: "ls -la" })\nreturn r'
/** No plan line and a single dispatch, but no bypass. */
const THIN = 'const r = await tools.ops_read_files({ files: [{ path: "a" }] })\nreturn r'
/** A compliant program: plan line, batched reads, no bypass. */
const GOOD = '// plan: list the sources; read the manifest\nconst [a, b] = await Promise.all([tools.ops_glob({ pattern: ["src/**"] }), tools.ops_read_files({ files: [{ path: "package.json" }] })])\nreturn { a, b }'

await test('one category delivers once per turn and stays silent until it is re-armed', () => {
  const latch = createProgramLatch(), agent = {}
  assert.equal(latch.observe(agent, THIN).category, 'plan', 'the first program earns the plan notice')
  assert.equal(latch.isArmed(agent, 'plan'), false)
  // THIN breaks two categories, so the second one speaks before the turn falls silent.
  assert.equal(latch.observe(agent, THIN).category, 'shape', 'the other broken category speaks once too')
  assert.equal(latch.observe(agent, THIN), undefined, 'both categories are spent for this turn')
})

await test('a compliant program re-arms its category, so a regression speaks again', () => {
  const latch = createProgramLatch(), agent = {}
  assert.equal(latch.observe(agent, THIN).category, 'plan')
  assert.equal(latch.observe(agent, THIN).category, 'shape', 'the other broken category still speaks')
  assert.equal(latch.observe(agent, THIN), undefined, 'both categories are spent')
  assert.equal(latch.observe(agent, GOOD), undefined, 'the compliant program earns nothing')
  assert.equal(latch.isArmed(agent, 'plan'), true, 'compliance re-arms the category')
  assert.equal(latch.isArmed(agent, 'shape'), true, 'and the shape category too')
  // No per-turn cap: the regression earns a fresh notice inside the same turn.
  assert.equal(latch.observe(agent, THIN).category, 'plan', 'the regression speaks again in the same turn')
})

await test('priority orders the categories and the others stay armed', () => {
  const latch = createProgramLatch(), agent = {}
  assert.deepEqual([...CATEGORY_PRIORITY], ['bypass', 'plan', 'shape'])
  assert.equal(latch.observe(agent, BYPASS).category, 'bypass', 'a bypass outranks the other two')
  assert.equal(latch.isArmed(agent, 'plan'), true, 'the plan notice was not spent')
  assert.equal(latch.observe(agent, THIN).category, 'plan')
  assert.equal(latch.observe(agent, THIN).category, 'shape', 'the shape notice still speaks')
})

await test('a new turn re-arms every category and a repeated turn does not', () => {
  const latch = createProgramLatch(), agent = {}
  latch.noteTurn(agent, 1)
  assert.equal(latch.observe(agent, THIN).category, 'plan')
  latch.noteTurn(agent, 1)
  assert.equal(latch.isArmed(agent, 'plan'), false, 'the same turn is not a new turn')
  latch.noteTurn(agent, 2)
  assert.equal(latch.observe(agent, THIN).category, 'plan', 'the next turn speaks again')
})

await test('state never leaks between agents and forget drops it', () => {
  const latch = createProgramLatch(), first = {}, second = {}
  assert.equal(latch.observe(first, THIN).category, 'plan')
  assert.equal(latch.observe(second, THIN).category, 'plan', 'the second agent is independent')
  latch.forget(first)
  assert.equal(latch.isArmed(first, 'plan'), true, 'a forgotten agent starts clean')
})

await test('the latch counts deliveries per turn for the optional telemetry line', () => {
  const latch = createProgramLatch(), agent = {}
  latch.noteTurn(agent, 4)
  assert.deepEqual(latch.stats(agent), { turn: 4, plan: 0, bypass: 0, shape: 0, total: 0 })
  latch.observe(agent, THIN)
  latch.observe(agent, THIN)
  assert.deepEqual(latch.stats(agent), { turn: 4, plan: 1, bypass: 0, shape: 1, total: 2 })
  // A new turn resets the counters with the latch.
  latch.noteTurn(agent, 5)
  assert.deepEqual(latch.stats(agent), { turn: 5, plan: 0, bypass: 0, shape: 0, total: 0 })
})

await test('the notices name the fix and never claim a runtime dispatch count', () => {
  const shape = analyzeProgram(BYPASS)
  assert.match(noticeText('plan', shape), /first line/, 'the plan notice names the first line')
  assert.doesNotMatch(noticeText('plan', shape), /Promise\.all/, 'the plan notice stays about the comment')
  assert.match(noticeText('bypass', shape), /ops_glob/)
  assert.match(noticeText('bypass', shape), /ops_load_sdk/)
  assert.match(noticeText('shape', shape), /program text alone/, 'the shape notice states its own limit')
})

report('batching-trigger')
