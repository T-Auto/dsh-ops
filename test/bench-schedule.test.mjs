/**
 * The scheduler gate (P8b): AB/BA interleaving, serial execution, the A/A noise
 * floor, the injected seal callback, and honest failure/interrupt records.
 *
 * Nothing here spawns a real child, talks to a model, or reads the developer's
 * `~/.dsh`: `runSweep` takes its `runSession` as an injected function, so every check
 * runs against a scripted fake that returns synthetic rows and records the call order.
 * The clock and the sleep are injected too, so no check waits on real time.
 *
 * @module dsh-ops/test/bench-schedule
 */

import fs from 'node:fs'
import path from 'node:path'

import { assert, report, test, tick, withTempDir } from './lib/harness.mjs'
import { SUMMARY_FORMAT, armOrder, planPairs, planSessions, repeatsById, runSweep } from '../bench/run/schedule.mjs'
import { buildArms, exitFor, main, parseRunArgs, prepareDirs } from '../bench/run.mjs'
import { EXIT } from '../bench/cli.mjs'

const LABEL = 'bench-schedule'

/** A launcher that is never executed: the injected runSession stands in for P7. */
/** The fixed clock: no check waits on real time. */
const NOW = () => Date.UTC(2026, 9, 18, 3, 4, 5)

/** A launcher that is never executed: the injected runSession stands in for P7. */
const ENTRY = { file: path.join(path.sep, 'fake', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), kind: 'js' }

/** The two arms of a normal sweep. */
const ARMS = [
  { side: 'base', label: 'bench-base', profile: 'bench-base' },
  { side: 'cand', label: 'bench-ops', profile: 'bench-ops' },
]

/** One in-memory task, shaped like `bench/lib/tasks.mjs` returns. */
function task(id, repeat = 1) {
  return {
    id,
    title: id,
    prompt: `do ${id}`,
    fixture: { generator: 'largeCsv' },
    verify: [{ type: 'fileExists', path: 'answer.txt' }],
    repeat,
    timeoutMs: 1_000,
  }
}

/** A synthetic P7 row: the fields the scheduler, aggregate and compare-core read. */
function rowFor({ task: theTask, repeatIndex, arm }, tokens, pass = true) {
  return {
    taskId: theTask.id,
    repeatIndex,
    arm,
    profile: arm,
    startedAt: '2026-10-18T00:00:00.000Z',
    durationMs: 5,
    exit: 0,
    timedOut: false,
    steps: 1,
    toolCalls: 0,
    usage: { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, grandTotal: tokens },
    usageReported: true,
    toolCallsByName: {},
    turnEndReason: 'completed',
    interrupted: false,
    spawnError: null,
    runnerError: null,
    timeoutMs: 1_000,
    verify: [{ type: 'fileExists', target: 'answer.txt', pass, detail: pass ? 'present' : 'missing' }],
    verifyPassed: pass,
    verifyError: pass ? null : 'missing',
    eventsFile: null,
    stderrFile: null,
    traceFile: null,
    traceRows: 0,
    workspace: null,
    archiveErrors: [],
  }
}

/**
 * A scripted stand-in for P7 that records the call order and the concurrency.
 * @param {object} [script] - what each call returns or does.
 * @returns {{calls: object[], runSession: Function, active: () => number, maxActive: () => number}} the rig.
 */
function rig({ tokens = () => 100, pass = () => true, fail = null, onCall = null } = {}) {
  const calls = []
  let running = 0
  let high = 0
  const runSession = async (spec, options) => {
    running += 1
    high = Math.max(high, running)
    const index = calls.length
    calls.push({ taskId: spec.task.id, repeatIndex: spec.repeatIndex, arm: spec.arm, profile: options.profile, outDir: options.outDir })
    await tick()
    running -= 1
    if (onCall) await onCall({ spec, options, index, calls })
    if (fail && fail(spec, index)) throw new Error(`scripted runner failure in ${spec.arm}`)
    return rowFor(spec, tokens(spec, index), pass(spec, index))
  }
  return { calls, runSession, active: () => running, maxActive: () => high }
}

/** The base spec of a sweep rooted in one temporary directory. */
function specFor(root, overrides = {}) {
  return {
    arms: ARMS.map((arm) => ({ ...arm, profileHash: `${arm.side}-hash` })),
    tasks: [task('csv-sum', 2)],
    repeats: { 'csv-sum': 2 },
    dirs: { base: path.join(root, 'base'), cand: path.join(root, 'cand') },
    entry: ENTRY,
    ...overrides,
  }
}

/** The call order as `task:rN:arm` strings. */
const order = (calls) => calls.map((call) => `${call.taskId}:r${call.repeatIndex}:${call.arm}`)

/** A captured `out`/`err` pair plus its text accessor. */
function sink() {
  const lines = { out: [], err: [] }
  return {
    out: (line) => lines.out.push(line),
    err: (line) => lines.err.push(line),
    text: (which = 'out') => lines[which].join('\n'),
    both: () => [...lines.out, ...lines.err].join('\n'),
    lines,
  }
}

/** A temp tasks directory holding one valid task file, for the `main` checks. */
function tasksDir(root, repeat = 2) {
  const dir = path.join(root, 'tasks')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'csv-sum.task.json'), JSON.stringify(task('csv-sum', repeat)))
  return dir
}

await test('armOrder flips with the parity of the repeat, and rejects a repeat of zero', () => {
  assert.deepEqual(armOrder(1, ARMS).map((arm) => arm.side), ['base', 'cand'])
  assert.deepEqual(armOrder(2, ARMS).map((arm) => arm.side), ['cand', 'base'])
  assert.deepEqual(armOrder(3, ARMS).map((arm) => arm.side), ['base', 'cand'])
  assert.deepEqual(ARMS.map((arm) => arm.side), ['base', 'cand'], 'the input order is never mutated')
  assert.throws(() => armOrder(0, ARMS), /positive integer/)
  assert.throws(() => armOrder(1.5, ARMS), /positive integer/)

  const sides = planSessions({ tasks: [task('csv-sum', 2)], repeats: { 'csv-sum': 2 }, arms: ARMS }).map((step) => step.side)
  assert.deepEqual(sides, ['base', 'cand', 'cand', 'base'], 'odd repeats base→cand, even repeats cand→base')
  assert.equal(planPairs({ tasks: [task('csv-sum', 2)], repeats: { 'csv-sum': 2 } }).length, 2)
  assert.deepEqual(repeatsById([task('a', 4), task('b')], { repeat: 9, repeatExplicit: true }), { a: 9, b: 9 })
  assert.deepEqual(repeatsById([task('a', 4), { ...task('b'), repeat: undefined }], { repeat: 3 }), { a: 4, b: 3 }, 'a task keeps its own budget, the rest take the default')
})

await test('runSweep interleaves per (task, repeat): odd base→cand, even cand→base', async () => {
  await withTempDir('bench-schedule-order', async (root) => {
    const scripted = rig()
    const result = await runSweep(specFor(root, { tasks: [task('alpha', 2), task('beta', 2)], repeats: { alpha: 2, beta: 2 } }), {
      runSession: scripted.runSession,
      log: () => {},
      seal: () => ({ path: 'run.json' }),
    })
    assert.deepEqual(order(scripted.calls), [
      'alpha:r1:bench-base', 'alpha:r1:bench-ops',
      'alpha:r2:bench-ops', 'alpha:r2:bench-base',
      'beta:r1:bench-base', 'beta:r1:bench-ops',
      'beta:r2:bench-ops', 'beta:r2:bench-base',
    ])
    assert.equal(scripted.calls.length, 8, 'every pair ran both arms exactly once')
    assert.equal(result.completedSessions, 8)
    assert.equal(result.plannedSessions, 8)
    assert.equal(result.summaries.base.results.length, 4)
    assert.equal(result.summaries.cand.results.length, 4)
    assert.equal(result.pairing.complete, true)
  })
})

await test('runs are strictly serial: one session in flight, never two', async () => {
  await withTempDir('bench-schedule-serial', async (root) => {
    const scripted = rig()
    const tasks = [task('a', 3), task('b', 3)]
    const result = await runSweep(specFor(root, { tasks, repeats: { a: 3, b: 3 } }), {
      runSession: scripted.runSession,
      log: () => {},
    })
    assert.equal(scripted.maxActive(), 1, 'the scheduler awaited each session before starting the next')
    assert.equal(scripted.active(), 0)
    assert.equal(scripted.calls.length, 12)
    assert.equal(result.plannedSessions, 12)
    assert.equal(result.sealed, null, 'no seal callback was injected')
    assert.equal(result.sealError, null, 'a missing seal callback is not a failure, it is a warning')
  })
})

await test('A/A mode runs the baseline twice and measures the noise floor with compare-core', async () => {
  await withTempDir('bench-schedule-aa', async (root) => {
    const scripted = rig({ tokens: (spec) => (spec.arm === 'bench-base-aa' && spec.repeatIndex === 1 ? 120 : 100) })
    const arms = [
      { side: 'base', label: 'bench-base', profile: 'bench-base' },
      { side: 'cand', label: 'bench-base-aa', profile: 'bench-base' },
    ]
    const result = await runSweep(specFor(root, { arms, aa: true }), {
      runSession: scripted.runSession,
      log: () => {},
      seal: () => ({ path: 'run.json' }),
    })
    assert.equal(result.aa, true)
    assert.deepEqual([...new Set(scripted.calls.map((call) => call.profile))], ['bench-base'], 'both sides ran the baseline profile')
    assert.deepEqual(order(scripted.calls), [
      'csv-sum:r1:bench-base', 'csv-sum:r1:bench-base-aa',
      'csv-sum:r2:bench-base-aa', 'csv-sum:r2:bench-base',
    ], 'the interleaving still flips under A/A')
    assert.equal(result.noise.format, 'dsh-ops-bench-noise-v1')
    assert.equal(result.noise.method, 'aa-max-abs-task-pct')
    assert.equal(result.noise.pct, 10, 'median base 100 vs median cand 110 is +10%')
    assert.equal(result.noise.pairs, 2)
    assert.equal(result.summaries.base.noise.pct, 10, 'the measured floor is written into the summary output')
    assert.equal(result.summaries.cand.noise.pct, 10)
    assert.equal(result.compare.noiseFloor.pct, 10)
    assert.equal(result.compare.totals.grandTotalPct, 10)
    assert.equal(result.compare.verdict.cost.withinNoise, true, 'a delta inside the A/A band is not a direction')
    assert.equal(result.compare.verdict.cost.readable, false)
  })
})

await test('without A/A there is no noise floor, so no cost direction is read', async () => {
  await withTempDir('bench-schedule-nonoise', async (root) => {
    const scripted = rig({ tokens: (spec) => (spec.arm === 'bench-ops' ? 50 : 100) })
    const result = await runSweep(specFor(root), { runSession: scripted.runSession, log: () => {}, seal: () => ({}) })
    assert.equal(result.noise, null)
    assert.equal(result.compare.noiseFloor.method, 'none')
    assert.equal(result.compare.totals.grandTotalPct, -50)
    assert.equal(result.compare.verdict.cost.readable, false)
    assert.ok(result.compare.gate.reasons.some((reason) => reason.includes('no A/A noise floor')), JSON.stringify(result.compare.gate.reasons))
    assert.equal(result.compare.gate.fail, false, 'a withheld direction is not a regression')
  })
})

await test('the seal callback is injected, called once, and handed the complete sweep', async () => {
  await withTempDir('bench-schedule-seal', async (root) => {
    const scripted = rig()
    const seen = []
    const result = await runSweep(specFor(root), {
      runSession: scripted.runSession,
      log: () => {},
      seal: (context) => {
        seen.push(context)
        return { path: path.join(root, 'run.json'), changed: true }
      },
    })
    assert.equal(seen.length, 1, 'sealing happens once, after the sweep')
    const context = seen[0]
    assert.equal(context.arms.base.label, 'bench-base')
    assert.equal(context.arms.base.profileHash, 'base-hash')
    assert.equal(context.arms.cand.label, 'bench-ops')
    assert.equal(context.arms.cand.profileHash, 'cand-hash')
    assert.deepEqual(context.dirs, { base: path.join(root, 'base'), cand: path.join(root, 'cand') })
    assert.equal(context.plannedSessions, 4)
    assert.equal(context.completedSessions, 4)
    assert.equal(context.interrupted, false)
    assert.deepEqual(context.failures, [])
    assert.equal(context.summaries.base.results.length, 2)
    assert.equal(context.summaries.cand.results.length, 2)
    assert.equal(context.compare.format, 'dsh-ops-bench-compare-v1')
    assert.equal(context.pairing.complete, true)
    assert.equal(context.meta.mode, 'ab')
    assert.equal(result.sealed.path, path.join(root, 'run.json'), 'the receipt is exposed on the result')

    for (const [side, arm] of [['base', 'bench-base'], ['cand', 'bench-ops']]) {
      const file = path.join(context.dirs[side], 'summary.json')
      const summary = JSON.parse(fs.readFileSync(file, 'utf8'))
      assert.equal(summary.format, SUMMARY_FORMAT)
      assert.equal(summary.label, arm)
      assert.equal(summary.results.length, 2)
      assert.equal(summary.completedSessions, 2)
      assert.equal(summary.interrupted, false)
    }
  })
})

await test('a seal that throws is recorded as a failure, never as a sealed sweep', async () => {
  await withTempDir('bench-schedule-sealfail', async (root) => {
    const scripted = rig()
    const result = await runSweep(specFor(root), {
      runSession: scripted.runSession,
      log: () => {},
      seal: () => { throw new Error('run.json is not schema-shaped') },
    })
    assert.equal(result.sealed, null)
    assert.equal(result.sealError, 'run.json is not schema-shaped')
    assert.deepEqual(result.failures.map((failure) => failure.kind), ['seal'])
    assert.equal(exitFor(result), EXIT.failure)
    assert.ok(fs.existsSync(path.join(result.dirs.base, 'summary.json')), 'the per-arm summaries survive a seal failure')
  })
})

await test('a runner that throws becomes a failed row: recorded, excluded from pairing, exit 1', async () => {
  await withTempDir('bench-schedule-failure', async (root) => {
    const scripted = rig({ fail: (spec) => spec.arm === 'bench-ops' })
    const result = await runSweep(specFor(root, { tasks: [task('csv-sum', 1)], repeats: { 'csv-sum': 1 } }), {
      runSession: scripted.runSession,
      log: () => {},
      seal: () => ({}),
    })
    assert.equal(scripted.calls.length, 2, 'the other arm still ran: one broken session does not abort the sweep')
    const [failed] = result.summaries.cand.results
    assert.equal(failed.verifyPassed, false)
    assert.match(failed.runnerError, /scripted runner failure/)
    assert.deepEqual(failed.verify, [{ type: 'runner', target: null, pass: false, detail: failed.runnerError.slice(0, 200) }])
    assert.equal(result.summaries.base.results[0].verifyPassed, true)
    assert.deepEqual(result.failures.map((failure) => failure.kind), ['threw'])
    assert.equal(result.failures[0].arm, 'bench-ops')
    assert.equal(result.pairing.counts.pairs, 1)
    assert.equal(result.compare.pairing.usablePairs, 0, 'a pair with a failed side cannot support a cost conclusion')
    assert.equal(result.compare.gate.passDropFailed, true, 'base passed, cand did not: a pass-drop outranks any token win')
    assert.equal(exitFor(result), EXIT.failure)
  })
})

await test('interrupt stops the plan, keeps what ran, and is never reported as success', async () => {
  await withTempDir('bench-schedule-interrupt', async (root) => {
    const interrupt = { stopped: false, child: null, pid: null }
    const scripted = rig({ onCall: () => { interrupt.stopped = true } })
    const result = await runSweep(specFor(root, { tasks: [task('csv-sum', 2)], repeats: { 'csv-sum': 2 } }), {
      runSession: scripted.runSession,
      log: () => {},
      interrupt,
      seal: () => ({}),
    })
    assert.equal(result.interrupted, true)
    assert.equal(result.completedSessions, 1)
    assert.equal(result.plannedSessions, 4)
    assert.equal(scripted.calls.length, 1, 'nothing was started after the stop')
    assert.equal(result.summaries.base.results.length, 1, 'only the run that finished is recorded')
    assert.equal(result.summaries.cand.results.length, 0)
    assert.equal(result.summaries.base.interrupted, true)
    assert.equal(exitFor(result), EXIT.failure)
  })
})

await test('--sleep-ms pauses between pairs, using the injected sleep, and not after the last', async () => {
  await withTempDir('bench-schedule-sleep', async (root) => {
    const scripted = rig()
    const slept = []
    const result = await runSweep(specFor(root, { tasks: [task('a', 2), task('b', 2)], repeats: { a: 2, b: 2 } }), {
      runSession: scripted.runSession,
      log: () => {},
      sleep: async (ms) => { slept.push(ms) },
      sleepMs: 25,
      seal: () => ({}),
    })
    assert.deepEqual(slept, [25, 25, 25], 'three pauses between the four pairs, none after the last')
    assert.equal(result.pairs, 4)
  })
})

await test('parseRunArgs reads the runner flags, keeps the CLI validation, and rejects the per-arm form', () => {
  const parsed = parseRunArgs(['--task', 'a', '--repeat', '2', '--base', 'x', '--cand', 'y', '--aa', '--verbose', '--keep', '--sleep-ms', '5', '--out', 'tmp-dir', '--heartbeat-ms', '0'], { runsDir: path.join('/tmp', 'nonexistent-runs') })
  assert.equal(parsed.aa, true)
  assert.equal(parsed.verbose, true)
  assert.equal(parsed.keep, true)
  assert.equal(parsed.sleepMs, 5)
  assert.equal(parsed.heartbeatMs, 0)
  assert.equal(parsed.repeat, 2)
  assert.equal(parsed.repeatExplicit, true)
  assert.deepEqual(parsed.tasks, ['a'])
  assert.equal(parsed.base, 'x')
  assert.equal(parsed.cand, 'y')

  assert.throws(() => parseRunArgs(['--label', 'bench-base'], { runsDir: '/tmp' }), /use --base\/--cand/)
  assert.throws(() => parseRunArgs(['--bogus'], { runsDir: '/tmp' }), /unknown option for ab/)
  assert.throws(() => parseRunArgs(['stray'], { runsDir: '/tmp' }), /unexpected argument/)
  assert.throws(() => parseRunArgs(['--sleep-ms', '-1'], { runsDir: '/tmp' }), /non-negative integer/)
  assert.throws(() => parseRunArgs(['--sleep-ms'], { runsDir: '/tmp' }), /needs a value/)
  assert.throws(() => parseRunArgs(['--repeat', '0'], { runsDir: '/tmp' }), /positive integer/)
  assert.throws(() => parseRunArgs(['--out', 'x', '--folder', 'g'], { runsDir: '/tmp' }), /drop --folder/)

  const plain = parseRunArgs([], { runsDir: '/tmp' })
  assert.equal(plain.repeat, 3)
  assert.equal(plain.repeatExplicit, false)
  assert.equal(plain.aa, false)
  assert.deepEqual(buildArms(plain).map((arm) => arm.label), ['bench-base', 'bench-ops'])
  assert.deepEqual(buildArms({ ...plain, aa: true }).map((arm) => arm.label), ['bench-base', 'bench-base-aa'])
  assert.equal(buildArms({ ...plain, aa: true })[1].profile, 'bench-base', 'A/A reruns the baseline profile, under a second label')

  const dirs = prepareDirs({ out: null, folder: 'benchmark-test-07' }, buildArms(plain), { runsDir: path.join('/tmp', 'runs'), now: NOW })
  assert.equal(dirs.sweepDir, path.join('/tmp', 'runs', 'benchmark-test-07'))
  assert.equal(dirs.dirs.base, path.join('/tmp', 'runs', 'benchmark-test-07', '2026-10-18T03-04-05Z-bench-base'))
  assert.equal(dirs.dirs.cand, path.join('/tmp', 'runs', 'benchmark-test-07', '2026-10-18T03-04-05Z-bench-ops'))
})

await test('main: --show prints the flip without running; a missing seal refuses before any spawn', async () => {
  await withTempDir('bench-main-flags', async (root) => {
    const tasks = tasksDir(root)
    const runsDir = path.join(root, 'runs')
    const scripted = rig()
    const base = { tasksDir: tasks, runsDir, runSession: scripted.runSession, installSignals: false, now: NOW }

    const out = sink()
    assert.equal(await main(['--show'], { ...base, ...out }), EXIT.ok)
    assert.equal(scripted.calls.length, 0, '--show never spawns')
    assert.equal(out.lines.out.filter((line) => line.includes('base → cand') || line.includes('bench-base → bench-ops')).length, 1)
    assert.equal(out.lines.out.filter((line) => line.includes('bench-ops → bench-base')).length, 1)
    assert.match(out.text(), /benchmark-test-01/)
    assert.match(out.text(), /show only/)

    const noSeal = sink()
    assert.equal(await main([], { ...base, ...noSeal, seal: undefined }), EXIT.pending)
    assert.match(noSeal.both(), /sealing is not wired in this slice yet/)
    assert.match(noSeal.both(), /P8a/)
    assert.equal(scripted.calls.length, 0, 'an unsealable sweep spends no token')

    const badFlag = sink()
    assert.equal(await main(['--bogus'], { ...base, ...badFlag, seal: () => ({}) }), EXIT.usage)
    assert.match(badFlag.both(), /unknown option for ab/)

    const perArm = sink()
    assert.equal(await main(['--label', 'bench-base'], { ...base, ...perArm, seal: () => ({}) }), EXIT.usage)
    assert.match(perArm.both(), /use --base\/--cand/)
  })
})

await test('main: a sealed A/A sweep exits 0 with the measured floor; a broken one exits 1', async () => {
  await withTempDir('bench-main-run', async (root) => {
    const tasks = tasksDir(root, 2)
    const runsDir = path.join(root, 'runs')
    const aaOut = sink()
    const scripted = rig({ tokens: (spec) => (spec.arm === 'bench-base-aa' && spec.repeatIndex === 1 ? 120 : 100) })
    const code = await main(['--aa', '--repeat', '2'], {
      ...aaOut,
      tasksDir: tasks,
      runsDir,
      runSession: scripted.runSession,
      installSignals: false,
      now: NOW,
      seal: (context) => ({ path: path.join(context.dirs.base, '..', 'run.json') }),
    })
    assert.equal(code, EXIT.ok)
    assert.match(aaOut.text(), /A\/A ±10%/)
    assert.match(aaOut.text(), /verdict : pass/)
    assert.match(aaOut.text(), /sealed  : .*run\.json/)

    const brokenOut = sink()
    const broken = rig({ fail: (spec) => spec.arm === 'bench-ops' })
    const brokenCode = await main([], {
      ...brokenOut,
      tasksDir: tasks,
      runsDir,
      runSession: broken.runSession,
      installSignals: false,
      now: NOW,
      seal: () => ({ path: 'run.json' }),
    })
    assert.equal(brokenCode, EXIT.failure)
    assert.match(brokenOut.text('err'), /pass-drop|failure/)
  })
})

await test('main: Ctrl-C during a session stops the sweep, reports it, and exits 1', async () => {
  await withTempDir('bench-main-interrupt', async (root) => {
    const tasks = tasksDir(root, 2)
    const interrupt = { stopped: false, child: null, pid: null }
    const out = sink()
    const scripted = rig({ onCall: () => { interrupt.stopped = true } })
    const code = await main(['--repeat', '2'], {
      ...out,
      tasksDir: tasks,
      runsDir: path.join(root, 'runs'),
      runSession: scripted.runSession,
      interrupt,
      installSignals: false,
      now: NOW,
      seal: () => ({}),
    })
    assert.equal(code, EXIT.failure)
    assert.match(out.text('err'), /interrupted/)
    assert.equal(scripted.calls.length, 1)
  })
})

await test('main --no-seal runs anyway and says out loud that no run.json was written', async () => {
  await withTempDir('bench-main-noseal', async (root) => {
    const out = sink()
    const scripted = rig()
    const code = await main(['--no-seal', '--repeat', '1'], {
      ...out,
      tasksDir: tasksDir(root, 1),
      runsDir: path.join(root, 'runs'),
      runSession: scripted.runSession,
      installSignals: false,
      now: NOW,
    })
    assert.equal(code, EXIT.ok)
    assert.match(out.text(), /no — run\.json was not written/)
    assert.equal(scripted.calls.length, 2, 'both arms still ran')
  })
})

report(LABEL)
