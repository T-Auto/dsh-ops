import { assert, test, report } from './lib/harness.mjs'
import { deferred, documentFor, flush, panelDom, response } from './lib/panel-dom.mjs'

function assertSession(view, name) {
  assert.equal(view.node('source').dataset.file, name + '.json')
  assert.match(view.node('source').textContent, new RegExp('session ' + name + '$'))
  assert.equal(view.node('sessions').value, name + '.json')
  assert.equal(new URL(view.window.location.href).searchParams.get('data'), name + '.json')
  assert.equal(JSON.parse(view.node('tab-raw').textContent).meta.sessionId, name)
}

await test('an older fetch cannot replace the selected session or its URL', async () => {
  const view = panelDom('?data=old.json')
  try {
    view.select('new.json')
    view.requests[2].resolve(response(documentFor('new')))
    await flush()
    view.requests[1].resolve(response(documentFor('old')))
    await flush()
    assertSession(view, 'new')
    assert.deepEqual(view.errors, [])
  } finally { view.close() }
})

await test('an older response body cannot replace a newer response for the same filename', async () => {
  const view = panelDom('?data=same.json')
  try {
    const body = deferred()
    view.requests[1].resolve({ ok: true, text: () => body.promise })
    await flush()
    view.select('same.json')
    view.requests[2].resolve(response(documentFor('new-content')))
    await flush()
    body.resolve(JSON.stringify(documentFor('old-content')))
    await flush()
    assert.equal(JSON.parse(view.node('tab-raw').textContent).meta.sessionId, 'new-content')
  } finally { view.close() }
})

await test('an obsolete failure cannot warn or clear the latest pending selection before the index arrives', async () => {
  const view = panelDom('?data=old.json')
  try {
    view.select('new.json')
    view.requests[1].reject(new Error('obsolete-failure'))
    await flush()
    view.requests[0].resolve(response({ sessions: [{ file: 'old.json', sessionId: 'old', mtimeMs: 0 }, { file: 'new.json', sessionId: 'new', mtimeMs: 1 }] }))
    await flush()
    assert.equal(view.node('sessions').value, 'new.json')
    assert.equal(view.requests.length, 3)
    view.requests[2].resolve(response(documentFor('new')))
    await flush()
    assertSession(view, 'new')
    assert.doesNotMatch(view.node('note').textContent, /obsolete-failure/)
  } finally { view.close() }
})

await test('the latest fetch failure is still visible', async () => {
  const view = panelDom('?data=latest.json')
  try {
    view.requests[1].reject(new Error('latest-failure'))
    await flush()
    assert.match(view.node('note').textContent, /latest-failure/)
  } finally { view.close() }
})

await test('a local file supersedes pending network loads and the late session index', async () => {
  const view = panelDom('?data=old.json')
  try {
    const reader = view.file('local.json', true)
    reader.result = JSON.stringify(documentFor('local'))
    reader.onload()
    view.requests[0].resolve(response({ sessions: [{ file: 'old.json', sessionId: 'old', mtimeMs: 0 }] }))
    view.requests[1].resolve(response(documentFor('old')))
    await flush()
    assert.equal(view.node('source').dataset.file, 'local.json')
    assert.equal(JSON.parse(view.node('tab-raw').textContent).meta.sessionId, 'local')
    assert.equal(view.requests.length, 2)
  } finally { view.close() }
})

await test('a stale FileReader cannot replace a later session selection', async () => {
  const view = panelDom()
  try {
    const reader = view.file('local.json')
    view.select('new.json')
    view.requests[1].resolve(response(documentFor('new')))
    await flush()
    reader.result = JSON.stringify(documentFor('local'))
    reader.onload()
    assertSession(view, 'new')
  } finally { view.close() }
})

report('panel-view-observability')
