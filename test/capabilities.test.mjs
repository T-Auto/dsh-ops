/** Registry migration preserves the complete previously published host definitions. */
import { createHash } from 'node:crypto'
import { CAPABILITIES, NATIVE_FILE_TOOLS, NATIVE_RESIDENT_FILE_TOOLS, FILE_CAPABILITIES, PTC_CAPABILITIES, SHELL_CAPABILITIES, capability, capabilitiesFor } from '../lib/capabilities/registry.js'
import { FILE_TOOLS, FILE_MUTATIONS, IN_PROCESS_TOOLS, BASH_TOOL, publicToolName } from '../lib/policy.js'
import { definition as fileDefinition, PARAMETERS as fileParameters, DESCRIPTIONS as fileDescriptions } from '../lib/file/contract.js'
import { definition as ptcDefinition, PTC_TOOLS, PARAMETERS as ptcParameters, DESCRIPTIONS as ptcDescriptions } from '../lib/ptc/contract.js'
import { DISCOVERABLE_TOOLS } from '../lib/discovery/config.js'
import { NativeFileTools } from '../lib/file/runtime.js'
import { BASH_TOOL_NAME } from '../lib/shells/constants.js'
import { assert, test, report } from './lib/harness.mjs'

await test('the catalogue covers every owned file, PTC and shell tool exactly once', () => {
  assert.equal(CAPABILITIES.length, 20)
  assert.equal(new Set(CAPABILITIES.map(item => item.rawName)).size, CAPABILITIES.length)
  assert.deepEqual(FILE_TOOLS, ['inspect_local_file', 'grep', 'glob', 'replace', 'write_file', 'edit_file', 'diff', 'stat', 'copy', 'move', 'remove', 'read_files', 'read_table', 'read_docx', 'read_pdf'])
  assert.deepEqual(FILE_MUTATIONS, ['replace', 'write_file', 'edit_file', 'copy', 'move', 'remove'])
  assert.deepEqual(PTC_TOOLS, ['batch', 'result'])
  assert.deepEqual(IN_PROCESS_TOOLS, ['bash'])
  assert.equal(BASH_TOOL_NAME, BASH_TOOL)
  for (const [entries, parameters, descriptions] of [[FILE_CAPABILITIES, fileParameters, fileDescriptions], [PTC_CAPABILITIES, ptcParameters, ptcDescriptions]]) {
    assert.deepEqual(entries.map(item => item.rawName).sort(), Object.keys(parameters).sort())
    assert.deepEqual(Object.keys(parameters).sort(), Object.keys(descriptions).sort())
    for (const entry of entries) {
      assert.equal(capability(entry.rawName), entry)
      assert.equal(entry.parameters, parameters[entry.rawName])
      assert.equal(entry.description, descriptions[entry.rawName])
    }
  }
  for (const component of ['file', 'ptc', 'shell', 'discovery']) assert.deepEqual(capabilitiesFor(component), CAPABILITIES.filter(item => item.component === component))
  for (const name of ['unknown', 'toString', '__proto__']) assert.equal(capability(name), undefined)
})

await test('metadata separates the Native resident core from discoverable capabilities', () => {
  for (const entry of [...FILE_CAPABILITIES, ...SHELL_CAPABILITIES]) assert.deepEqual(entry.presentations, ['native', 'ptc', 'both'])
  for (const entry of PTC_CAPABILITIES) assert.deepEqual(entry.presentations, entry.rawName === 'result' ? ['native', 'ptc', 'both'] : ['ptc'])
  assert.deepEqual(NATIVE_RESIDENT_FILE_TOOLS, ['read_files'])
  assert.equal(capability('result').nativeProjection.availability, 'discoverable')
  assert.deepEqual(FILE_CAPABILITIES.filter(entry => entry.availability === 'discoverable').map(entry => entry.rawName).sort(), DISCOVERABLE_TOOLS.filter(name => name !== 'result').sort())
  for (const entry of CAPABILITIES) {
    assert.equal(entry.availability, entry.component === 'file' && entry.rawName !== 'read_files' ? 'discoverable' : 'resident')
    assert.equal(entry.concurrencySafe, entry.component === 'file' && !entry.mutates)
  }
})

// Parameter help evolves independently; preserve all structural validation constraints (#328).
const withoutDescriptions = value => Array.isArray(value) ? value.map(withoutDescriptions)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'description').map(([key, item]) => [key, withoutDescriptions(item)])) : value
const snapshot = (names, definition) => names.map(name => {
  const d = definition(name, async () => null)
  // Reference metadata was added in6d; preserve the earlier business argument/output snapshot.
  d.output.schema = structuredClone(d.output.schema)
  for (const key of ['reference', 'referenceRoot', 'root', 'source', 'storageError', 'nextAction']) {
    if (definition === fileDefinition) delete d.output.schema.properties[key]
  }
  return { name: d.name, description: d.description, parameters: withoutDescriptions(d.parameters), output: d.output.schema,
    concurrent: d.isConcurrencySafe?.({}) ?? false, timeoutMs: d.timeoutMs ?? null }
})
await test('business file and batch definitions retain their original serialized contracts', () => {
  // Captured before this migration, covering every argument/output contract and published description.
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  assert.equal(hash(snapshot(FILE_TOOLS.filter(name => !['glob', 'grep', 'read_files', 'edit_file', 'read_table', 'read_docx', 'read_pdf'].includes(name)), fileDefinition)), '0297e7d3f819dc90dcc296a5e4ee1af88c37b742ed7ca06c77c54a477c52eb4b')
  const batch = ptcDefinition('batch', async () => null)
  assert.equal(batch.parameters, ptcParameters.batch); assert.ok(batch.description.startsWith(ptcDescriptions.batch)); assert.match(batch.description, /PTC returns Outcome/)
  assert.ok(batch.output.schema.oneOf.every(branch => branch.properties.status))
})

await test('file parameter schemas preserve their reviewed structural constraints', () => {
  // #384 intentionally adds the optional exactTotal boolean; all other constraints remain pinned.
  const hash = createHash('sha256').update(JSON.stringify(withoutDescriptions(fileParameters))).digest('hex')
  assert.equal(hash, '637df1383940fa6fdb2d65a68e67ce1e333a7e2ecbfceff5ffef7a4c1133ea8b')
})

await test('native registration consumes the catalogue while execute values stay unchanged', async () => {
  const registered = [], disposed = []
  const runtime = new NativeFileTools({ ctx: { tools: { register(definition) {
    registered.push(definition); return () => disposed.push(definition.name)
  } } }, config: { workerPath: 'fixture-worker' } })
  assert.deepEqual(await runtime.start(), NATIVE_FILE_TOOLS.map(publicToolName))
  assert.deepEqual(registered.map(item => item.name), NATIVE_FILE_TOOLS.map(publicToolName))
  const canonical = { status: 'completed', items: [{ path: '/file', line: 1, text: 'text' }], complete: false }
  for (const [names, definition] of [[FILE_TOOLS, fileDefinition], [PTC_TOOLS, ptcDefinition]]) {
    for (const name of names) {
      const tool = definition(name, async () => canonical)
      const returned = await tool.execute({}, {})
      if (names === FILE_TOOLS) assert.equal(returned, canonical)
      else assert.equal(returned.data, canonical)
      assert.equal(canonical.items[0].path, '/file')
      if (names === PTC_TOOLS) assert.deepEqual(JSON.parse(tool.output.render({}, canonical)[0].text), canonical)
      else assert.equal(typeof tool.output.render({}, canonical)[0].text, 'string')
    }
  }
  await runtime.stop()
  assert.deepEqual(disposed.sort(), registered.map(item => item.name).sort())
})
await test('unstarted Native runtimes return an unavailable value before creating call state', async () => {
  const runtime = new NativeFileTools({ ctx: {}, config: { workerPath: 'fixture-worker' } })
  const value = await runtime.call('stat', { path: '.' }, {})
  assert.equal(value.error.code, 'EXECUTOR_UNAVAILABLE')
  assert.match(value.error.message, /worker path is unavailable/)
  assert.equal(runtime.active.size, 0)
})
report('capabilities')
