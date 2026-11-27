import fs from 'node:fs'
import path from 'node:path'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { parseToolIndex, searchToolIndex, loadToolIndex } from '../lib/ptc/tool-index.js'

await test('OPS index rejects unknown executors, duplicate ids and oversized metadata', () => {
  const entry = { id: 'alpha', name: 'Alpha', description: 'Find files', executor: 'glob' }
  assert.deepEqual(parseToolIndex({ version: 1, tools: [entry] }, 'fixture'), [entry])
  assert.throws(() => parseToolIndex({ version: 1, tools: [{ ...entry, executor: 'bash' }] }, 'fixture'), /built-in OPS executor/u)
  assert.throws(() => parseToolIndex({ version: 1, tools: [entry, entry] }, 'fixture'), /duplicate id/u)
  assert.throws(() => parseToolIndex({ version: 1, tools: [{ ...entry, description: 'x'.repeat(2049) }] }, 'fixture'), /description/u)
  assert.throws(() => parseToolIndex({ version: 2, tools: [] }, 'fixture'), /version 1/u)
})

await test('OPS index search ranks matching entries and bounds result count', () => {
  const entries = parseToolIndex({ version: 1, tools: [
    { id: 'read', name: 'Read files', description: 'Read workspace text', executor: 'read_files' },
    { id: 'search', name: 'Search files', description: 'Search workspace text', executor: 'grep' },
    { id: 'list', name: 'List paths', description: 'Find workspace paths', executor: 'glob' },
  ] }, 'fixture')
  const result = searchToolIndex({ entries, sourceCount: 1 }, 'workspace files', 2)
  assert.deepEqual(result.map(item => item.id), ['read', 'search'])
  assert.deepEqual(searchToolIndex({ entries, sourceCount: 1 }, 'no-match'), [])
})

await test('user catalog stays separate, cannot shadow OPS ids, and is loaded from DSH home', async () => {
  await withTempDir('tool-index', async home => {
    process.env.DSH_HOME = home
    const directory = path.join(home, 'catalogs')
    fs.mkdirSync(directory)
    const userFile = path.join(directory, 'custom.json')
    fs.writeFileSync(userFile, JSON.stringify({ version: 1, tools: [
      { id: 'my-search', name: 'My Search', description: 'Search code', executor: 'grep' },
    ] }))
    const loaded = loadToolIndex({ userFile: 'catalogs/custom.json' })
    assert.equal(loaded.sourceCount, 2)
    assert.ok(loaded.entries.some(item => item.id === 'inspect'))
    assert.ok(loaded.entries.some(item => item.id === 'my-search'))
    fs.writeFileSync(userFile, JSON.stringify({ version: 1, tools: [
      { id: 'inspect', name: 'Override', description: 'No', executor: 'grep' },
    ] }))
    assert.throws(() => loadToolIndex({ userFile: 'catalogs/custom.json' }), /cannot shadow OPS/u)
    assert.throws(() => loadToolIndex({ userFile: '../outside.json' }), /under the DSH home/u)
  })
})
report('tool-index')
