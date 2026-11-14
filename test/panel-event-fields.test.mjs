/** Host events that used to be captured by type alone now carry the fields a reader needs. */
import { foldRecords, parseAppendLog, projectEvent } from '../lib/panel/collect.js'
import { assert, report, test } from './lib/harness.mjs'
const project = (type, data) => projectEvent({ type, seq: 1, time: 1_000, data })

await test('ptc dispatch events keep the inner tool, its arguments and its outcome', () => {
  // The host hands over the dispatched value itself (a detached JSON object) — 479 of 479
  // `tool/ptc-dispatch*` events sampled from a live 0.2.2-rc.1 ptc-preset session carried an
  // object here, never a string, so the fixture must not pre-stringify it.
  const command = { command: 'ls -la' }
  const start = project('tool/ptc-dispatch-start', { rootCallId: 'root', parentCallId: 'parent', subCallId: 'sub-1', name: 'ops_bash', arguments: command })
  assert.equal(start.name, 'ops_bash')
  assert.equal(start.callId, 'sub-1', 'the dispatched call id identifies the inner tool call')
  assert.equal(start.arguments.text, '{"command":"ls -la"}', 'the object argument becomes its JSON text')
  const settled = project('tool/ptc-dispatch', { rootCallId: 'root', parentCallId: 'parent', subCallId: 'sub-1', name: 'ops_bash',
    arguments: command, isError: true, error: { name: 'ShellError', code: 'SHELL_FAILED' }, content: [{ type: 'text', text: 'command failed' }] })
  assert.equal(settled.name, 'ops_bash')
  assert.equal(settled.isError, true)
  assert.equal(settled.errorCode, 'SHELL_FAILED')
  assert.equal(settled.payload.text, 'command failed', 'the dispatched result text is kept')
})

await test('job lifecycle events keep the id, the call id and the kind the host actually sends', () => {
  // The host sends `toolCall: { callId, rootCallId }` plus `kind`; it names no tool on a job.
  const registered = project('job/registered', { jobId: 'job_1', kind: 'bash', label: 'ls -la', startedAt: 10,
    toolCall: { callId: 'call_1', rootCallId: 'call_1' } })
  assert.equal(registered.jobId, 'job_1')
  assert.equal(registered.callId, 'call_1', 'the call id is what a reader can join on')
  assert.equal(registered.kind, 'bash')
  assert.equal(registered.name, undefined, 'the host names no tool here, so the record must not invent one')
  assert.equal(registered.status, undefined, 'a registration carries no status')
  const settled = project('job/settled', { jobId: 'job_1', kind: 'bash', label: 'ls -la', startedAt: 10, status: 'completed',
    finishedAt: 20, detail: 'exit 0', toolCall: { callId: 'call_1', rootCallId: 'call_1' } })
  assert.equal(settled.jobId, 'job_1')
  assert.equal(settled.status, 'completed')
  assert.equal(settled.payload.text, 'ls -la — exit 0')
})

await test('the fold resolves the job tool name from the tool/call record through the call id', () => {
  const records = [
    { record: 'event', seq: 1, time: 10, type: 'tool/call', callId: 'call_1', name: 'ops_bash', turn: 1, step: 1 },
    { record: 'event', seq: 2, time: 11, type: 'job/registered', jobId: 'job_1', callId: 'call_1', kind: 'bash' },
    { record: 'event', seq: 3, time: 12, type: 'job/settled', jobId: 'job_1', callId: 'call_1', kind: 'bash', status: 'completed' },
    { record: 'event', seq: 4, time: 13, type: 'job/registered', jobId: 'job_2', kind: 'bash' },
  ]
  const document = foldRecords(parseAppendLog(records.map(value => JSON.stringify(value)).join('\n')).records)
  assert.deepEqual(document.trace.map(row => row.kind), ['tool_call', 'job_registered', 'job_settled', 'job_registered'])
  assert.equal(document.trace[1].name, 'ops_bash', 'the call id resolves the tool the job came from')
  assert.equal(document.trace[1].jobKind, 'bash', 'the job kind stays visible next to the resolved name')
  assert.equal(document.trace[2].name, 'ops_bash')
  assert.equal(document.trace[3].name, 'bash', 'a job without a call id falls back to its kind instead of inventing a name')
})

await test('inbox splices and todo writes keep what changed', () => {
  const spliced = project('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [{ content: [{ type: 'text', text: 'new instruction' }] }] })
  assert.equal(spliced.target, 'next-turn')
  assert.equal(spliced.insertedCount, 1)
  assert.equal(spliced.removedCount, 1)
  assert.equal(spliced.payload.text, 'new instruction')
  const todo = project('todo/write', { todos: [{ content: 'ship the fix', status: 'in_progress' }, { content: 'write tests', status: 'pending' }] })
  assert.equal(todo.payload.text, 'in_progress: ship the fix\npending: write tests')
})

await test('an unknown event is still recorded by type and the trace shows the projected rows', () => {
  const future = project('future/event', { kept: true })
  assert.deepEqual(future, { seq: 1, time: 1_000, type: 'future/event' }, 'the fallback keeps recording unknown events by type')
  const records = [
    { record: 'event', seq: 1, time: 10, type: 'tool/ptc-dispatch-start', name: 'ops_bash', callId: 'sub-1' },
    { record: 'event', seq: 2, time: 20, type: 'tool/ptc-dispatch', name: 'ops_bash', callId: 'sub-1', isError: true, errorCode: 'SHELL_FAILED' },
    { record: 'event', seq: 3, time: 30, type: 'job/registered', jobId: 'job_1', kind: 'bash' },
    { record: 'event', seq: 4, time: 40, type: 'agent/inbox/spliced', target: 'next-turn', insertedCount: 1, removedCount: 0 },
    { record: 'event', seq: 5, time: 50, type: 'todo/write', payload: { text: 'pending: write tests' } },
    { record: 'event', seq: 6, time: 60, type: 'job/registered', jobId: 42 },
    { record: 'event', seq: 7, time: 70, type: 'job/registered', jobId: 'job_3', kind: 7 },
  ]
  const parsed = parseAppendLog(records.map(value => JSON.stringify(value)).join('\n'))
  const document = foldRecords(parsed.records)
  assert.deepEqual(document.trace.map(row => row.kind), ['ptc_dispatch_start', 'ptc_dispatch_error', 'job_registered', 'inbox_spliced', 'todo_write'])
  assert.equal(document.trace[1].name, 'ops_bash')
  assert.equal(document.trace[1].text, 'ops_bash failed (SHELL_FAILED)')
  assert.equal(document.trace[2].name, 'bash', 'a job row shows its kind when nothing resolves')
  assert.equal(document.trace[2].jobKind, 'bash')
  assert.equal(document.trace[3].target, 'next-turn')
  assert.equal(document.trace[4].text, 'pending: write tests')
  assert.equal(document.events.malformed, 2, 'a non-string job id and a non-string kind are malformed rather than coerced')
})

await test('ptc dispatch arguments keep the JSON value the host sends, not only strings', () => {
  // The 0.2.2-rc.1 PTC executor writes the dispatched value itself (detached JSON), not a string.
  const objectArgs = project('tool/ptc-dispatch-start', { subCallId: 'sub-2', name: 'ops_write', arguments: { path: 'a.txt', encoding: 'utf8' } })
  assert.equal(objectArgs.arguments.text, '{"path":"a.txt","encoding":"utf8"}', 'an object argument becomes its JSON text, never [object Object]')
  const nested = project('tool/ptc-dispatch', { subCallId: 'sub-3', name: 'ops_apply', arguments: { ops: [{ op: 'insert', at: 1 }, null, 'tail'] } })
  assert.equal(nested.arguments.text, '{"ops":[{"op":"insert","at":1},null,"tail"]}', 'nested objects, arrays and nulls survive')
  const arrayArgs = project('tool/ptc-dispatch-start', { subCallId: 'sub-4', name: 'ops_batch', arguments: [1, 'two'] })
  assert.equal(arrayArgs.arguments.text, '[1,"two"]', 'an array argument keeps its order')
  const nullArgs = project('tool/ptc-dispatch-start', { subCallId: 'sub-5', name: 'ops_ping', arguments: null })
  assert.equal(nullArgs.arguments.text, 'null', 'an explicit JSON null is not a missing argument')
  assert.equal(nullArgs.arguments.chars, 4)
  const missingArgs = project('tool/ptc-dispatch-start', { subCallId: 'missing', name: 'ops_ping' })
  assert.equal(missingArgs.arguments.text, '')
  const stringArgs = project('tool/ptc-dispatch-start', { subCallId: 'sub-6', name: 'ops_bash', arguments: 'ls -la' })
  assert.equal(stringArgs.arguments.text, 'ls -la', 'a string argument stays verbatim')
  const long = JSON.stringify({ script: 'y'.repeat(400) })
  const mixed = project('tool/ptc-dispatch', { subCallId: 'sub-9', name: 'ops_inspect', content: [{ type: 'image', url: 'file:///x.png', text: 'non-text metadata' }, { type: 'text', text: 'seen' }] })
  assert.equal(mixed.payload.text, 'seen', 'non-text blocks never reach the captured text')
  const limited = projectEvent({ type: 'tool/ptc-dispatch-start', seq: 1, time: 1_000, data: { subCallId: 'sub-7', name: 'ops_bash', arguments: { script: 'y'.repeat(400) } } }, { capture: true, textLimit: 64, maxSessionBytes: 1 << 20 })
  assert.equal(limited.arguments.text.length, 64, 'a long argument is clamped to textLimit')
  assert.equal(limited.arguments.truncated, true)
  assert.equal(limited.arguments.chars, long.length, 'the full length stays countable so truncation is visible')
})

await test('a job dispatched from a run_code program resolves its inner tool through the sub call id', () => {
  const records = [
    { record: 'event', seq: 1, time: 10, type: 'tool/call', callId: 'call-root', name: 'run_code' },
    { record: 'event', seq: 2, time: 11, type: 'tool/ptc-dispatch-start', callId: 'sub-1', name: 'ops_bash' },
    { record: 'event', seq: 3, time: 12, type: 'job/registered', jobId: 'job_1', callId: 'sub-1', kind: 'bash' },
    { record: 'event', seq: 4, time: 13, type: 'job/settled', jobId: 'job_1', callId: 'sub-1', kind: 'bash', status: 'completed' },
    { record: 'event', seq: 5, time: 14, type: 'tool/ptc-dispatch-start', callId: 'sub-2' },
    { record: 'event', seq: 6, time: 15, type: 'job/registered', jobId: 'job_2', callId: 'sub-2', kind: 'bash' },
  ]
  const document = foldRecords(parseAppendLog(records.map(value => JSON.stringify(value)).join('\n')).records)
  assert.equal(document.trace[2].name, 'ops_bash', 'the dispatch name resolves the job of an inner tool')
  assert.equal(document.trace[3].name, 'ops_bash')
  assert.equal(document.trace[5].name, 'bash', 'a dispatch without a name keeps the honest kind fallback')
})

await test('the call name index is bounded: duplicates overwrite and the oldest entry is evicted', () => {
  const records = []
  for (let index = 0; index < 2_049; index += 1) records.push({ record: 'event', seq: index + 1, time: 10 + index, type: 'tool/ptc-dispatch-start', callId: `sub-${index}`, name: `tool_${index}` })
  // A repeated start for a live call keeps the newest name and does not grow the index.
  records.push({ record: 'event', seq: 2_050, time: 3_000, type: 'tool/ptc-dispatch-start', callId: 'sub-2048', name: 'ops_bash' })
  records.push({ record: 'event', seq: 2_051, time: 3_001, type: 'job/registered', jobId: 'job_old', callId: 'sub-0', kind: 'bash' })
  records.push({ record: 'event', seq: 2_052, time: 3_002, type: 'job/registered', jobId: 'job_new', callId: 'sub-2048', kind: 'bash' })
  const document = foldRecords(parseAppendLog(records.map(value => JSON.stringify(value)).join('\n')).records)
  const jobs = document.trace.filter(row => row.kind === 'job_registered')
  assert.equal(jobs[0].name, 'bash', 'the oldest call id is evicted, so its job falls back to kind')
  assert.equal(jobs[1].name, 'ops_bash', 'a repeated start overwrites the name instead of adding an entry')
})

await test('a dispatched object argument reaches the folded trace through an in-memory append-log fixture', () => {
  // Pure projection/parser/fold unit test; panel-ptc-host.test.mjs exercises actual collector I/O.
  const events = [
    { type: 'tool/ptc-dispatch-start', seq: 1, time: 10, data: { subCallId: 'sub-1', name: 'ops_write', arguments: { path: 'a.txt', content: 'x' } } },
    { type: 'tool/ptc-dispatch', seq: 2, time: 20, data: { subCallId: 'sub-1', name: 'ops_write', arguments: { path: 'a.txt', content: 'x' }, content: [{ type: 'text', text: '{"written":true}' }] } },
    { type: 'job/registered', seq: 3, time: 30, data: { jobId: 'job_1', kind: 'file', label: 'write', toolCall: { callId: 'sub-1' } } },
  ]
  const ndjson = events.map(event => JSON.stringify({ record: 'event', ...projectEvent(event) })).join('\n')
  const document = foldRecords(parseAppendLog(ndjson).records)
  assert.equal(document.trace[0].text, '{"path":"a.txt","content":"x"}', 'the folded row carries the serialised argument, not an empty string')
  assert.equal(document.trace[1].text, '{"written":true}', 'the settled row prefers the result text')
  assert.equal(document.trace[2].name, 'ops_write', 'the sub call id resolves the inner tool on the job row')
})

await test('captured text stays text: markup is kept verbatim, never interpreted', () => {
  const markup = '<script>alert(1)</script>'
  const projected = project('tool/ptc-dispatch', { subCallId: 'sub-x', name: 'ops_bash', arguments: { cmd: markup }, content: [{ type: 'text', text: markup }] })
  assert.equal(projected.payload.text, markup, 'the captured result keeps the markup verbatim as text')
  assert.equal(JSON.parse(projected.arguments.text).cmd, markup, 'the serialised argument round-trips unchanged')
  // This checks capture fidelity, not DOM execution. The production viewer is exercised by
  // panel-view-observability.test.mjs; ops-panel-collect.test.mjs checks its unsafe sinks.
})

await test('a fixture based on observed host event shapes folds to the fields the panel reads', () => {
  // Shapes copied from a live DSH 0.2.2-rc.1 session (agentPreset=ptc): the dispatch carries the
  // value itself plus `content` blocks, and a job names no tool — only the sub call id, which is
  // the same `call_…:ptc:N` string the dispatch used. 10 of 117 sampled jobs resolved that way and
  // none of those call ids appeared on a top-level tool/call record.
  const events = [
    { type: 'tool/ptc-dispatch-start', seq: 1, time: 10, data: { rootCallId: 'call_root:ptc:0', parentCallId: 'call_root:ptc:0', subCallId: 'call_root:ptc:1', name: 'ops_bash', arguments: { command: 'ls', description: 'list' } } },
    { type: 'tool/ptc-dispatch', seq: 2, time: 20, data: { rootCallId: 'call_root:ptc:0', parentCallId: 'call_root:ptc:0', subCallId: 'call_root:ptc:1', name: 'ops_bash', arguments: { command: 'ls', description: 'list' }, isError: false, content: [{ type: 'text', text: 'file.txt' }] } },
    { type: 'job/registered', seq: 3, time: 30, data: { jobId: 'bash-1', kind: 'bash', label: 'ls', toolCall: { callId: 'call_root:ptc:1', rootCallId: 'call_root:ptc:0' } } },
    { type: 'job/settled', seq: 4, time: 40, data: { jobId: 'bash-1', kind: 'bash', label: 'ls', status: 'completed', detail: 'exit 0', toolCall: { callId: 'call_root:ptc:1', rootCallId: 'call_root:ptc:0' } } },
  ]
  const ndjson = events.map(event => JSON.stringify({ record: 'event', ...projectEvent(event) })).join('\n')
  const document = foldRecords(parseAppendLog(ndjson).records)
  assert.equal(document.trace[0].text, '{"command":"ls","description":"list"}', 'the start row shows the object argument')
  assert.equal(document.trace[1].text, 'file.txt', 'the settled row shows the result text')
  assert.equal(document.trace[2].name, 'ops_bash', 'the sub call id resolves the inner tool on registration')
  assert.equal(document.trace[3].name, 'ops_bash', 'and again on settlement')
  assert.equal(document.trace[3].jobKind, 'bash', 'the kind stays visible next to the resolved name')
})

await test('repeated old dispatch ids do not refresh FIFO age or consume extra capacity', () => {
  const events = []
  const add = (type, data) => events.push({ record: 'event', ...projectEvent({ type, data, seq: events.length, time: events.length }) })
  for (let index = 0; index < 2048; index++) add('tool/ptc-dispatch-start', { subCallId: 'sub-' + index, name: 'tool_' + index })
  add('tool/ptc-dispatch-start', { subCallId: 'sub-0', name: 'changed' })
  add('job/registered', { jobId: 'before', kind: 'fixture', toolCall: { callId: 'sub-0' } })
  add('tool/ptc-dispatch-start', { subCallId: 'sub-new', name: 'new_tool' })
  add('job/registered', { jobId: 'evicted', kind: 'fixture', toolCall: { callId: 'sub-0' } })
  add('job/registered', { jobId: 'retained', kind: 'fixture', toolCall: { callId: 'sub-1' } })
  add('tool/ptc-dispatch-start', { subCallId: 'nameless' })
  add('job/registered', { jobId: 'unnamed', kind: 'fixture', toolCall: { callId: 'nameless' } })
  assert.deepEqual(foldRecords(events).trace.filter(row => row.kind === 'job_registered').map(row => row.name),
    ['changed', 'fixture', 'tool_1', 'fixture'])
})

report('panel-event-fields')
