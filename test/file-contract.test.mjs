/** Native file-tool descriptions must describe the schemas the worker enforces (#44). */
import fs from 'node:fs'
import { DESCRIPTIONS, PARAMETERS } from '../lib/file/contract.js'
import { DESCRIPTIONS as PTC_DESCRIPTIONS } from '../lib/ptc/contract.js'
import { NATIVE_RESULT_DESCRIPTION, RESULT_PAGE_PARAMETERS } from '../lib/capabilities/result.js'
import { assert, report, test } from './lib/harness.mjs'

const fields = tool => Object.fromEntries(Object.entries(PARAMETERS[tool].properties).map(([name, schema]) => [name, schema.type]))

await test('grep, glob and replace parameters are pinned exactly', () => {
  assert.deepEqual(fields('grep'), {
    path: 'string', pattern: 'string', glob: 'array', outputMode: 'string', caseInsensitive: 'boolean',
    lineNumbers: 'boolean', beforeContext: 'integer', afterContext: 'integer', multiline: 'boolean', offset: 'integer', limit: 'integer', exactTotal: 'boolean', includeHidden: 'boolean', continuation: 'string',
  })
  assert.deepEqual(fields('glob'), { path: 'string', kind: 'string', pattern: 'array', outputMode: 'string', sort: 'string', offset: 'integer', limit: 'integer', includeHidden: 'boolean', continuation: 'string' })
  assert.deepEqual(PARAMETERS.glob.properties.kind.enum, ['file', 'directory', 'all'])
  assert.deepEqual(PARAMETERS.glob.required, ['pattern'])
  assert.match(PARAMETERS.glob.properties.kind.description, /default file/)
  assert.match(PARAMETERS.glob.properties.kind.description, /empty directories/)
  assert.deepEqual(PARAMETERS.glob.properties.outputMode.enum, ['paths', 'details'])
  assert.deepEqual(fields('replace'), { path: 'string', pattern: 'string', replacement: 'string', glob: 'array', maxReplacements: 'integer', dryRun: 'boolean' })
  for (const tool of ['grep', 'glob', 'replace']) assert.equal(PARAMETERS[tool].properties.include, undefined)
})

await test('search descriptions retain matching and completeness rules without repeating parameters', () => {
  assert.match(DESCRIPTIONS.glob, /Globs match paths relative to path/)
  assert.match(DESCRIPTIONS.glob, /"\*\.md" matches the top level only/)
  assert.match(DESCRIPTIONS.grep, /glob filters paths relative to path/)
  assert.match(DESCRIPTIONS.grep, /there is no include field/)
  assert.match(DESCRIPTIONS.grep, /exclude symlinks, junctions, reparse points and \.git/)
  for (const tool of ['glob', 'grep']) {
    assert.match(DESCRIPTIONS[tool], /Follow nextOffset/)
    assert.match(DESCRIPTIONS[tool], /scanComplete and pageComplete/)
    assert.match(DESCRIPTIONS[tool], /matchedTotal exists only after a complete scan/)
    assert.match(PARAMETERS[tool].properties.continuation.description, /Keep query options unchanged.*SEARCH_STALE requires a fresh query/)
    assert.doesNotMatch(DESCRIPTIONS[tool], /ARRAY|pattern is|limit defaults|SEARCH_STALE/)
    assert.match(PARAMETERS[tool].properties.limit.description, /1-10000 inclusive\. Default 100/)
    // #734: the switch is advertised only where it exists, and it lifts one rule rather than the whole exclusion set.
    assert.match(DESCRIPTIONS[tool], /includeHidden is set, which lifts only that rule/)
    assert.match(DESCRIPTIONS[tool], /never the plugin-owned \.dsh-ops sidecars/)
  }
  assert.doesNotMatch(DESCRIPTIONS.replace, /includeHidden/)
  assert.match(PARAMETERS.glob.properties.pattern.description, /at least one positive entry/)
  assert.match(PARAMETERS.grep.properties.pattern.description, /Rust regex STRING/)
  assert.match(PARAMETERS.replace.properties.pattern.description, /Nonempty literal STRING, not a regex/)
  for (const tool of ['grep', 'replace']) assert.doesNotMatch(PARAMETERS[tool].properties.glob.description, /positive entry/)
})

await test('mutation parameter contracts and Windows preservation remain after text de-duplication', () => {
  assert.match(PARAMETERS.edit_file.properties.edits.description, /1-100 nonoverlapping edits against the same original bytes/)
  assert.match(PARAMETERS.edit_file.properties.edits.items.properties.oldText.description, /Nonempty text that occurs exactly once/)
  assert.match(PARAMETERS.write_file.properties.expectedRevision.description, /SHA-256.*absent.*Never omit or pass null\/empty/)
  assert.match(PARAMETERS.move.properties.to.description, /Absent destination file on the same filesystem; relative to session cwd/)
  for (const name of ['write_file', 'edit_file', 'copy', 'replace']) {
    assert.match(DESCRIPTIONS[name], /Windows preserves available owner\/group\/ordered DACL/)
    assert.match(DESCRIPTIONS[name], /volumes without stream\/ACL support report metadataWarnings/)
    assert.match(DESCRIPTIONS[name], /readonly overwrite is refused/)
    assert.match(DESCRIPTIONS[name], /SACL\/audit labels are not preserved/)
  }
  assert.match(DESCRIPTIONS.edit_file, /Preserve CRLF\/BOM explicitly/)
  assert.doesNotMatch(DESCRIPTIONS.edit_file, /1-100|oldText must|Required expectedRevision/)
  assert.doesNotMatch(DESCRIPTIONS.write_file, /Pass expectedRevision:|null\/empty/)
})

await test('result help keeps stored-row completeness while defaults live only in parameters', () => {
  assert.match(RESULT_PAGE_PARAMETERS.root.description, /Defaults to current session cwd.*after cwd changes/)
  assert.match(RESULT_PAGE_PARAMETERS.offset.description, /default 0/)
  assert.match(RESULT_PAGE_PARAMETERS.limit.description, /1-512 rows; default 64/)
  assert.match(RESULT_PAGE_PARAMETERS.maxBytes.description, /512-65536 serialized bytes; default 16384/)
  assert.match(RESULT_PAGE_PARAMETERS.equals.description, /before projection and paging/)
  assert.match(NATIVE_RESULT_DESCRIPTION, /Follow nextOffset only when all page rows are displayed/)
  assert.match(NATIVE_RESULT_DESCRIPTION, /page complete never proves the source operation complete/)
  assert.match(NATIVE_RESULT_DESCRIPTION, /Offsets count filtered stored rows, including chunks/)
  assert.match(NATIVE_RESULT_DESCRIPTION, /join text in byteOffset order.*parse only after complete=true/)
  assert.doesNotMatch(NATIVE_RESULT_DESCRIPTION, /defaults|Page defaults|equals filters before fields/)
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
    assert.match(PARAMETERS[name].properties.glob.description, /"\*\.md" matches the top level only, "!" excludes/)
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

await test('write and edit descriptions state the effective request budget once', () => {
  for (const tool of ['write_file', 'edit_file']) {
    assert.match(DESCRIPTIONS[tool], /Requests are limited to 2 MiB; split larger changes\./)
    assert.equal(DESCRIPTIONS[tool].match(/2 MiB/g)?.length, 1)
  }
})

report('file-contract')
