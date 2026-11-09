import { assert, test, report } from './lib/harness.mjs'
import {
  BATCHING_GUIDANCE, PLAN_DIRECTIVE, THIN_CODE_CHARS, analyzeProgram, createBatchingTracker,
  isSingleStepProgram, parsePlan, verdictOf,
} from '../lib/projections/ptc/batching-guidance.js'
import { parsePtcConfig } from '../lib/ptc/config.js'
import { resolveModeConfig } from '../lib/presets/config.js'

await test('the static analysis reads dispatch sites, batching constructs and waits', () => {
  const one = analyzeProgram("const r = await tools.ops_stat({ path: 'a' })\nreturn r.status")
  assert.equal(one.dispatches, 1)
  assert.equal(one.batched, false)
  assert.equal(one.planned, false)

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

await test('a plan line is parsed and a program that does less than it planned is flagged', () => {
  const shortfall = [
    '// plan: directory tree; manifest head; source list',
    "const a = await tools.ops_bash({ description: 'tree', command: 'ls' })",
    'return a',
  ].join('\n')
  assert.deepEqual(parsePlan(shortfall), ['directory tree', 'manifest head', 'source list'])
  assert.equal(analyzeProgram(shortfall).declared, 3)
  assert.equal(verdictOf(analyzeProgram(shortfall)), 'shortfall', 'three declared, one issued')
  assert.equal(isSingleStepProgram(shortfall), true)

  const honest = [
    '// plan: tree; working directory',
    'const [a, b] = await Promise.all([',
    "  tools.ops_bash({ description: 'tree', command: 'ls' }),",
    "  tools.ops_bash({ description: 'pwd', command: 'pwd' }),",
    '])',
    'return [a, b]',
  ].join('\n')
  assert.equal(verdictOf(analyzeProgram(honest)), 'batched', 'the plan matches what ran')
  assert.equal(isSingleStepProgram(honest), false)

  const tracker = createBatchingTracker()
  const agent = {}
  tracker.observe(agent, shortfall)
  assert.ok(tracker.notice(agent).includes('declared 3 operation(s) and issued 1'), tracker.notice(agent))
})

await test('a single-purpose step is flagged and every structured step is not', () => {
  assert.equal(isSingleStepProgram("return await tools.ops_stat({ path: 'a' })"), true)
  assert.equal(isSingleStepProgram('return 1'), true, 'a no-op step is also a wasted step')
  assert.equal(isSingleStepProgram('const r = await Promise.all([tools.ops_glob({ pattern: ["*"] })])\nreturn r'), false)
  assert.equal(isSingleStepProgram("for (const p of ps) await tools.ops_stat({ path: p })"), false)
  assert.equal(isSingleStepProgram("if (x) { await tools.ops_stat({ path: 'a' }) }"), false)
  assert.equal(isSingleStepProgram('const j = await tools.job_output({ job_id: "b", wait: true })\nreturn j.text'), false)
  assert.equal(isSingleStepProgram("await tools.ops_stat({ path: 'a' })\nawait tools.ops_stat({ path: 'b' })"), true)
  assert.equal(isSingleStepProgram('x'.repeat(THIN_CODE_CHARS + 10)), false, 'a long unstructured program is not judged cheaply')
})

await test('one wasted step flags the agent immediately and the flag survives the turn', () => {
  const tracker = createBatchingTracker()
  const agent = {}
  assert.equal(tracker.active(agent), false)
  assert.equal(tracker.observe(agent, "return await tools.ops_stat({ path: 'a' })"), true)
  assert.equal(tracker.active(agent), true, 'the flag is visible to the next assembly')
  assert.equal(tracker.observe(agent, "return await tools.ops_stat({ path: 'b' })"), false)
  assert.equal(tracker.active(agent), true)
  tracker.reopen(agent)
  assert.equal(tracker.active(agent), false, 'the next turn starts unreminded')
  const other = {}
  tracker.reopen(other)
  assert.equal(tracker.active(other), false, 'state never leaks between agents')
  tracker.forget(agent)
  assert.equal(tracker.notice(agent), '', 'a forgotten agent has nothing to report')
})

await test('the playbook is a teacher trajectory: a plan line, runnable programs and the failure modes', () => {
  assert.ok(BATCHING_GUIDANCE.includes(PLAN_DIRECTIVE), 'the plan directive opens the procedure')
  assert.ok(BATCHING_GUIDANCE.includes('Trajectory 1'), 'reconnaissance is taught by example')
  assert.ok(BATCHING_GUIDANCE.includes('Trajectory 4'), 'paging is taught by example')
  assert.ok(BATCHING_GUIDANCE.includes('Promise.all'))
  assert.ok(BATCHING_GUIDANCE.includes('try/catch'))
  assert.ok(BATCHING_GUIDANCE.includes('e.message'), 'the error table names the message field')
  assert.ok(BATCHING_GUIDANCE.includes('Common mistakes'))
  assert.ok(BATCHING_GUIDANCE.includes('node:fs'))
  assert.ok(BATCHING_GUIDANCE.includes('never a shortcut around'))
  assert.ok(BATCHING_GUIDANCE.includes('nextOffset'), 'paging advances by the cursor')
  assert.ok(BATCHING_GUIDANCE.split('// plan:').length - 1 >= 5, 'every trajectory carries a plan line')
  assert.ok(BATCHING_GUIDANCE.length > 2500, 'the trajectories are present: ' + BATCHING_GUIDANCE.length)
  assert.ok(BATCHING_GUIDANCE.length < 9000, 'guidance stays bounded: ' + BATCHING_GUIDANCE.length)
  assert.ok(BATCHING_GUIDANCE.includes('ops_load_sdk'), 'every trajectory that loads is reachable')
  // A fan-out with no stated ceiling invites one program with thousands of dispatches.
  // The runtime caps one program at 128, so the playbook has to name that number.
  assert.ok(BATCHING_GUIDANCE.includes('128'), 'the dispatch ceiling is stated: ' + BATCHING_GUIDANCE.includes('128'))
})

await test('the row switch defaults off, opts in explicitly and refuses a non-boolean value', () => {
  assert.equal(parsePtcConfig({}).batchingGuidance, false, 'the stock row must stay the control arm')
  assert.equal(parsePtcConfig({ batchingGuidance: true }).batchingGuidance, true)
  assert.equal(parsePtcConfig({ batchingGuidance: false }).batchingGuidance, false)
  assert.throws(() => parsePtcConfig({ batchingGuidance: 'no' }), /batchingGuidance must be boolean/)
  assert.doesNotThrow(() => resolveModeConfig({ batchingGuidance: false }), 'the mode row accepts the switch')
  assert.equal(resolveModeConfig({ batchingGuidance: false }).batchingGuidance, false)
  assert.equal(resolveModeConfig({ batchingGuidance: true }).batchingGuidance, true)
  assert.equal(resolveModeConfig({}).batchingGuidance, false)
})

await test('the load step is taught and the bypass notice names the replacement', () => {
  // A session that copied Trajectory 1 without the load hit "tools.ops_read_files is not a
  // function", then abandoned the SDK and did the whole task through the shell. The playbook
  // has to say that an on-demand name is loaded, never replaced.
  assert.ok(BATCHING_GUIDANCE.includes('ops_load_sdk'), 'the playbook teaches the loader')
  assert.ok(BATCHING_GUIDANCE.includes('NEXT step'), 'the load lands on the next step, never the same program')

  // A bypass notice that only names the offence leaves the model nothing to act on.
  const tracker = createBatchingTracker()
  const key = {}
  const shellFileWork = [
    '// plan: list files',
    'const r = await tools.ops_bash({ description: "List files", command: "pwd; ls -la" })',
    'return r.stdout.text',
  ].join('\n')
  assert.equal(verdictOf(analyzeProgram(shellFileWork)), 'bypass', 'shell file work is a bypass')
  assert.equal(tracker.observe(key, shellFileWork), true, 'the first bypass raises the flag')
  const notice = tracker.notice(key)
  assert.ok(notice.includes('ops_glob'), 'the notice names the listing tool: ' + notice)
  assert.ok(notice.includes('ops_read_files'), 'the notice names the read tool')
  assert.ok(notice.includes('ops_load_sdk'), 'the notice says how to make them callable')
})

report()
