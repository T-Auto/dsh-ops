/** Native-only summary aliases; canonical values and independent facts stay intact. */
import { renderNative } from '../lib/projections/native/render.js'
import { assert, test, report } from './lib/harness.mjs'

const search = overrides => ({ status: 'completed', changed: 0, complete: true, truncated: false,
  scanComplete: true, pageComplete: true, scannedFiles: 2, skippedFiles: 0, skipReasons: {},
  matchedObserved: 2, matchedTotal: 2, matched: 2, total: 2, nextOffset: 2, omitted: 0,
  truncatedBy: 'none', items: ['/work/a', '/work/b'], ...overrides })
const read = overrides => ({ status: 'completed', complete: true, lineCount: 2, total: 2,
  revision: 'hash', bytes: 4, nextOffset: 3, omitted: 0,
  items: [{ path: '/work/a', line: 1, text: 'a' }, { path: '/work/a', line: 2, text: 'b' }], ...overrides })
const bytes = text => Buffer.byteLength(text)
const render = (tool, value, args = {}) => {
  const original = structuredClone(value)
  const text = renderNative(tool, args, value)
  assert.deepEqual(value, original, 'Native projection must not mutate the canonical/PTC data')
  return text
}

await test('glob drops only repeated counters and successful read-only changed=0', () => {
  const text = render('glob', search())
  assert.doesNotMatch(text, /changed=|\bmatched=|\btotal=/)
  assert.equal(text.match(/skippedFiles=/g)?.length, 1)
  for (const fact of ['scanComplete=true', 'pageComplete=true', 'complete=true', 'matchedObserved=2',
    'matchedTotal=2', 'nextOffset=2', 'omitted=0', 'TruncatedBy: none', '2 items displayed', '/work/a', '/work/b']) {
    assert.ok(text.includes(fact), fact)
  }
})

await test('a text read states the total line count once but preserves ranges and revisions', () => {
  for (const value of [read(), read({ lineCount: 0, total: 0, bytes: 0, items: [] }),
    read({ complete: false, truncated: true, lineCount: 3, total: 3, omitted: 1 })]) {
    const text = render('inspect_local_file', value, { path: '/work/a' })
    assert.match(text, new RegExp(`of ${value.lineCount}\\) ===`))
    assert.doesNotMatch(text, /lineCount=|\btotal=/)
    assert.match(text, /revision=hash/)
    assert.match(text, /nextOffset=3/)
    assert.match(text, new RegExp(`omitted=${value.omitted}`))
    assert.match(text, new RegExp(`complete=${value.complete}`))
  }
})

await test('page, scan, display and item totals are independent even when their values coincide', () => {
  const page = render('glob', search({ complete: false, truncated: true, items: ['/work/a'],
    nextOffset: 1, omitted: 1, truncatedBy: 'row-limit', continuation: 'cursor' }))
  for (const fact of ['scanComplete=true', 'pageComplete=true', 'complete=false', 'continuation=cursor',
    'nextOffset=1', 'omitted=1', 'TruncatedBy: row-limit']) assert.ok(page.includes(fact), fact)
  const grep = render('grep', search({ total: 1, items: [{ path: '/work/a', line: 1, text: 'function f() {}', kind: 'function' }] }))
  assert.match(grep, /total=1/)
  assert.match(grep, /matchedObserved=2; matchedTotal=2/)
  const same = render('grep', search({ total: 2 }))
  assert.match(same, /total=2/, 'grep output rows and regex match count are not interchangeable')
  const hex = render('inspect_local_file', read({ items: [{ path: '/work/a', view: 'hex', offset: 0, text: '61 0a' }] }), { view: 'hex' })
  assert.match(hex, /\(Hex\)/)
  assert.match(hex, /lineCount=2/)
  assert.match(hex, /total=2/, 'hex heading has no line total')
  const inconsistent = render('inspect_local_file', read({ total: 9 }))
  assert.match(inconsistent, /Lines 1-2 of 2/)
  assert.match(inconsistent, /total=9/, 'different facts are never suppressed by a label heuristic')
  const unknownCount = render('inspect_local_file', read({ lineCount: null }))
  assert.match(unknownCount, /lineCount=null/, 'a null line count is not the numeric fallback total')
})

await test('scan gaps and error effects retain observations and actionable guidance', () => {
  const value = search({ scanComplete: false, matchedTotal: undefined, total: undefined, complete: false,
    skippedFiles: 1, skipReasons: { EACCES: 1 }, truncatedBy: 'scan-budget',
    nextAction: 'Narrow path and start a fresh query.' })
  for (const status of ['completed', 'error']) {
    const text = render('glob', { ...value, status, ...(status === 'error' ? {
      error: { code: 'RESULT_PARTIAL', effectState: 'none', message: 'Incomplete traversal.' },
    } : {}) })
    for (const fact of ['scanComplete=false', 'pageComplete=true', 'matchedObserved=2', 'skipReasons={"EACCES":1}',
      'skippedFiles=1', 'TruncatedBy: scan-budget', '/work/a', 'Next: Narrow path']) assert.ok(text.includes(fact), fact)
    assert.doesNotMatch(text, /matchedTotal=|\btotal=/)
    if (status === 'error') {
      assert.match(text, /RESULT_PARTIAL/)
      assert.match(text, /effectState=none/)
      assert.match(text, /changed=0/, 'failure must not inherit the successful-read omission')
    }
  }
  assert.match(render('glob', search({ changed: 1 })), /changed=1/)
  assert.match(render('glob', search({ failed: 1 })), /changed=0/, 'failed observations retain zero-change facts')
  const repeatedAdvice = render('glob', { ...value, status: 'error', error: { code: 'RESULT_PARTIAL', effectState: 'none', nextAction: value.nextAction } })
  assert.equal(repeatedAdvice.match(/Next:/g)?.length, 1, 'identical failure and search advice is stated once')
  assert.match(render('other', search()), /changed=0/, 'only named read-only tools qualify')
  assert.match(render('replace', search()), /changed=0/, 'mutation previews still report zero changes')
  const unknown = render('replace', { status: 'unknown', changed: 0, error: { code: 'RESULT_UNKNOWN', effectState: 'unknown' },
    items: [{ path: '/work/a', status: 'pending' }] })
  assert.match(unknown, /effectState=unknown; retry=never/)
  assert.match(unknown, /changed=0/)
})

await test('display truncation, continuation and stale failures remain explicit', () => {
  const text = render('inspect_local_file', read({ items: [{ path: '/work/a', line: 1, text: 'x'.repeat(80000) }] }))
  assert.match(text, /Display incomplete.*TruncatedBy: output-budget/)
  assert.match(text, /do not advance past undisplayed content/)
  assert.ok(bytes(JSON.stringify([{ type: 'text', text }])) <= 65536)
  const stale = render('glob', { status: 'error', error: { code: 'SEARCH_STALE', effectState: 'none',
    message: 'The tree changed.', nextAction: 'Start a fresh query.' } })
  assert.match(stale, /SEARCH_STALE/)
  assert.match(stale, /effectState=none/)
  assert.match(stale, /Start a fresh query/)
})

await test('the same canonical fixtures shrink only duplicated Native text', () => {
  // UTF-8 text sizes measured with the renderer at main 77cd34f9, not token or task estimates.
  const cases = [
    ['empty glob', 'glob', search({ scannedFiles: 0, matchedObserved: 0, matchedTotal: 0, matched: 0, total: 0, nextOffset: 0, items: [] }), 264],
    ['short glob', 'glob', search(), 280],
    ['paged glob', 'glob', search({ complete: false, truncated: true, items: ['/work/a'], nextOffset: 1,
      omitted: 1, truncatedBy: 'row-limit', continuation: 'cursor' }), 298],
    ['scan gap', 'glob', search({ scanComplete: false, matchedTotal: undefined, total: undefined, complete: false,
      skippedFiles: 1, skipReasons: { EACCES: 1 }, truncatedBy: 'scan-budget', nextAction: 'Narrow path and start a fresh query.' }), 317],
    ['short read', 'inspect_local_file', read(), 194],
    ['empty read', 'inspect_local_file', read({ lineCount: 0, total: 0, bytes: 0, items: [] }), 196, { path: '/work/a' }],
    ['paged read', 'inspect_local_file', read({ complete: false, truncated: true, lineCount: 3, total: 3, omitted: 1 }), 203],
  ]
  for (const [name, tool, value, before, args] of cases) {
    const after = bytes(render(tool, value, args))
    assert.ok(after < before, `${name}: ${before} -> ${after} bytes`)
    console.log(`  Native ${name}: ${before} -> ${after} UTF-8 bytes`)
  }
})

report('native-summary')
