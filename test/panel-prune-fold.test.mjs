/** A host-pruned result must read as one row, and must be counted once. */
import { projectEvent } from '../lib/panel/events.js'
import { foldRecords, parseAppendLog } from '../lib/panel/fold.js'
import { assert, test, report } from './lib/harness.mjs'

const TIME = 1_700_000_000_000
const LONG = 'x'.repeat(9_000)
const PRUNED = 'x'.repeat(4_000) + '\n\n[... tool result middle pruned ...]\n\n' + 'x'.repeat(1_000)

const call = () => ({ type: 'tool/call', seq: 1, time: TIME, data: {
  callId: 'call_a', name: 'ops_bash', turn: 1, step: 1, arguments: '{"command":"seq 1 3000"}' } })
const result = (seq, text, extra = {}) => ({ type: 'tool/result', seq, time: TIME + seq, data: {
  turn: 1, step: 1, message: { source: { callId: 'call_a' }, content: [{ type: 'text', text }] } }, ...extra })
// The two durably recorded events a host prune leaves behind, in order.
const replacement = (text = PRUNED, extra = {}) => result(3, text, {
  surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2], ...extra })

const fold = (events, config = { textLimit: 2_000 }) => {
  const ndjson = events.map(event => JSON.stringify({ record: 'event', ...projectEvent(event, config) })).join('\n')
  const parsed = parseAppendLog(ndjson)
  return { ...foldRecords(parsed.records, { config }), malformed: parsed.malformed }
}

await test('a replaced result is drawn once, and the row it superseded is withdrawn', () => {
  const doc = fold([call(), result(2, LONG), replacement()])
  const results = doc.trace.filter(row => row.kind === 'tool_result' || row.kind === 'tool_error')
  assert.equal(results.length, 1, 'one call must not produce two result rows')
  assert.equal(results[0].seq, 3, 'the surviving row is the replacement')
  assert.equal(doc.trace.some(row => row.seq === 2), false, 'the superseded row is gone from the trace')
  const conversation = doc.conversation.filter(row => row.role === 'tool')
  assert.equal(conversation.length, 1, 'the conversation keeps one tool row too')
  assert.equal(conversation[0].seq, 3)
  assert.equal(results[0].pruned, true, 'the surviving row says it is a pruned replacement')
  assert.equal(results[0].supersedes, 2, 'and names the row it replaced')
  assert.match(results[0].text, /已裁剪（替换 #2）/)
})

await test('counting stays honest: events are events, results are results', () => {
  const doc = fold([call(), result(2, LONG), replacement()])
  assert.equal(doc.metrics.toolCalls, 1, 'one call is one call')
  assert.equal(doc.metrics.toolErrors, 0, 'a successful replacement stays a success')
  assert.equal(doc.events.types['tool/result'], 2, 'the host emitted two result events and the document says so')
  assert.equal(doc.metrics.eventCount, 3, 'every emitted event is still counted')
  assert.equal(doc.limits.pruneReplacements, 1, 'the replacement is reported as one withdrawal')
  assert.equal(doc.limits.droppedChars, PRUNED.length - 2_000,
    'dropped characters come from the surviving row only, never from both')
})

await test('a failure that was replaced is not counted twice, and a fixed failure is withdrawn', () => {
  const failed = result(2, LONG)
  failed.data.message.isError = true
  const twice = fold([call(), failed, replacement()])
  assert.equal(twice.metrics.toolErrors, 0, 'the superseded failure is withdrawn with its row')
  const replacedFailure = replacement(PRUNED)
  replacedFailure.data.message.isError = true
  const once = fold([call(), failed, replacedFailure])
  assert.equal(once.metrics.toolErrors, 1, 'a failure that survives as the replacement counts once')
})

await test('the replacement inherits the name and duration the superseded row had', () => {
  const doc = fold([call(), result(2, LONG), replacement()])
  const row = doc.trace.find(entry => entry.seq === 3)
  assert.equal(row.name, 'ops_bash', 'the tool name comes from the superseded result, not a lost pending call')
  assert.equal(row.durationMs, 2, 'the duration is inherited from the superseded row (the call ran 1s before it settled), not recomputed from the replacement')
})

await test('a range replacement is not a tool-result replacement and changes nothing', () => {
  const summary = { type: 'user/message', seq: 4, time: TIME + 4, data: {
    source: { kind: 'user' }, content: [{ type: 'text', text: 'checkpoint' }] },
    surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 }, sourceEventSeqs: [2, 3] }
  const doc = fold([call(), result(2, LONG), summary])
  assert.equal(doc.trace.filter(row => row.kind === 'tool_result').length, 1, 'both results still show')
  assert.equal(doc.limits.pruneReplacements, undefined, 'no tool-result withdrawal is claimed')
})

await test('a log written before the replacement metadata keeps both rows instead of guessing', () => {
  // A repeated call id alone is not proof of a replacement: withdrawing on that guess would
  // delete real output. Older captures therefore stay exactly as they were recorded.
  const doc = fold([call(), result(2, LONG), result(3, LONG)])
  assert.equal(doc.trace.filter(row => row.kind === 'tool_result').length, 2, 'both rows survive')
  assert.equal(doc.limits.pruneReplacements, undefined, 'no withdrawal is claimed')
  assert.equal(doc.metrics.toolCalls, 1)
  assert.equal(doc.metrics.toolErrors, 0)
})

await test('only a single-target replace is projected, and a malformed one is counted', () => {
  const config = { textLimit: 2_000 }
  const projected = projectEvent(replacement(), config)
  assert.deepEqual(projected.surfaceOp, { op: 'replace', startSeq: 2, endSeq: 2 })
  assert.deepEqual(projected.sourceEventSeqs, [2])
  assert.equal(projectEvent({ ...result(5, 'x'), surfaceOp: { op: 'merge', startSeq: 2, endSeq: 2 } }, config).surfaceOp, undefined)
  assert.equal(projectEvent({ ...result(5, 'x'), surfaceOp: { op: 'replace', startSeq: 'x', endSeq: 2 } }, config).surfaceOp, undefined)
  const broken = { type: 'tool/result', seq: 6, time: TIME, data: { message: { content: [] } },
    surfaceOp: { op: 'replace', startSeq: -1, endSeq: -1 } }
  const record = { record: 'event', ...broken }
  const doc = foldRecords([record], { config })
  assert.equal(doc.events.malformed, 1, 'a poisoned replacement is refused, not trusted')
})

await test('real host replacement shape from a captured session folds to one row', () => {
  // Copied verbatim (fields only) from session-0cdf28f3 seq 122/8569 of this machine.
  const events = [
    { type: 'tool/call', seq: 1, time: TIME, data: { callId: 'call_00_VFs7k1tBLpAJ', name: 'run_code', turn: 1, step: 1, arguments: '{}' } },
    { type: 'tool/result', seq: 2, time: TIME + 1, data: { turn: 1, step: 1,
      message: { source: { callId: 'call_00_VFs7k1tBLpAJ' }, content: [{ type: 'text', text: LONG }] } } },
    { type: 'compaction/prune', seq: 3, time: TIME + 2, data: { shadowedRange: { start: 2, end: 2 },
      shadowedSeqs: [2], shadowedTokenCount: 2_251 } },
    { type: 'tool/result', seq: 4, time: TIME + 3, data: { turn: 1, step: 1,
      message: { source: { callId: 'call_00_VFs7k1tBLpAJ' }, content: [{ type: 'text', text: PRUNED }] } },
      surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2] },
  ]
  const doc = fold(events)
  const results = doc.trace.filter(row => row.kind === 'tool_result')
  assert.equal(results.length, 1)
  assert.equal(results[0].seq, 4)
  assert.equal(doc.metrics.toolCalls, 1)
  assert.equal(doc.limits.pruneReplacements, 1)
  assert.equal(doc.events.types['compaction/prune'], 1, 'the prune marker is still recorded by type')
})

// Fill one view independently before replacing an already visible result.
function capacityEvents(view, count) {
  const events = [call(), result(2, LONG)]
  events[1].data.message.isError = true
  const padding = view === 'trace' ? count - 2 : count - 1
  for (let index = 0; index < padding; index += 1) {
    const seq = events.length + 1
    events.push(view === 'trace'
      ? { type: 'step/end', seq, time: TIME + seq, data: { step: index } }
      : { type: 'user/message', seq, time: TIME + seq, data: {
          source: { kind: 'user' }, content: [{ type: 'text', text: 'keep' }] } })
  }
  const seq = events.length + 1
  events.push(result(seq, PRUNED, {
    surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2],
  }))
  return events
}

for (const [view, count, failed] of [
  ['trace', 19_999, false], ['trace', 20_000, true],
  ['conversation', 19_999, true], ['conversation', 20_000, false],
]) {
  await test(`replacement remains visible with ${view} at ${count} rows`, () => {
    const events = capacityEvents(view, count)
    const last = events[events.length - 1]
    last.data.message.isError = failed
    const doc = fold(events)
    const trace = doc.trace.filter(row => row.seq === last.seq)
    const conversation = doc.conversation.filter(row => row.seq === last.seq)
    assert.equal(trace.length, 1, 'the replacement is visible in trace exactly once')
    assert.equal(conversation.length, 1, 'the replacement is visible in conversation exactly once')
    assert.equal(doc.trace.some(row => row.seq === 2), false)
    assert.equal(doc.conversation.some(row => row.seq === 2), false)
    const padding = events.slice(2, -1)
    assert.deepEqual(doc.trace.map(row => row.seq), [1, ...padding.slice(0, 19_998).map(event => event.seq), last.seq],
      'the other retained trace rows stay ordered and the replacement is last')
    assert.deepEqual(doc.conversation.map(row => row.seq), [
      ...(view === 'conversation' ? padding.map(event => event.seq) : []), last.seq,
    ], 'the other retained conversation rows stay ordered and the replacement is last')
    assert.equal(trace[0].kind, failed ? 'tool_error' : 'tool_result')
    assert.equal(trace[0].name, 'ops_bash')
    assert.equal(trace[0].durationMs, 2)
    assert.equal(trace[0].pruned, true)
    assert.equal(trace[0].supersedes, 2)
    assert.equal(conversation[0].text, PRUNED.slice(0, 2_000))
    assert.equal(conversation[0].chars, PRUNED.length)
    assert.equal(conversation[0].truncated, true)
    assert.equal(conversation[0].droppedChars, PRUNED.length - 2_000)
    assert.equal(doc.metrics.toolCalls, 1)
    assert.equal(doc.metrics.toolErrors, failed ? 1 : 0)
    assert.equal(doc.metrics.eventCount, events.length)
    assert.equal(doc.events.types['tool/result'], 2)
    assert.equal(doc.limits.pruneReplacements, 1)
    assert.equal(doc.limits.droppedChars, PRUNED.length - 2_000)
    assert.equal(doc.limits.traceTruncated, view === 'conversation' && count === 20_000)
    assert.equal(doc.limits.conversationTruncated, false)
  })
}

await test('replacement does not clear existing view truncation flags', () => {
  const events = capacityEvents('conversation', 20_000)
  const last = events.pop()
  const seq = events.length + 1
  events.push({ type: 'user/message', seq, time: TIME + seq, data: {
    source: { kind: 'user' }, content: [{ type: 'text', text: 'omitted' }] } })
  last.seq = events.length + 1
  last.time = TIME + last.seq
  events.push(last)
  const doc = fold(events)
  assert.equal(doc.trace.filter(row => row.seq === last.seq).length, 1)
  assert.equal(doc.conversation.filter(row => row.seq === last.seq).length, 1)
  assert.equal(doc.trace.some(row => row.seq === 2), false)
  assert.equal(doc.conversation.some(row => row.seq === 2), false)
  assert.equal(doc.trace.some(row => row.seq === seq), false)
  assert.equal(doc.conversation.some(row => row.seq === seq), false)
  assert.equal(doc.trace.length, 20_000)
  assert.equal(doc.conversation.length, 20_000)
  assert.equal(doc.limits.traceTruncated, true)
  assert.equal(doc.limits.conversationTruncated, true)
  assert.equal(doc.metrics.eventCount, events.length)
  assert.equal(doc.events.types['tool/result'], 2)
  assert.equal(doc.limits.pruneReplacements, 1)
  assert.equal(doc.metrics.toolErrors, 0)
  assert.equal(doc.limits.droppedChars, PRUNED.length - 2_000)
})

await test('a legal replacement chain stays visible at trace capacity', () => {
  const events = capacityEvents('trace', 20_000)
  const first = events[events.length - 1]
  const seq = first.seq + 1
  const last = result(seq, PRUNED, {
    surfaceOp: { op: 'replace', startSeq: first.seq, endSeq: first.seq }, sourceEventSeqs: [first.seq],
  })
  last.data.message.isError = true
  events.push(last)
  const doc = fold(events)
  assert.equal(doc.trace.filter(row => row.seq === seq).length, 1)
  assert.equal(doc.conversation.filter(row => row.seq === seq).length, 1)
  assert.equal(doc.trace.some(row => row.seq === 2 || row.seq === first.seq), false)
  assert.equal(doc.conversation.some(row => row.seq === 2 || row.seq === first.seq), false)
  assert.equal(doc.trace.length, 20_000)
  assert.equal(doc.conversation.length, 1)
  assert.equal(doc.metrics.toolErrors, 1)
  assert.equal(doc.metrics.eventCount, events.length)
  assert.equal(doc.events.types['tool/result'], 3)
  assert.equal(doc.limits.pruneReplacements, 2)
  assert.equal(doc.limits.droppedChars, PRUNED.length - 2_000)
  assert.equal(doc.limits.traceTruncated, false)
})

report('panel-prune-fold')