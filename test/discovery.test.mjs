import { getEncoding } from 'js-tiktoken'
import { resolveDiscoveryConfig } from '../lib/config.js'
import { DISCOVERABLE_TOOLS } from '../lib/discovery/config.js'
import { parseRequest, search } from '../lib/discovery/search.js'
import { DISCOVERY_PARAMETERS, DISCOVERY_DESCRIPTION } from '../lib/capabilities/discovery.js'
import { publicToolName } from '../lib/policy.js'
import { assert, test, report, withTempDir, waitFor } from './lib/harness.mjs'
import { NativeFileTools } from '../lib/file/runtime.js'
import { discoveryMountChecks } from './lib/discovery.mjs'

await test('discovery config validates its own keys and copies bounded operator selections', () => {
  const config = resolveDiscoveryConfig()
  assert.equal(config.enabled, true)
  assert.equal(config.maxResults, 3)
  assert.deepEqual(config.allowedTools, DISCOVERABLE_TOOLS)
  assert.deepEqual(config.alwaysLoaded, [])
  const input = { allowedTools: ['stat', 'stat'], alwaysLoaded: ['stat'] }
  const selected = resolveDiscoveryConfig(input)
  input.allowedTools.push('diff')
  assert.deepEqual(selected.allowedTools, ['stat'])
  for (const raw of [null, [], false, { enabled: 1 }, { maxResults: 0 }, { maxResults: 6 }, { maxResults: 1.5 }, { maxResults: null }, { allowedTools: ['unknown_document_reader'] }, { alwaysLoaded: ['stat'], allowedTools: [] }]) assert.throws(() => resolveDiscoveryConfig(raw))
  assert.throws(() => resolveDiscoveryConfig({ allowedTool: [] }), /unknown discovery key: allowedTool/)
})
await test('discovery arguments enforce max_results 1-5 and reject hidden action payloads', () => {
  for (const max_results of [1, 2, 3, 4, 5]) assert.deepEqual(parseRequest({ query: 'STAT', max_results }), { query: 'stat', maxResults: max_results })
  for (const raw of [null, {}, { query: '' }, { query: 'a'.repeat(513) }, { query: 'stat', path: 'file' }, ...[0, 6, 1.5, null, '3'].map(max_results => ({ query: 'stat', max_results }))]) assert.equal(typeof parseRequest(raw), 'string')
  assert.deepEqual(search('select:ops_stat', DISCOVERABLE_TOOLS, 5), ['stat'])
  assert.deepEqual(search('metadata revision hash', DISCOVERABLE_TOOLS, 1), ['stat'])
  assert.deepEqual(search('select:ops_read_pdf', DISCOVERABLE_TOOLS, 5), ['read_pdf'])
})
await test('discovery-entry schema has a reproducible pinned token measurement, separate from the full BM-03 gate', () => {
  const wire = JSON.stringify([{ name: publicToolName('discover_tools'), description: DISCOVERY_DESCRIPTION, parameters: DISCOVERY_PARAMETERS }])
  const tokens = getEncoding('cl100k_base').encode(wire).length
  console.log(`  discovery schema: ${tokens} cl100k_base tokens, ${Buffer.byteLength(wire)} UTF-8 bytes; js-tiktoken 1.0.21; compact JSON name/description/parameters; not provider billing or the whole OPS surface`)
  assert.equal(tokens, 114)
})
await test('scoped file cancellation aborts active workers and disposal waits for their completion', () => withTempDir('discovery-cancel', async dir => {
  let spawned, complete
  const done = new Promise(resolve => { complete = resolve })
  const ctx = { get(name) {
    if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: dir }) }
    if (name === 'subprocess') return { spawn(options) {
      spawned = options
      return { done, collected: { stdout: { readFrom: () => ({ text: '{}', lossy: false }) }, stderr: { readFrom: () => ({ text: '', lossy: false }) } } }
    } }
  } }
  const runtime = new NativeFileTools({ ctx, config: { workerPath: 'fixture', denyCredentialReads: false } })
  await runtime.start([])
  const call = runtime.call('stat', { path: '.' }, { agent: { session: { id: 'cancel-test', header: { cwd: dir } } } })
  await waitFor(() => spawned)
  runtime.cancel('Authority changed')
  assert.equal(spawned.signal.aborted, true)
  let stopped = false
  const stopping = runtime.stop().then(() => { stopped = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(stopped, false, 'dispose must await worker completion, not AbortController values')
  complete({ exitCode: 1, signal: 'SIGTERM' })
  assert.equal((await call).error.code, 'RESULT_UNKNOWN')
  await stopping
  assert.equal(stopped, true)
  assert.equal(runtime.active.size, 0)
  assert.equal((await runtime.call('stat', { path: '.' }, {})).status, 'rejected')
}))
await discoveryMountChecks()
report('discovery')
