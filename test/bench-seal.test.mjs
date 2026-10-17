/**
 * The seal gate (P8a): the `run.json` contract alignment and the merge that produces it.
 *
 * Nothing here spawns a child or talks to a model: a sweep directory is four small
 * archive files per row, written by hand, and `sealRun` folds them. Everything the
 * suite asserts is therefore about the contract and the merge — the event bodies and
 * their per-file hashes, the trace that is registered but never inlined, the archive
 * manifest, byte-for-byte idempotency, the self-check that must catch a typo, and the
 * old-shaped usage document (reasoning always present, no `grandTotal`) that the
 * contract now normalizes instead of refusing.
 *
 * @module dsh-ops/test/bench-seal
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { ROW_SUFFIXES, SealError, loadSchema, normalizeUsage, sealRun, validateRun } from '../bench/run/seal.mjs'
import { runSession } from '../bench/run/session.mjs'

const LABEL = 'bench-seal'
const NOW = Date.parse('2026-10-18T01:00:00.000Z')
const SEALED_AT = new Date(NOW).toISOString()

/** The two sides, with the fingerprints the contract requires. */
const ARMS = {
  base: { label: 'bench-base', profile: 'bench-base', profileHash: 'a'.repeat(64) },
  cand: { label: 'bench-ops', profile: 'bench-ops', profileHash: 'b'.repeat(64) },
}

/** A string that exists only in a non-milestone trace lane, so "not inlined" is provable. */
const TRACE_SENTINEL = 'trace-only-sentinel-4f6a'

/** One step with a tool call: the aggregate's step/tool attribution can be checked against it. */
const EVENTS = [
  { type: 'session', sessionId: 'sess-1', cwd: '/tmp/work' },
  { type: 'status', phase: 'turn_start', turn: 1 },
  { type: 'status', phase: 'step_start', turn: 1, step: 1 },
  { type: 'tool_call', tool: 'ops_read', input: { path: 'a.csv' } },
  { type: 'tool_result', status: 'ok', result: 'a,b' },
  { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 1 } },
  { type: 'final', text: 'answer 42' },
  { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } },
]

/** The core-bucket sum of {@link EVENTS}'s single step: what `grandTotal` must equal. */
const CORE_TOTAL = 19

/** The narrated trace: two milestone lanes (boot, milestone) and one raw lane. */
const TRACE = [
  { seq: 1, at: '2026-10-18T00:00:00.000Z', offsetMs: 0, role: 'boot', kind: 'spawn', level: 'info', text: 'spawn: node' },
  { seq: 2, at: '2026-10-18T00:00:00.500Z', offsetMs: 500, role: 'event', kind: 'raw', level: 'detail', text: `event #1 ${TRACE_SENTINEL}` },
  { seq: 3, at: '2026-10-18T00:00:01.000Z', offsetMs: 1000, role: 'milestone', kind: 'final', level: 'info', text: 'final answer received' },
]

/** SHA-256 in hex, for the assertions that recompute what the seal recorded. */
const sha256 = (text) => createHash('sha256').update(text).digest('hex')

/**
 * A scripted stand-in for a spawned child: the driver's injected `spawn` returns it,
 * so the whole row runs without a real process.
 * @param {object[]} events - the NDJSON events to push on stdout.
 * @param {{exit?: number}} [options] - the exit code to report.
 * @returns {Function} the injected spawn.
 */
function fakeSpawn(events, { exit = 0 } = {}) {
  return () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 4321
    setImmediate(() => {
      for (const event of events) child.stdout.write(`${JSON.stringify(event)}\n`)
      child.stdout.end()
      child.stderr.end()
      setImmediate(() => child.emit('close', exit))
    })
    return child
  }
}

/** The session-shaped metrics document a row would have written. */
function defaultMetrics(spec) {
  return {
    startedAt: spec.startedAt,
    durationMs: 2500,
    exit: 0,
    timedOut: false,
    steps: 1,
    toolCalls: 1,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 1, reasoningTokens: 0 },
    usageReported: true,
    toolCallsByName: { ops_read: 1 },
    turnEndReason: 'completed',
    taskId: spec.taskId,
    repeatIndex: spec.repeatIndex,
    arm: spec.arm,
    profile: spec.arm,
    interrupted: false,
    spawnError: null,
    timeoutMs: 60_000,
    verify: [{ type: 'fileEquals', target: 'answer.txt', pass: true, detail: 'matches expected content' }],
    verifyPassed: true,
    verifyError: null,
    traceRows: TRACE.length,
    milestones: 2,
    archiveErrors: [],
  }
}

/**
 * Write one row's archive files. `events: null` omits the event file (a runner that
 * failed before its stream opened), which is also how a row carries a pre-aggregate
 * usage document; omitting the key writes the standard {@link EVENTS} stream.
 * @param {string} dir - the sweep directory.
 * @param {object} spec - `{segment, taskId, repeatIndex, arm, startedAt, events, metrics}`.
 * @returns {{segment: string, eventsText: string|null, traceText: string, stderrText: string}} the written row.
 */
function writeRow(dir, spec) {
  const resultsDir = path.join(dir, 'results')
  fs.mkdirSync(resultsDir, { recursive: true })
  const events = spec.events === undefined ? EVENTS : spec.events
  const eventsText = events === null
    ? null
    : `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
  const traceText = `${TRACE.map((row) => JSON.stringify(row)).join('\n')}\n`
  const stderrText = 'bench: a warning on stderr\n'
  if (eventsText !== null) fs.writeFileSync(path.join(resultsDir, `${spec.segment}${ROW_SUFFIXES.events}`), eventsText)
  fs.writeFileSync(path.join(resultsDir, `${spec.segment}${ROW_SUFFIXES.trace}`), traceText)
  fs.writeFileSync(path.join(resultsDir, `${spec.segment}${ROW_SUFFIXES.stderr}`), stderrText)
  const metrics = { ...defaultMetrics(spec), ...(spec.metrics ?? {}) }
  fs.writeFileSync(path.join(resultsDir, `${spec.segment}${ROW_SUFFIXES.metrics}`), `${JSON.stringify(metrics, null, 2)}\n`)
  return { segment: spec.segment, eventsText, traceText, stderrText }
}

/** One standard two-row sweep, sealed; returns the receipt and the written files. */
async function sealedSweep(body) {
  return withTempDir('bench-seal', async (dir) => {
    const rows = [
      writeRow(dir, { segment: 'api-rename-r1', taskId: 'api-rename', repeatIndex: 1, arm: 'bench-ops', startedAt: '2026-10-18T00:00:05.000Z' }),
      writeRow(dir, { segment: 'csv-sum-r1', taskId: 'csv-sum', repeatIndex: 1, arm: 'bench-base', startedAt: '2026-10-18T00:00:00.000Z' }),
    ]
    const receipt = sealRun({ dir, arms: ARMS, now: () => NOW })
    return body({ dir, rows, receipt })
  })
}

await test('sealRun writes one schema-valid run.json and reports where it went', async () => {
  await sealedSweep(({ dir, receipt }) => {
    assert.equal(receipt.path, path.join(dir, 'run.json'))
    assert.equal(fs.existsSync(receipt.path), true)
    assert.equal(receipt.changed, true)
    const document = JSON.parse(fs.readFileSync(receipt.path, 'utf8'))
    assert.equal(document.schemaVersion, 1)
    assert.deepEqual(document.results.map((row) => row.taskId), ['api-rename', 'csv-sum'], 'rows are sealed in task order')
    assert.equal(document.results.length, 2)
    const validation = validateRun(document)
    assert.deepEqual(validation.errors, [], 'the sealed document matches bench/run.schema.json')
    assert.equal(validation.ok, true)
    assert.equal(document.meta.arms.base.label, 'bench-base')
    assert.equal(document.meta.arms.cand.profileHash, ARMS.cand.profileHash)
    assert.equal(document.verify.checks, 2)
    assert.equal(document.verify.passed, 2)
    assert.equal(document.verify.failed, 0)
    assert.equal(document.verify.degraded, false)
  })
})

await test('the merge inlines the event bodies, with the file hash and line count that prove it', async () => {
  await sealedSweep(({ receipt, rows }) => {
    const document = receipt.document
    assert.equal(document.events.layout, 'merged')
    assert.equal(document.events.merged, true)
    assert.equal(document.events.mergedAt, SEALED_AT)
    assert.equal(document.events.files.length, 2)
    for (const [index, row] of rows.entries()) {
      const sealed = document.results[index]
      assert.equal(sealed.events.format, 'inline')
      assert.equal(sealed.events.file, `results/${row.segment}${ROW_SUFFIXES.events}`)
      assert.equal(sealed.events.count, EVENTS.length, 'every event line is counted')
      assert.equal(sealed.events.malformed, 0)
      assert.equal(sealed.events.inline.length, EVENTS.length)
      assert.deepEqual(sealed.events.inline[0], EVENTS[0], 'the body is the parsed line, verbatim')
      assert.equal(sealed.events.sha256, sha256(row.eventsText))
      const file = document.events.files.find((entry) => entry.path === sealed.events.file)
      assert.ok(file, 'every inlined body has a manifest entry')
      assert.equal(file.events, EVENTS.length)
      assert.equal(file.sha256, sha256(row.eventsText))
    }
  })
})

await test('a line that is not a JSON object is counted as malformed and stays out of the body', async () => {
  await withTempDir('bench-seal', (dir) => {
    const text = `${EVENTS.map((event) => JSON.stringify(event)).join('\n')}\nnot json at all\n`
    fs.mkdirSync(path.join(dir, 'results'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'results', `csv-sum-r1${ROW_SUFFIXES.events}`), text)
    fs.writeFileSync(path.join(dir, 'results', `csv-sum-r1${ROW_SUFFIXES.trace}`), '')
    fs.writeFileSync(path.join(dir, 'results', `csv-sum-r1${ROW_SUFFIXES.metrics}`), `${JSON.stringify(defaultMetrics({ taskId: 'csv-sum', repeatIndex: 1, arm: 'bench-base', startedAt: '2026-10-18T00:00:00.000Z' }))}\n`)
    const receipt = sealRun({ dir, arms: ARMS, now: () => NOW })
    const sealed = receipt.document.results[0]
    assert.equal(sealed.events.count, EVENTS.length + 1)
    assert.equal(sealed.events.inline.length, EVENTS.length)
    assert.equal(sealed.events.malformed, 1)
    assert.equal(sealed.events.sha256, sha256(text), 'the hash covers the bytes, malformed line included')
  })
})

await test('the trace is registered in archive[] and summarized, never inlined', async () => {
  await sealedSweep(({ receipt }) => {
    const documentText = fs.readFileSync(receipt.path, 'utf8')
    assert.equal(documentText.includes(TRACE_SENTINEL), false, 'the trace body is not in the document')
    for (const row of receipt.document.results) {
      assert.equal(row.traceFile, `results/${row.taskId === 'csv-sum' ? 'csv-sum' : 'api-rename'}-r1${ROW_SUFFIXES.trace}`)
      assert.equal(row.metrics.traceRows, TRACE.length)
      assert.equal(row.metrics.milestones, 2, 'boot and milestone lanes are quoted; the raw lane is not')
      assert.equal(row.metrics.narration.truncated, false)
      assert.deepEqual(row.metrics.narration.excerpts.map((entry) => entry.role ?? entry.kind), ['spawn', 'final'])
      const entry = receipt.document.archive.find((file) => file.path === row.traceFile)
      assert.ok(entry, 'the trace file is in the manifest')
      assert.equal(entry.role, 'trace')
    }
    assert.deepEqual(receipt.document.results[1].metrics.narration.excerpts[0], {
      seq: 1, at: '2026-10-18T00:00:00.000Z', offsetMs: 0, kind: 'spawn', text: 'spawn: node',
    })
  })
})

await test('archive[] lists every row file with its bytes, hash and role — and not run.json itself', async () => {
  await sealedSweep(({ dir, receipt }) => {
    const onDisk = fs.readdirSync(path.join(dir, 'results')).sort()
    const listed = receipt.document.archive.map((entry) => path.basename(entry.path)).sort()
    assert.deepEqual(listed, onDisk, 'the manifest is the complete results/ listing')
    assert.equal(receipt.document.archive.some((entry) => entry.path === 'run.json'), false, 'run.json cannot hash itself')
    for (const entry of receipt.document.archive) {
      const file = path.join(dir, entry.path)
      assert.equal(entry.bytes, fs.statSync(file).size)
      assert.equal(entry.sha256, sha256(fs.readFileSync(file, 'utf8')))
      assert.match(entry.role, /^(events|stderr|trace|metrics)$/)
      assert.equal(entry.sha256.length, 64)
    }
    const roles = new Set(receipt.document.archive.map((entry) => entry.role))
    assert.deepEqual([...roles].sort(), ['events', 'metrics', 'stderr', 'trace'], 'each row file gets its own role')
  })
})

await test('sealing the same directory twice is byte-identical; only the merge time may move', async () => {
  await withTempDir('bench-seal', (dir) => {
    writeRow(dir, { segment: 'csv-sum-r1', taskId: 'csv-sum', repeatIndex: 1, arm: 'bench-base', startedAt: '2026-10-18T00:00:00.000Z' })
    const first = sealRun({ dir, arms: ARMS, now: () => NOW })
    const bytes = fs.readFileSync(first.path, 'utf8')
    const second = sealRun({ dir, arms: ARMS, now: () => NOW })
    assert.equal(second.changed, false, 'an unchanged document is not rewritten')
    assert.equal(fs.readFileSync(second.path, 'utf8'), bytes, 'same input, same clock, same bytes')
    const later = sealRun({ dir, arms: ARMS, now: () => NOW + 60_000 })
    assert.equal(later.changed, true)
    const mask = (text, at) => text.split(at).join('"<mergedAt>"')
    assert.equal(
      mask(bytes, SEALED_AT),
      mask(fs.readFileSync(later.path, 'utf8'), new Date(NOW + 60_000).toISOString()),
      'the merge time is the only field the clock reaches',
    )
    const masked = JSON.parse(fs.readFileSync(later.path, 'utf8'))
    assert.equal(masked.meta.startedAt, '2026-10-18T00:00:00.000Z', 'the sweep start comes from the rows')
    assert.equal(masked.meta.endedAt, '2026-10-18T00:00:02.500Z', 'the sweep end comes from the rows too')
  })
})

await test('the schema self-check names a missing field and an unexpected one', async () => {
  await sealedSweep(({ receipt }) => {
    const missing = JSON.parse(JSON.stringify(receipt.document))
    delete missing.meta.mode
    const missingErrors = validateRun(missing).errors
    assert.ok(missingErrors.some((error) => error.path === 'run.json.meta.mode' && /missing/.test(error.message)), JSON.stringify(missingErrors))

    const extra = JSON.parse(JSON.stringify(receipt.document))
    extra.meta.bogus = true
    extra.results[0].metrics.alsoBogus = 1
    const extraErrors = validateRun(extra).errors.map((error) => error.path)
    assert.ok(extraErrors.includes('run.json.meta.bogus'), JSON.stringify(extraErrors))
    assert.ok(extraErrors.includes('run.json.results[0].metrics.alsoBogus'), JSON.stringify(extraErrors))

    const noTotal = JSON.parse(JSON.stringify(receipt.document))
    delete noTotal.results[0].metrics.usage.grandTotal
    assert.ok(validateRun(noTotal).errors.some((error) => error.path === 'run.json.results[0].metrics.usage.grandTotal'), 'grandTotal is required')

    const noMetrics = JSON.parse(JSON.stringify(receipt.document))
    delete noMetrics.results[0].metrics
    assert.ok(validateRun(noMetrics).errors.some((error) => error.path === 'run.json.results[0].metrics'), 'results.items has a required list')
  })
})

await test('an old-shaped usage (reasoning always present, no grandTotal) is normalized, not refused', async () => {
  await withTempDir('bench-seal', (dir) => {
    writeRow(dir, {
      segment: 'csv-sum-r1',
      taskId: 'csv-sum',
      repeatIndex: 1,
      arm: 'bench-base',
      startedAt: '2026-10-18T00:00:00.000Z',
      events: null,
      metrics: {
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 1, reasoningTokens: 7 },
        steps: 1,
        toolCalls: 1,
      },
    })
    const receipt = sealRun({ dir, arms: ARMS, now: () => NOW })
    const usage = receipt.document.results[0].metrics.usage
    assert.equal(usage.grandTotal, CORE_TOTAL, 'the missing total is recomputed from the four core buckets')
    assert.equal(usage.reasoningTokens, 7, 'the reasoning count is evidence and is kept')
    assert.equal(receipt.document.results[0].metrics.usageBucketsSeen.includes('reasoningTokens'), true)
    assert.deepEqual(validateRun(receipt.document).errors, [], 'the normalized document is valid')
    assert.deepEqual(normalizeUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }), {
      inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, grandTotal: 10,
    })
  })
})

await test('the sealed metrics carry the P6 attribution slots, and they conserve the run', async () => {
  await sealedSweep(({ receipt }) => {
    for (const row of receipt.document.results) {
      const metrics = row.metrics
      assert.deepEqual(metrics.usageBucketsSeen, ['cacheReadTokens', 'cacheWriteTokens', 'inputTokens', 'outputTokens'])
      assert.equal(metrics.stepUsage.length, 1)
      assert.deepEqual(metrics.stepUsage[0].tools, ['ops_read'])
      assert.equal(metrics.stepUsage[0].promptTokens, 14)
      assert.equal(metrics.toolUsage.ops_read.calls, 1)
      assert.equal(metrics.toolUsage.ops_read.usage.grandTotal, CORE_TOTAL)
      assert.equal(metrics.unattributedUsage.grandTotal, 0)
      assert.deepEqual(metrics.attribution, { tools: CORE_TOTAL, unattributed: 0, balanced: true })
      assert.equal(metrics.prompt.total, 14)
      assert.equal(metrics.format, 'dsh-ops-bench-metrics-v1')
      assert.equal(metrics.usage.grandTotal, CORE_TOTAL)
    }
  })
})

await test('the contract gives every object a required list, and results[] one of its own', () => {
  const schema = loadSchema()
  const offenders = []
  const walk = (node, where) => {
    if (!node || typeof node !== 'object') return
    if (objectProperties(node) && !Array.isArray(node.required)) offenders.push(where)
    for (const [key, child] of Object.entries(node.properties ?? {})) walk(child, `${where}.${key}`)
    if (node.items) walk(node.items, `${where}[]`)
    for (const [key, child] of Object.entries(node.$defs ?? {})) walk(child, `$defs.${key}`)
    for (const [index, branch] of (node.anyOf ?? []).entries()) walk(branch, `${where}|anyOf[${index}]`)
  }
  walk(schema, 'run.json')
  assert.deepEqual(offenders, [], 'an object with properties declares what it requires')
  assert.deepEqual(
    schema.$defs.result.required,
    ['taskId', 'repeatIndex', 'arm', 'metrics', 'verify', 'events'],
    'results.items is not open-ended',
  )
  assert.deepEqual(schema.$defs.usage.required, ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'grandTotal'])
  assert.equal(Object.hasOwn(schema.$defs.usage.properties, 'reasoningTokens'), true, 'reasoning is reported, not required')
  assert.ok(schema.properties.archive.items.required.includes('sha256'), 'archive[] entries are hashed')
  assert.equal(schema.properties.events.properties.layout.enum.includes('merged'), true)
  assert.equal(schema.properties.archive.items.properties.role.enum.includes('trace'), true)
  assert.match(schema.$defs.check.properties.detail.description, /passing check keeps its evidence/i)
})

/** Does this node describe an object (so a `required` list applies)? */
function objectProperties(node) {
  return node && typeof node === 'object' && node.type === 'object' && node.properties !== undefined
}

await test('sealRun refuses a directory that is not a sweep output, and a row with no arm', async () => {
  await withTempDir('bench-seal', (dir) => {
    assert.throws(() => sealRun({ dir, arms: ARMS }), (error) => error instanceof SealError && /no results\/ directory/.test(error.message))
    fs.mkdirSync(path.join(dir, 'results'))
    assert.throws(() => sealRun({ dir, arms: ARMS }), (error) => error instanceof SealError && /nothing to seal/.test(error.message))
    fs.writeFileSync(path.join(dir, 'results', `csv-sum-r1${ROW_SUFFIXES.metrics}`), `${JSON.stringify({ ...defaultMetrics({ taskId: 'csv-sum', repeatIndex: 1, arm: 'bench-base', startedAt: '2026-10-18T00:00:00.000Z' }), arm: null })}\n`)
    assert.throws(() => sealRun({ dir, arms: ARMS }), (error) => error instanceof SealError && /metrics\.arm/.test(error.message))
    assert.throws(() => sealRun({ dir, arms: { base: ARMS.base } , now: () => NOW }), (error) => error instanceof TypeError && /arms\.cand/.test(error.message))
  })
})

await test('a row the P7 session driver really wrote seals without the contract rejecting it', async () => {
  await withTempDir('bench-seal', async (dir) => {
    const task = {
      id: 'grep-tree',
      title: 'find the needle',
      prompt: 'Find NEEDLE_X7Q under src/ and write its path to answer.txt',
      fixture: { generator: 'grepTree', params: { dirs: 1, filesPerDir: 2, linesPerFile: 3, needleFiles: 1 } },
      verify: [],
    }
    const row = await runSession({ task, repeatIndex: 1, arm: 'bench-base' }, {
      outDir: dir,
      entry: { file: path.join(path.sep, 'fake', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), kind: 'js' },
      profile: 'bench-base',
      spawn: fakeSpawn(EVENTS),
      now: () => NOW,
    })
    assert.equal(row.verifyPassed, true)
    assert.equal(row.runnerError, undefined, 'the driver completed without a runner error')
    const receipt = sealRun({ dir, arms: ARMS, now: () => NOW })
    assert.deepEqual(validateRun(receipt.document).errors, [], 'the real row shape fits the contract')
    const sealed = receipt.document.results[0]
    assert.equal(sealed.taskId, 'grep-tree')
    assert.equal(sealed.arm, 'bench-base')
    assert.equal(sealed.events.count, EVENTS.length)
    assert.equal(sealed.metrics.steps, 1)
    assert.equal(sealed.metrics.toolCalls, 1)
    assert.equal(sealed.metrics.usage.grandTotal, CORE_TOTAL)
    assert.equal(sealed.metrics.traceRows > 0, true, 'the trace the driver narrated is counted')
    assert.equal(receipt.document.archive.length, 4, 'all four files the driver wrote are in the manifest')
  })
})

await test('a runner-error row still seals, and degrades the run instead of vanishing', async () => {
  await withTempDir('bench-seal', async (dir) => {
    const row = await runSession({ task: { id: 'broken', prompt: 'x', fixture: { generator: 'doesNotExist', params: {} }, verify: [] }, repeatIndex: 1, arm: 'bench-base' }, {
      outDir: dir,
      entry: { file: path.join(path.sep, 'fake', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), kind: 'js' },
      profile: 'bench-base',
      now: () => NOW,
    })
    assert.match(row.runnerError, /unknown fixture generator/, 'the driver carried the failure in the row')
    const receipt = sealRun({ dir, arms: ARMS, now: () => NOW })
    assert.deepEqual(validateRun(receipt.document).errors, [])
    const sealed = receipt.document.results[0]
    assert.equal(sealed.runnerError, row.runnerError)
    assert.equal(sealed.metrics.usageReported, false)
    assert.equal(sealed.metrics.usage.grandTotal, 0)
    assert.equal(receipt.document.verify.degraded, true, 'a broken row makes the run degraded')
    assert.equal(receipt.document.verify.failed, 1)
    assert.equal(receipt.document.archive.length, 4, 'the empty archives are hashed, not dropped')
  })
})

report(LABEL)
