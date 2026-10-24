/** Native file-tool descriptions must describe the schemas the worker enforces (#44). */
import fs from 'node:fs'
import { DESCRIPTIONS, PARAMETERS } from '../lib/file/contract.js'
import { DESCRIPTIONS as PTC_DESCRIPTIONS } from '../lib/ptc/contract.js'
import { assert, report, test } from './lib/harness.mjs'

const fields = tool => Object.fromEntries(Object.entries(PARAMETERS[tool].properties).map(([name, schema]) => [name, schema.type]))

await test('grep, glob and replace parameters are pinned exactly', () => {
  assert.deepEqual(fields('grep'), {
    path: 'string', pattern: 'string', glob: 'array', outputMode: 'string', caseInsensitive: 'boolean',
    lineNumbers: 'boolean', beforeContext: 'integer', afterContext: 'integer', multiline: 'boolean', offset: 'integer', limit: 'integer', exactTotal: 'boolean', continuation: 'string',
  })
  assert.deepEqual(fields('glob'), { path: 'string', pattern: 'array', outputMode: 'string', sort: 'string', offset: 'integer', limit: 'integer', continuation: 'string' })
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

await test('every file tool states that failures are values, not thrown errors', () => {
  for (const tool of Object.keys(PARAMETERS)) {
    assert.match(DESCRIPTIONS[tool], /Failures (?:resolve as \{status:"error"\|"rejected", error\.code\}; they are not thrown|return status:error\|rejected and error\.code; never throw)\.$/, tool)
  }
  assert.doesNotMatch(PTC_DESCRIPTIONS.result, /legacy ops_\*/)
  assert.match(PTC_DESCRIPTIONS.result, /not thrown errors/)
})

await test('discoverable core file fields have concise help and distinguish glob arrays from text', () => {
  // Keep resident read_files unchanged: more advanced help is paid only after discovery.
  const core = ['inspect_local_file', 'glob', 'grep', 'stat', 'diff',
    'write_file', 'edit_file', 'copy', 'move', 'remove', 'replace']
  const visit = (schema, where) => {
    for (const [key, field] of Object.entries(schema.properties ?? {})) {
      assert.equal(typeof field.description, 'string', `${where}.${key}`)
      assert.ok(field.description.length > 0 && field.description.length <= 200, `${where}.${key}`)
      visit(field, `${where}.${key}`)
    }
    if (schema.items) visit(schema.items, `${where}[]`)
  }
  for (const name of core) visit(PARAMETERS[name], name)
  assert.match(PARAMETERS.glob.properties.pattern.description, /ARRAY.*\["\*\*\/\*\.md","!vendor\/\*\*"\]/)
  assert.match(PARAMETERS.glob.properties.pattern.description, /positive entry/)
  assert.match(PARAMETERS.grep.properties.pattern.description, /regex STRING/)
  assert.match(PARAMETERS.replace.properties.pattern.description, /literal STRING, not a regex/)
  for (const name of ['grep', 'replace']) {
    assert.match(PARAMETERS[name].properties.glob.description, /ARRAY/)
    assert.doesNotMatch(PARAMETERS[name].properties.glob.description, /positive entry/)
  }
  assert.match(PARAMETERS.glob.properties.sort.description, /newest modification first/)
  assert.match(PARAMETERS.grep.properties.lineNumbers.description, /default true/)
})

await test('current component routing does not advertise removed inspect capabilities', () => {
  for (const name of ['component-reference.md', '组件参考.md']) {
    const doc = fs.readFileSync(new URL(`../docs/${name}`, import.meta.url), 'utf8')
    assert.match(doc, /Bounded UTF-8 text \/ hex \| ops_inspect_local_file/)
    assert.doesNotMatch(doc, /Text \/ multiple ranges \/ encoding \/ PDF text/)
  }
})

report('file-contract')
