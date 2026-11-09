/**
 * The batching section must not be rewritten between steps of one turn.
 *
 * The rendered section sits inside the system prompt, so any change to its text invalidates the
 * provider prompt cache for every later step of the turn. Freezing the notice on the step that
 * raises the flag is what keeps the budget at one revision per turn.
 */
import { assert, test, report } from './lib/harness.mjs'
import { createBatchingTracker } from '../lib/projections/ptc/batching-guidance.js'

const SINGLE = 'const n = await tools.ops_bash({ description: "count", command: "find . -type f | wc -l" })\nreturn n.stdout.text'
const SHORTFALL = '// plan: tree; manifest; src\nconst [a] = await Promise.all([tools.ops_bash({ description: "x", command: "pwd" })])\nreturn a'

await test('the notice is frozen for the turn so the cached prefix is not rewritten per step', () => {
  const tracker = createBatchingTracker()
  const agent = {}
  tracker.observe(agent, SINGLE)
  const first = tracker.notice(agent)
  assert.equal(first.length > 0, true, 'a wasted step produces a notice')
  tracker.observe(agent, SHORTFALL)
  assert.equal(tracker.notice(agent), first, 'a later step must not rewrite the rendered text')
})

await test('a new turn starts without the previous notice', () => {
  const tracker = createBatchingTracker()
  const agent = {}
  tracker.observe(agent, SINGLE)
  assert.equal(tracker.active(agent), true)
  tracker.reopen(agent)
  assert.equal(tracker.active(agent), false, 'the flag is cleared at the turn boundary')
  assert.equal(tracker.notice(agent), '', 'the old contradiction must not leak into the next turn')
})

await test('an agent that batches is never flagged', () => {
  const tracker = createBatchingTracker()
  const agent = {}
  const good = '// plan: tree; manifest; src\nconst [a,b,c] = await Promise.all([tools.ops_bash({ description: "x", command: "pwd" }), tools.ops_read_files({ files: [{ path: "package.json" }] }), tools.ops_glob({ pattern: ["src/**/*.ts"] })])\nreturn 1'
  assert.equal(tracker.observe(agent, good), false)
  assert.equal(tracker.active(agent), false)
  assert.equal(tracker.notice(agent), '')
})

report('ptc-batching-cache')
