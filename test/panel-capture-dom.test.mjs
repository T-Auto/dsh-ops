import { assert, test, report } from './lib/harness.mjs'
import { flush, panelDom, response } from './lib/panel-dom.mjs'
import { foldRecords, projectEvent } from '../lib/panel/collect.js'

await test('real product trace rendering keeps PR700 text inert while scripts and event handlers are enabled', async () => {
  const view = panelDom('?data=trace.json')
  try {
    view.window.pwn = 0
    const payload = '<img src=x onerror="pwn++"><svg onload="pwn++"></svg><script>pwn++</script>'
    const events = [
      ['tool/ptc-dispatch-start', { subCallId: 'sub', name: payload, arguments: payload }],
      ['tool/ptc-dispatch', { subCallId: 'sub', name: payload, content: [{ type: 'text', text: payload }] }],
      ['job/registered', { jobId: 'job', kind: 'bash', label: payload, toolCall: { callId: 'sub' } }],
      ['job/settled', { jobId: 'job', kind: 'bash', status: 'completed', detail: payload, toolCall: { callId: 'sub' } }],
      ['agent/inbox/spliced', { target: 'next-turn', inserted: [{ content: [{ type: 'text', text: payload }] }] }],
      ['todo/write', { todos: [{ content: payload, status: 'pending' }] }],
    ]
    const value = foldRecords(events.map(([type, data], seq) => ({
      record: 'event', ...projectEvent({ type, data, seq: seq + 1, time: 0 }),
    })))
    const kinds = ['ptc_dispatch_start', 'ptc_dispatch', 'job_registered', 'job_settled', 'inbox_spliced', 'todo_write']
    assert.deepEqual(value.trace.map(row => row.kind), kinds)
    for (const row of value.trace) assert.ok(row.text.includes(payload), row.kind)
    view.requests[1].resolve(response(value))
    await flush()
    view.window.document.querySelector('button[data-tab=trace]').click()
    assert.equal(view.node('tab-trace').hidden, false)
    const bodies = [...view.node('tab-trace').querySelectorAll('.body')]
    assert.equal(bodies.length, kinds.length)
    for (const [index, body] of bodies.entries()) assert.equal(body.textContent, value.trace[index].text)
    assert.equal(view.node('tab-trace').querySelectorAll('img,svg,script,[onerror],[onload]').length, 0)
    assert.equal(view.window.pwn, 0)
    assert.deepEqual(view.errors, [])
    // Positive control: this DOM actually executes event attributes if markup is inserted.
    const control = view.window.document.createElement('div')
    control.innerHTML = payload
    control.querySelector('img').dispatchEvent(new view.window.Event('error'))
    assert.equal(view.window.pwn, 1)
  } finally { view.close() }
})

report('panel-capture-dom')
