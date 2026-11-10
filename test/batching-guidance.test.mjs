/**
 * The repeated-write detector behind the ops-ptc batching guidance.
 *
 * The module is a pure kernel, so this suite drives it with plain agents: a
 * trigger here fails when the window, the per-turn reset, the already-notified
 * set, or path normalization regresses, without booting a host or a worker.
 */
import { assert, test, report } from './lib/harness.mjs'
import { BATCHING_GUIDANCE, BATCHING_GUIDANCE_ID, BATCHING_GUIDANCE_REVISION, createBatchingTracker, normalizePath } from '../lib/ptc/batching-guidance.js'

/** One fake agent: only the session working directory is read. */
const agentAt = cwd => ({ id: 'batching-' + cwd, session: { header: { cwd } } })
const write = (tracker, agent, rawPath) => tracker.recordWrite(agent, 'write_file', { path: rawPath, content: 'x' })

await test('the shipped guidance names the batch-call rules and its host-source identity', () => {
  // The text is the user's wording; a reworded or truncated guide is a product
  // change, not an implementation detail, so pin the sections the rules live in.
  for (const heading of ['# 批量调用工具', '### 核心规则', '### 常见错误', '有依赖的调用放进', '单项失败导致全部中断', 'e.toolName']) {
    assert.ok(BATCHING_GUIDANCE.includes(heading), heading)
  }
  assert.equal(BATCHING_GUIDANCE_ID, 'batching-guidance')
  assert.match(BATCHING_GUIDANCE_REVISION, /^\d+$/)
})

await test('the third consecutive write to one path notifies once in the turn', () => {
  const tracker = createBatchingTracker({ window: 3 }), agent = agentAt('/work')
  assert.equal(write(tracker, agent, 'a.txt').shouldNotify, false)
  assert.equal(write(tracker, agent, 'a.txt').shouldNotify, false)
  const third = write(tracker, agent, 'a.txt')
  assert.equal(third.shouldNotify, true)
  assert.equal(third.path, normalizePath('a.txt', '/work'))
  // The injected context rides this tool result; the rest of the turn must not
  // repeat it for the same path.
  assert.equal(write(tracker, agent, 'a.txt').shouldNotify, false)
  assert.equal(write(tracker, agent, 'a.txt').shouldNotify, false)
})

await test('a different path inside the window resets the consecutive run', () => {
  const tracker = createBatchingTracker({ window: 3 }), agent = agentAt('/work')
  assert.equal(write(tracker, agent, 'a.txt').shouldNotify, false)
  assert.equal(write(tracker, agent, 'a.txt').shouldNotify, false)
  // Three same-path writes must be consecutive: the odd write breaks the run.
  assert.equal(write(tracker, agent, 'b.txt').shouldNotify, false)
  assert.equal(write(tracker, agent, 'a.txt').shouldNotify, false, 'the interruption restarts the run')
  assert.equal(write(tracker, agent, 'a.txt').shouldNotify, false)
  assert.equal(write(tracker, agent, 'a.txt').shouldNotify, true, 'three consecutive writes after the interruption fire')
})

await test('a new turn clears the window and the already-notified set', () => {
  const tracker = createBatchingTracker({ window: 3 }), agent = agentAt('/work')
  tracker.noteTurn(agent, 1)
  assert.equal(write(tracker, agent, 'a.txt').shouldNotify, false)
  assert.equal(write(tracker, agent, 'a.txt').shouldNotify, false)
  assert.equal(write(tracker, agent, 'a.txt').shouldNotify, true)
  // Repeating the same turn must not clear anything: the host may announce it again.
  tracker.noteTurn(agent, 1)
  assert.equal(write(tracker, agent, 'a.txt').shouldNotify, false)
  tracker.noteTurn(agent, 2)
  assert.equal(write(tracker, agent, 'a.txt').shouldNotify, false)
  assert.equal(write(tracker, agent, 'a.txt').shouldNotify, false)
  assert.equal(write(tracker, agent, 'a.txt').shouldNotify, true, 'the next turn earns its own guidance')
})

await test('equivalent spellings of one path share one window entry', () => {
  const tracker = createBatchingTracker({ window: 3 }), agent = agentAt('/work')
  assert.equal(normalizePath('a.txt', '/work'), normalizePath('./a.txt', '/work'))
  assert.equal(write(tracker, agent, 'a.txt').shouldNotify, false)
  assert.equal(write(tracker, agent, './a.txt').shouldNotify, false)
  assert.equal(write(tracker, agent, 'a.txt').shouldNotify, true, "'a.txt' and './a.txt' are one path")
})

await test('a write without a usable path never counts toward the window', () => {
  const tracker = createBatchingTracker({ window: 3 }), agent = agentAt('/work')
  assert.equal(tracker.recordWrite(agent, 'copy', { from: 'a', to: 'b' }).shouldNotify, false)
  assert.equal(tracker.recordWrite(agent, 'write_file', { path: '' }).shouldNotify, false)
  assert.equal(tracker.recordWrite(agent, 'write_file', { path: 7 }).shouldNotify, false)
  assert.equal(write(tracker, agent, 'a.txt').shouldNotify, false)
  assert.equal(write(tracker, agent, 'a.txt').shouldNotify, false)
  assert.equal(write(tracker, agent, 'a.txt').shouldNotify, true, 'pathless calls do not fill the window')
  // forget() drops the agent state entirely.
  tracker.forget(agent)
  assert.equal(write(tracker, agent, 'a.txt').shouldNotify, false)
})


await test('the ops-ptc row is the one row configured to deliver the guidance', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { parse } = await import('yaml')
  const { resolveMergedConfig } = await import('../lib/settings/merged.js')
  const { resolveModeConfig } = await import('../lib/modes/config.js')
  const { modeGate } = await import('../lib/presets/builtin.js')
  const { PACKAGE_ROOT } = await import('./lib/harness.mjs')
  // Default off everywhere; only the row-level YAML switch turns it on.
  const defaults = resolveMergedConfig()
  for (const mode of ['minimal', 'standard', 'ptc', 'cordis']) assert.equal(defaults[mode].config.batchingGuidance, false, mode)
  assert.equal(defaults['ops-ptc'].config.batchingGuidance, false)
  assert.equal(resolveModeConfig({ batchingGuidance: true }, 'ops-ptc').batchingGuidance, true)
  assert.throws(() => resolveModeConfig({ batchingGuidance: 'yes' }, 'ops-ptc'), /batchingGuidance must be boolean/)
  // The switch rides the consumer gate; a row that drops it cannot deliver.
  assert.equal(modeGate({}, 'ops-ptc', true).batching, true)
  assert.equal(modeGate({}, 'ops-ptc', false).batching, false)
  // The shipped bundle enables it for ops-ptc alone (the comparison arm).
  const patch = parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8'))
  const config = patch.flatMap(entry => entry.insert ?? [])[0].config
  assert.equal(config['ops-ptc'].batchingGuidance, true)
  for (const mode of ['minimal', 'standard', 'ptc', 'cordis']) assert.equal(Object.hasOwn(config[mode], 'batchingGuidance'), false, mode)
  assert.equal(resolveMergedConfig(config)['ops-ptc'].config.batchingGuidance, true)
  assert.equal(modeGate({}, 'ops-ptc', resolveMergedConfig(config)['ops-ptc'].config.batchingGuidance).batching, true)
})

report('batching-guidance')
