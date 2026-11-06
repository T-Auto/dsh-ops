/** Host events that used to be captured by type alone now carry the fields a reader needs. */
import { foldRecords, parseAppendLog, projectEvent } from '../lib/panel/collect.js'
import { assert, report, test } from './lib/harness.mjs'
const project = (type, data) => projectEvent({ type, seq: 1, time: 1_000, data })

await test('ptc dispatch events keep the inner tool, its arguments and its outcome', () => {
  const command = JSON.stringify({ command: 'ls -la' })
  const start = project('tool/ptc-dispatch-start', { rootCallId: 'root', parentCallId: 'parent', subCallId: 'sub-1', name: 'ops_bash', arguments: command })
  assert.equal(start.name, 'ops_bash')
  assert.equal(start.callId, 'sub-1', 'the dispatched call id identifies the inner tool call')
  assert.equal(start.arguments.text, command)
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

report('panel-event-fields')
