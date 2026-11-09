import { assert, test, report } from './lib/harness.mjs'
import {
  BATCHING_GUIDANCE, THIN_CODE_CHARS, analyzeProgram, createBatchingTracker, isSingleStepProgram,
} from '../lib/projections/ptc/batching-guidance.js'
import { parsePtcConfig } from '../lib/ptc/config.js'
import { resolveModeConfig } from '../lib/presets/config.js'

await test('the static analysis reads dispatch sites, batching constructs and waits', () => {
  const one = analyzeProgram("const r = await tools.ops_stat({ path: 'a' })\nreturn r.status")
  assert.equal(one.dispatches, 1)
  assert.equal(one.batched, false)
  assert.equal(one.branching, false)

  const many = analyzeProgram([
    "const paths = ['a', 'b', 'c']",
    'const rows = await Promise.all(paths.map(p => tools.ops_stat({ path: p })))',
    'return rows.length',
  ].join('\n'))
  assert.equal(many.dispatches, 1)
  assert.equal(many.batched, true, 'map plus Promise.all is the batching shape')

  const bracket = analyzeProgram('return await tools["ops_read_files"]({ path: "a" })')
  assert.equal(bracket.dispatches, 1, 'bracket access is still a dispatch')

  assert.equal(analyzeProgram(undefined).dispatches, 0)
  assert.equal(analyzeProgram('').chars, 0)
})

await test('a single-purpose step is flagged and every structured step is not', () => {
  // Flagged: one fetch and nothing else.
  assert.equal(isSingleStepProgram("return await tools.ops_stat({ path: 'a' })"), true)
  assert.equal(isSingleStepProgram('return 1'), true, 'a no-op step is also a wasted step')
  // Not flagged: batching, looping, branching, or holding a wait.
  assert.equal(isSingleStepProgram('const r = await Promise.all([tools.ops_glob({ pattern: "*" })])\nreturn r'), false)
  assert.equal(isSingleStepProgram("for (const p of ps) await tools.ops_stat({ path: p })"), false)
  assert.equal(isSingleStepProgram("if (x) { await tools.ops_stat({ path: 'a' }) }"), false)
  assert.equal(isSingleStepProgram('const j = await tools.job_output({ job_id: "b", wait: true })\nreturn j.text'), false)
  // Two raw dispatches with no structure stay flagged while the program is small.
  assert.equal(isSingleStepProgram("await tools.ops_stat({ path: 'a' })\nawait tools.ops_stat({ path: 'b' })"), true)
  assert.equal(isSingleStepProgram('x'.repeat(THIN_CODE_CHARS + 10)), false, 'a long unstructured program is not judged cheaply')
})

await test('one wasted step flags the agent immediately and the flag survives the turn', () => {
  const tracker = createBatchingTracker()
  const agent = {}
  assert.equal(tracker.active(agent), false)
  assert.equal(tracker.observe(agent, "return await tools.ops_stat({ path: 'a' })"), true)
  // A whole task runs inside one turn, so waiting for the boundary meant never firing.
  assert.equal(tracker.active(agent), true, 'the flag is visible to the next assembly')

  // Repeating the waste does not re-flag: one revision per turn is the budget.
  assert.equal(tracker.observe(agent, "return await tools.ops_stat({ path: 'b' })"), false)
  // A dense program mid-turn does not withdraw it either.
  tracker.observe(agent, 'const r = await Promise.all([1])\nreturn r')
  assert.equal(tracker.active(agent), true)
  tracker.reopen(agent)
  assert.equal(tracker.active(agent), false, 'the next turn starts unreminded')

  const other = {}
  tracker.reopen(other)
  assert.equal(tracker.active(other), false, 'state never leaks between agents')
  tracker.forget(agent)
  assert.equal(tracker.active(agent), false)
})

await test('the playbook carries the rules and the failure modes, not just an imperative', () => {
  assert.match(BATCHING_GUIDANCE, /Promise\.all/)
  assert.match(BATCHING_GUIDANCE, /try\/catch/)
  assert.match(BATCHING_GUIDANCE, /e\.message/, 'the error table names the message field')
  assert.match(BATCHING_GUIDANCE, /Never:/)
  // Reaching around the tool surface is wrong on its own, not merely inefficient.
  assert.match(BATCHING_GUIDANCE, /node:fs/)
  assert.match(BATCHING_GUIDANCE, /bypass/, 'the playbook names the bypass as forbidden')
  assert.ok(BATCHING_GUIDANCE.length < 1800, 'guidance is ' + BATCHING_GUIDANCE.length + ' characters')
})

await test('the row switch defaults on and refuses a non-boolean value', () => {
  assert.equal(parsePtcConfig({}).batchingGuidance, true)
  assert.equal(parsePtcConfig({ batchingGuidance: false }).batchingGuidance, false)
  assert.throws(() => parsePtcConfig({ batchingGuidance: 'no' }), /batchingGuidance must be boolean/)
  assert.doesNotThrow(() => resolveModeConfig({ batchingGuidance: false }), 'the mode row accepts the switch')
  assert.equal(resolveModeConfig({ batchingGuidance: false }).batchingGuidance, false)
  assert.equal(resolveModeConfig({}).batchingGuidance, true)
})

report()
