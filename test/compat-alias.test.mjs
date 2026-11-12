/** The 0.4.0 rename keeps saved profiles and pre-rename requests working through one alias table. */
import { RENAMED_TOOLS, migrateRawName, migrateRawNames } from '../lib/compat/alias.js'
import { resolveDiscoveryConfig } from '../lib/discovery/config.js'
import { search } from '../lib/discovery/search.js'
import { parsePtcConfig } from '../lib/ptc/config.js'
import { requestedApis } from '../lib/ptc/sdk.js'
import { assert, test, report } from './lib/harness.mjs'

const RENAMES = {
  read_many: 'read_files', edit_many: 'edit_file', table_read: 'read_table',
  doc_read: 'read_docx', pdf_read: 'read_pdf', sdk: 'load_sdk', discover: 'discover_tools',
}

await test('every renamed raw name maps to its documented replacement', () => {
  assert.deepEqual(RENAMED_TOOLS, RENAMES)
  for (const [oldName, newName] of Object.entries(RENAMES)) {
    assert.equal(migrateRawName(oldName), newName)
    assert.equal(migrateRawName(newName), newName, 'a new name must be stable')
  }
  assert.equal(migrateRawName('grep'), 'grep', 'unknown names pass through unchanged')
  assert.deepEqual(migrateRawNames(['read_many', 'read_files', 'edit_many']), ['read_files', 'edit_file'])
})

await test('saved discovery pools accept old names, deduplicate, and still reject unknown names', () => {
  const config = resolveDiscoveryConfig({ allowedTools: ['table_read', 'edit_many', 'glob'] })
  assert.deepEqual(config.allowedTools, ['read_table', 'edit_file', 'glob'])
  assert.deepEqual(resolveDiscoveryConfig({ alwaysLoaded: ['doc_read', 'read_docx'] }).alwaysLoaded, ['read_docx'])
  // read_files is now discoverable; old and current spellings select one capability.
  assert.deepEqual(resolveDiscoveryConfig({ allowedTools: ['read_many', 'read_files'] }).allowedTools, ['read_files'])
  assert.throws(() => resolveDiscoveryConfig({ allowedTools: ['definitely_not_a_tool'] }), /unavailable capability/)
})

await test('saved PTC pools accept old names and never expose a duplicate entry', () => {
  const config = parsePtcConfig({ allowedTools: ['read_many', 'edit_many'], alwaysLoaded: ['read_many'] })
  assert.deepEqual(config.allowedTools, ['read_files', 'edit_file'])
  assert.deepEqual(config.alwaysLoaded, ['read_files'])
  assert.throws(() => parsePtcConfig({ allowedTools: ['not_a_tool'] }), /unsupported API/)
})

await test('select: and SDK requests resolve a pre-rename public name', () => {
  assert.deepEqual(search('select:ops_read_many', ['read_files', 'stat'], 5), ['read_files'])
  assert.deepEqual(search('select:ops_edit_many', ['edit_file', 'stat'], 5), ['edit_file'])
  assert.deepEqual(search('select:ops_stat', ['read_files', 'stat'], 5), ['stat'])
  assert.deepEqual(search('select:ops_missing_tool', ['read_files', 'stat'], 5), [])
  assert.deepEqual(requestedApis({ tools: ['read_many', 'edit_many'] }, ['read_files', 'edit_file']), ['read_files', 'edit_file'])
  assert.deepEqual(requestedApis({ tools: ['read_many', 'read_files'] }, ['read_files']), ['read_files'])
  assert.equal(typeof requestedApis({ tools: ['missing_tool'] }, ['read_files']), 'string')
})

report('compat-alias')
