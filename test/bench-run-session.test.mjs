/**
 * The single-row driver gate (P7): fixture → one headless session → archive → verdict.
 *
 * Nothing here spawns a real child, talks to a model, or reads the developer's
 * `~/.dsh`: `runSession` takes its `spawn` and `kill` as injected functions, so every
 * check runs against a fake child built from an `EventEmitter` and two `PassThrough`s.
 * What the fake child would have done to its workspace is scripted, and the assertions
 * read the archives the driver left on disk — the files a sealed `run.json` consumes.
 *
 * @module dsh-ops/test/bench-run-session
 */

import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { assertSpawnableEntry, runSession, sessionPaths, toVerifyChecks } from '../bench/run/session.mjs'

const LABEL = 'bench-run-session'

/** A launcher that is never executed: the injected spawn stands in for node. */
const ENTRY = { file: path.join(path.sep, 'fake', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), kind: 'js' }

/** A tiny seeded fixture (2 files), so each row costs kilobytes rather than megabytes. */
const TASK = {
  id: 'grep-tree',
  title: 'find the needle',
  prompt: 'Find NEEDLE_X7Q under src/ and write its path to answer.txt',
  fixture: { generator: 'grepTree', params: { dirs: 1, filesPerDir: 2, linesPerFile: 3, needleFiles: 1 } },
  verify: [],
}

/** The fixture file every seeded run writes first, by construction of `grepTree`. */
const FIRST_FIXTURE_FILE = 'src/dir00/file000.js'

/**
 * A scriptable stand-in for a spawned child.
 * @returns {object} the fake child with stream handles, a `ready` barrier and `finish`.
 */
function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = 4242
  let release
  child.ready = new Promise((resolve) => {
    release = resolve
  })
  /** Push the scripted stdout/stderr, then either close or stay alive for an interrupt test. */
  child.emitFrom = ({ events = [], stderr = '', exit = 0, close = true } = {}) => {
    for (const event of events) child.stdout.write(`${JSON.stringify(event)}\n`)
    if (stderr !== '') child.stderr.write(stderr)
    release()
    if (close) child.finish(exit)
  }
  child.finish = (code) => {
    child.stdout.end()
    child.stderr.end()
    child.emit('close', code)
  }
  return child
}

/**
 * An injected spawn that records its arguments and runs a script on the next turn of
 * the event loop (after `runSession` has attached its listeners).
 * @param {(child: object, options: object) => void} [script] - what the fake child does.
 * @returns {{calls: object[], spawn: Function}} the recorded calls and the spawn function.
 */
function spawnRig(script) {
  const calls = []
  const spawn = (command, args, options) => {
    const child = fakeChild()
    calls.push({ command, args, options, child })
    setImmediate(() => script?.(child, options))
    return child
  }
  return { calls, spawn }
}

/** The option block most checks need, rooted in one temporary directory. */
const optionsFor = (root, overrides) => ({
  outDir: path.join(root, 'run'),
  entry: ENTRY,
  profile: 'bench-test',
  workspaceRoot: root,
  ...overrides,
})

/** Read a JSON document. */
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

/** Read a file as non-empty lines. */
const readLines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '')

/** The row's archive paths. */
const pathsAt = (root, repeatIndex = 1) => sessionPaths(path.join(root, 'run'), TASK.id, repeatIndex)

await test('spawn discipline: node + lib/bin.js, fixture cwd, schema-shaped verdict, cleanup', async () => {
  for (const file of ['dsh.cmd', 'dsh.bat', 'dsh.ps1']) {
    assert.throws(() => assertSpawnableEntry({ file, kind: 'exe' }), /refusing to spawn the shell shim/)
  }
  assert.throws(() => assertSpawnableEntry({ file: 'dsh', kind: 'shell' }), /kind/)
  assert.deepEqual(assertSpawnableEntry(ENTRY), ENTRY)
  assert.deepEqual(
    toVerifyChecks({ passed: false, checks: [{ type: 'fileExists', path: 'a.txt', passed: false, detail: 'file not found' }] }),
    [{ type: 'fileExists', target: 'a.txt', pass: false, detail: 'file not found' }],
  )
  assert.deepEqual(toVerifyChecks(null), [])

  await withTempDir('bench-session-spawn', async (root) => {
    let atSpawn = null
    const rig = spawnRig((child, options) => {
      atSpawn = { cwd: options.cwd, fixture: fs.existsSync(path.join(options.cwd, FIRST_FIXTURE_FILE)) }
      child.emitFrom({ events: [{ type: 'session', sessionId: 's-1', cwd: options.cwd }], exit: 0 })
    })
    const task = { ...TASK, verify: [{ type: 'fileExists', path: FIRST_FIXTURE_FILE }] }
    const row = await runSession({ task, repeatIndex: 1 }, optionsFor(root, { spawn: rig.spawn }))

    assert.equal(rig.calls.length, 1, 'exactly one child per row')
    const [call] = rig.calls
    assert.equal(call.command, process.execPath, 'a JS entry is always spawned as node, never through a shim')
    assert.ok(Array.isArray(call.args), 'arguments stay an array (no shell string)')
    assert.equal(call.args[0], ENTRY.file, 'argv[0] of the node child is the resolved lib/bin.js')
    assert.deepEqual(call.args.slice(1, 3), ['--profile', 'bench-test'])
    assert.equal(call.args[call.args.length - 2], '--json')
    assert.equal(call.args[call.args.length - 1], TASK.prompt)
    assert.equal(call.options.shell, undefined, 'shell is never enabled')
    assert.equal(call.options.env, process.env, 'the child environment is injectable and passed through')
    assert.ok(atSpawn.fixture, 'the fixture is on disk before the child starts')
    assert.equal(path.dirname(atSpawn.cwd), root, 'the workspace lives under the injected workspace root')
    assert.equal(row.workspace, atSpawn.cwd)

    assert.deepEqual(row.verify, [{ type: 'fileExists', target: FIRST_FIXTURE_FILE, pass: true, detail: 'present' }])
    assert.equal(row.verifyPassed, true)
    assert.equal(row.exit, 0)
    assert.equal(row.timedOut, false)
    assert.equal(row.interrupted, false)
    assert.ok(!fs.existsSync(row.workspace), 'the workspace is removed once the verifier has read it')
    assert.ok(!fs.readdirSync(root).some((name) => name.startsWith('dsh-ops-bench-')), 'no workspace debris is left behind')

    const metrics = readJson(pathsAt(root).metrics)
    assert.deepEqual(metrics.verify, row.verify, 'the metrics document carries the same verdict')
    assert.equal(metrics.eventsFile, `results/${TASK.id}-r1.events.ndjson`)
  })
})

await test('seeded fixtures: two repeats are byte-identical but never share a workspace', async () => {
  await withTempDir('bench-session-seed', async (root) => {
    const contents = []
    const workspaces = []
    const rig = spawnRig((child, options) => {
      contents.push(fs.readFileSync(path.join(options.cwd, FIRST_FIXTURE_FILE), 'utf8'))
      workspaces.push(options.cwd)
      child.emitFrom({ exit: 0 })
    })
    const options = optionsFor(root, { spawn: rig.spawn, keep: true })
    const first = await runSession({ task: TASK, repeatIndex: 1 }, options)
    const second = await runSession({ task: TASK, repeatIndex: 2 }, options)

    assert.notEqual(workspaces[0], workspaces[1], 'each repeat gets a fresh workspace')
    assert.equal(contents[0], contents[1], 'the same seed produces the same fixture bytes')
    assert.ok(fs.existsSync(first.workspace) && fs.existsSync(second.workspace), 'keep leaves the workspace for inspection')
    fs.rmSync(first.workspace, { recursive: true, force: true })
    fs.rmSync(second.workspace, { recursive: true, force: true })
  })
})

await test('archive + metrics + trace: NDJSON appended verbatim, usage folded, trace rows consistent', async () => {
  await withTempDir('bench-session-archive', async (root) => {
    const events = [
      { type: 'session', sessionId: 's-2', cwd: '/tmp/whatever' },
      { type: 'status', phase: 'turn_start', turn: 1 },
      { type: 'status', phase: 'step_start', step: 1, turn: 1 },
      { type: 'status', phase: 'step_end', step: 1, turn: 1, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 } },
      { type: 'tool_call', tool: 'read', input: { path: 'src' } },
      { type: 'tool_result', status: 'ok', result: 'ok' },
      { type: 'status', phase: 'step_end', step: 2, turn: 1 },
      { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } },
      { type: 'final', text: 'done' },
    ]
    const rig = spawnRig((child) => child.emitFrom({ events, stderr: 'a warning from dsh\n', exit: 0 }))
    const row = await runSession(
      { task: { ...TASK, verify: [{ type: 'fileExists', path: 'answer.txt' }] }, repeatIndex: 1 },
      optionsFor(root, { spawn: rig.spawn }),
    )
    const paths = pathsAt(root)

    const archived = readLines(paths.events)
    assert.equal(archived.length, events.length, 'one NDJSON line per event, no wrapping array')
    assert.deepEqual(archived.map((line) => JSON.parse(line)), events, 'the archived lines are the raw events, verbatim')
    assert.equal(row.eventsFile, 'results/grep-tree-r1.events.ndjson')
    const stderr = fs.readFileSync(paths.stderr, 'utf8')
    assert.ok(stderr.includes('a warning from dsh'), 'the child stderr is archived byte for byte')
    assert.ok(stderr.includes('runner: exit=0'), 'and the runner appends the honest outcome footer')

    assert.equal(row.steps, 2)
    assert.equal(row.toolCalls, 1)
    assert.deepEqual(row.toolCallsByName, { read: 1 })
    assert.deepEqual(row.usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1, reasoningTokens: 0 })
    assert.equal(row.usageReported, false, 'one step without usage degrades the whole row instead of understating it')
    assert.equal(row.turnEndReason, 'completed')
    assert.equal(row.verifyPassed, false, 'the fake child wrote no answer, so the check fails')

    const trace = readLines(paths.trace).map((line) => JSON.parse(line))
    assert.equal(trace.length, row.traceRows, 'the trace file and the row agree on how many timeline rows there are')
    assert.deepEqual(trace.map((entry) => entry.seq), trace.map((_, index) => index + 1), 'trace rows are ordered')
    assert.ok(trace.some((entry) => entry.role === 'boot' && entry.kind === 'spawn'), 'the spawn is a boot trace row')
    assert.ok(trace.some((entry) => entry.kind === 'session'), 'the child booting is in the timeline')
    assert.ok(trace.some((entry) => entry.role === 'milestone' && entry.kind === 'step_end'), 'the first model answer is a milestone')
    assert.ok(trace.some((entry) => entry.role === 'outcome' && entry.kind === 'exit_zero'), 'the outcome closes the trace')

    const metrics = readJson(paths.metrics)
    for (const key of ['startedAt', 'durationMs', 'exit', 'timedOut', 'steps', 'toolCalls', 'usage', 'usageReported']) {
      assert.ok(Object.hasOwn(metrics, key), `metrics.json has the schema field ${key}`)
    }
    assert.equal(metrics.traceRows, trace.length)
    assert.equal(metrics.stderrFile, 'results/grep-tree-r1.stderr.log')
    assert.equal(metrics.traceFile, 'results/grep-tree-r1.trace.ndjson')
  })
})

await test('timeout: timedOut true, exit null, and the kill is recorded in the archive', async () => {
  await withTempDir('bench-session-timeout', async (root) => {
    const killed = []
    const rig = spawnRig(() => {
      // Deliberately silent and never closing: only the deadline can end this row.
    })
    const row = await runSession(
      { task: { ...TASK, timeoutMs: 30, verify: [{ type: 'fileExists', path: 'answer.txt' }] }, repeatIndex: 1 },
      optionsFor(root, {
        spawn: rig.spawn,
        kill: (child) => {
          killed.push(child.pid)
          child.finish(null)
        },
      }),
    )

    assert.deepEqual(killed, [4242], 'the deadline calls the injected killer with the child')
    assert.equal(row.timedOut, true)
    assert.equal(row.exit, null, 'a timed-out row has no exit code to report')
    assert.equal(row.verifyPassed, false, 'a killed run cannot pass: nothing wrote the expected answer')
    const metrics = readJson(pathsAt(root).metrics)
    assert.equal(metrics.timedOut, true)
    assert.equal(metrics.exit, null)
    assert.ok(fs.readFileSync(pathsAt(root).stderr, 'utf8').includes('killed after 30 ms timeout'), 'the kill is in stderr, next to the evidence')
    assert.ok(row.durationMs >= 0)
  })
})

await test('a kill that never closes still ends the row: the archives are the fallback, not a hang', async () => {
  await withTempDir('bench-session-wedged', async (root) => {
    const lines = []
    const rig = spawnRig(() => {
      // Alive, silent, and it will ignore the kill.
    })
    const row = await runSession(
      { task: { ...TASK, timeoutMs: 20, verify: [{ type: 'fileExists', path: 'answer.txt' }] }, repeatIndex: 1 },
      optionsFor(root, {
        spawn: rig.spawn,
        kill: () => {},
        killGraceMs: 25,
        streamFlushGraceMs: 0,
        log: (level, text) => lines.push(`${level} ${text}`),
      }),
    )

    assert.equal(row.timedOut, true)
    assert.equal(row.exit, null)
    assert.ok(lines.some((line) => /did not report close after the kill/.test(line)), 'the swallowed kill is narrated, not hidden')
    assert.ok(fs.existsSync(pathsAt(root).metrics), 'the row is still written')
    assert.ok(!fs.existsSync(row.workspace), 'and the wedged run still cleans up its workspace')
  })
})

await test('a non-zero exit keeps its code, and a failing check stays a failure', async () => {
  await withTempDir('bench-session-failure', async (root) => {
    const rig = spawnRig((child) => child.emitFrom({
      events: [{ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'failed', message: 'model died' } }],
      exit: 3,
    }))
    const row = await runSession(
      { task: { ...TASK, verify: [{ type: 'fileEquals', path: 'answer.txt', text: 'the needle path' }] }, repeatIndex: 1 },
      optionsFor(root, { spawn: rig.spawn, streamFlushGraceMs: 0 }),
    )

    assert.equal(row.exit, 3, 'the child exit code is recorded as-is')
    assert.equal(row.timedOut, false)
    assert.equal(row.verifyPassed, false, 'a failed check is never turned into a pass by a clean archive')
    assert.equal(row.verify[0].pass, false)
    assert.ok(row.verify[0].detail.length > 0, 'and the verifier says what was expected')
    assert.equal(readJson(pathsAt(root).metrics).exit, 3)
    const trace = readLines(pathsAt(root).trace).map((line) => JSON.parse(line))
    assert.ok(trace.some((entry) => entry.kind === 'exit_nonzero'), 'the trace says the run exited non-zero')
    assert.ok(trace.some((entry) => entry.kind === 'turn_end_failed'), 'and that the turn itself failed')
  })
})

await test('interruption: the archives already written survive, and the row says interrupted', async () => {
  await withTempDir('bench-session-interrupt', async (root) => {
    const interrupt = { stopped: false, child: null, pid: null }
    const rig = spawnRig((child) => child.emitFrom({
      events: [
        { type: 'session', sessionId: 's-4', cwd: '/tmp/y' },
        { type: 'status', phase: 'step_start', step: 1, turn: 1 },
      ],
      close: false,
    }))
    const running = runSession({ task: TASK, repeatIndex: 1 }, optionsFor(root, { spawn: rig.spawn, interrupt }))
    const [call] = rig.calls
    assert.ok(call, 'the child was spawned before runSession awaited')
    assert.equal(interrupt.child, call.child, 'the interrupt latch points at the live child')
    await call.child.ready
    interrupt.stopped = true
    call.child.finish(null)
    const row = await running

    assert.equal(row.interrupted, true)
    assert.equal(row.exit, null, 'a killed child has no exit code')
    const paths = pathsAt(root)
    assert.equal(readLines(paths.events).length, 2, 'the events written before the interrupt are still there')
    assert.equal(readJson(paths.metrics).interrupted, true)
    assert.equal(readJson(paths.metrics).traceRows, readLines(paths.trace).length, 'the trace was flushed before the row was written')
  })
})

await test('a runner failure becomes a failed row (runnerError), not a missing row', async () => {
  await withTempDir('bench-session-runner-error', async (root) => {
    const rig = spawnRig()
    const row = await runSession(
      { task: { ...TASK, fixture: { generator: 'no-such-generator' } }, repeatIndex: 1 },
      optionsFor(root, { spawn: rig.spawn }),
    )
    assert.equal(rig.calls.length, 0, 'nothing is spawned when the fixture cannot be built')
    assert.equal(row.exit, null)
    assert.equal(row.steps, 0)
    assert.equal(row.verifyPassed, false)
    assert.match(row.runnerError, /unknown fixture generator/i)
    assert.equal(row.verify[0].type, 'runner')
    assert.equal(readJson(pathsAt(root).metrics).runnerError, row.runnerError)
    assert.ok(!fs.existsSync(row.workspace), 'the workspace created before the failure is cleaned up')
    assert.ok(!fs.readdirSync(root).some((name) => name.startsWith('dsh-ops-bench-')), 'no debris from the broken row')
  })
})

report(LABEL)
