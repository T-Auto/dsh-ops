/** Native file-tool descriptions must describe the schemas the worker enforces (#44). */
import { DESCRIPTIONS, PARAMETERS } from '../lib/file/contract.js'
import { DESCRIPTIONS as PTC_DESCRIPTIONS } from '../lib/ptc/contract.js'
import { jsonRender } from '../lib/executor.js'
import { decode as toonDecode } from '@toon-format/toon'
import { assert, report, test } from './lib/harness.mjs'

const fields = tool => Object.fromEntries(Object.entries(PARAMETERS[tool].properties).map(([name, schema]) => [name, schema.type]))

await test('grep, glob and replace parameters are pinned exactly', () => {
  assert.deepEqual(fields('grep'), {
    path: 'string', pattern: 'string', glob: 'array', outputMode: 'string', caseInsensitive: 'boolean',
    lineNumbers: 'boolean', beforeContext: 'integer', afterContext: 'integer', multiline: 'boolean', offset: 'integer', limit: 'integer',
  })
  assert.deepEqual(fields('glob'), { path: 'string', pattern: 'array', outputMode: 'string', sort: 'string', offset: 'integer', limit: 'integer' })
  assert.deepEqual(fields('replace'), { path: 'string', pattern: 'string', replacement: 'string', glob: 'array', maxReplacements: 'integer', dryRun: 'boolean' })
  for (const tool of ['grep', 'glob', 'replace']) assert.equal(PARAMETERS[tool].properties.include, undefined)
})

await test('descriptions name the array syntax, the missing include and literal replace', () => {
  assert.match(DESCRIPTIONS.glob, /pattern is an ARRAY of globs matched against paths relative to path/)
  assert.match(DESCRIPTIONS.glob, /\["\*\*\/\*\.md","!vendor\/\*\*"\]/)
  assert.match(DESCRIPTIONS.glob, /"\*\.md" matches the top level only/)
  assert.match(DESCRIPTIONS.glob, /at least one positive entry/)
  assert.match(DESCRIPTIONS.grep, /pattern is ONE Rust regex string/)
  assert.match(DESCRIPTIONS.grep, /glob, an ARRAY/)
  assert.match(DESCRIPTIONS.grep, /There is no include field/)
  assert.match(DESCRIPTIONS.replace, /LITERAL text \(pattern is not a regex\)/)
  // Only ops_glob requires a positive entry; the grep/replace filters accept exclude-only lists.
  for (const tool of ['grep', 'replace']) assert.doesNotMatch(DESCRIPTIONS[tool], /positive entry/)
  assert.doesNotMatch(DESCRIPTIONS.glob, /include\/exclude/)
})

await test('file descriptions no longer repeat the failures-are-values note (it lives in the routing policy table)', () => {
  for (const tool of Object.keys(PARAMETERS)) {
    assert.doesNotMatch(DESCRIPTIONS[tool], /they are not thrown/, tool)
  }
  assert.doesNotMatch(PTC_DESCRIPTIONS.result, /legacy ops_\*/)
  assert.match(PTC_DESCRIPTIONS.result, /not thrown errors/)
})

await test('jsonRender switches to TOON only for multi-field object lists, else stays JSON', () => {
  const render = (value) => jsonRender(null, value)[0].text
  const isToon = (text) => !text.startsWith('{')
  const env = (items) => ({ status: 'completed', phase: 'verify', changed: 0, matched: items.length, skipped: 0, failed: 0, complete: true, truncated: false, omitted: 0, total: items.length, nextOffset: items.length, items })
  const table = (n, keys) => Array.from({ length: n }, (_, i) => Object.fromEntries(keys.map((k, j) => [k, j === 0 ? `v${i}` : i])))
  // TOON wins: uniform multi-field object lists, N >= 3 (grep-count and result-page shapes).
  assert.equal(isToon(render(env(table(5, ['path', 'count'])))), true, 'grep-count shape -> TOON')
  assert.equal(isToon(render(env(table(5, ['path', 'size', 'kind', 'depth'])))), true, 'result-page shape -> TOON')
  // Fail-closed to JSON: flat scalar arrays (glob paths), single-key lists (grep files_with_matches),
  // lists below the item threshold, ragged keys, and error envelopes with no items.
  assert.equal(isToon(render(env(['a/b.js', 'a/c.js', 'a/d.js']))), false, 'glob paths (flat) -> JSON')
  assert.equal(isToon(render(env(table(5, ['path'])))), false, 'single-key list -> JSON')
  assert.equal(isToon(render(env(table(2, ['path', 'count'])))), false, 'N < 3 -> JSON')
  assert.equal(isToon(render(env([{ path: 'a', count: 1 }, { path: 'b' }]))), false, 'ragged keys -> JSON')
  assert.equal(isToon(render({ status: 'error', error: { code: 'X', phase: 'preflight', retryable: false, effectState: 'none', message: 'boom' } })), false, 'error envelope -> JSON')
  // The TOON branch must stay lossless: decode(render(value)) equals the original value.
  const value = env(table(6, ['path', 'count']))
  assert.deepEqual(toonDecode(render(value)), value, 'TOON branch round-trips to the original value')
})

report('file-contract')
