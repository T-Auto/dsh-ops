/** Shared catalogue facts must reach publication, configuration and native dispatch. */
import fs from 'node:fs'
import { CAPABILITIES, FILE_CAPABILITIES, PTC_CAPABILITIES, CONTINUATION_TOOLS, OBSERVED_READ_TOOLS, PTC_RESIDENT_TOOLS, DISCOVERY_TOOL_NAME } from '../lib/capabilities/registry.js'
import { PTC_RESIDENT_TOOLS as actualResidents, PTC_LOADABLE_TOOLS } from '../lib/ptc/config.js'
import { RAW_OFFICIAL_REPLACEMENTS, OFFICIAL_REPLACEMENT_NAMES } from '../lib/capabilities/replacements.js'
import { OFFICIAL_REPLACEMENTS } from '../lib/official-tool-catalog.js'
import { Config as shellConfig, NON_EDITABLE_CONFIG_KEYS } from '../lib/components/shell/index.js'
import { Config as discoveryConfig } from '../lib/components/discovery/index.js'
import { CORE_CONFIG_KEYS, resolveDiscoveryConfig } from '../lib/config.js'
import { DISCOVERY_CONFIG_KEYS } from '../lib/discovery/config.js'
import { resolvePanelConfig } from '../lib/components/panel/index.js'
import { resolveTuiConfig } from '../lib/components/tui/index.js'
import { publicToolName, renderToolingPolicy } from '../lib/policy.js'
import { decodeContinuation } from '../lib/modes/ptc/continuation.js'
import { componentChecks, defaultChecks } from '../scripts/lib/catalogue-checks.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { requireWorker, callTool, envelopeOf } from './lib/boundary.mjs'
requireWorker('catalogue-consistency')

await test('adapter publication and retrieval classes agree with the catalogue', () => {
  assert.equal(actualResidents, PTC_RESIDENT_TOOLS)
  assert.deepEqual(actualResidents, ['inspect_local_file', 'result'])
  assert.deepEqual(PTC_LOADABLE_TOOLS, [...FILE_CAPABILITIES, ...PTC_CAPABILITIES].filter(entry => entry.ptcAvailability === 'discoverable').map(entry => entry.rawName))
  assert.deepEqual(CAPABILITIES.filter(entry => entry.ptcAvailability === 'resident').map(entry => entry.rawName), ['inspect_local_file', 'result', 'load_sdk'])
  assert.deepEqual(OBSERVED_READ_TOOLS, ['inspect_local_file', 'read_files'])
  for (const entry of CAPABILITIES) {
    const token = 'ops-next-v1:' + JSON.stringify({ version: 1, tool: entry.rawName, args: entry.rawName === 'result' ? { action: 'page' } : {} })
    assert.equal(Boolean(decodeContinuation(token)), CONTINUATION_TOOLS.includes(entry.rawName), entry.rawName)
  }
  assert.match(renderToolingPolicy({ published: [publicToolName(DISCOVERY_TOOL_NAME)] }), new RegExp(publicToolName(DISCOVERY_TOOL_NAME)))
})

await test('replacement choices have one browser-safe raw-name source', () => {
  assert.deepEqual(OFFICIAL_REPLACEMENT_NAMES, Object.keys(OFFICIAL_REPLACEMENTS))
  for (const name of OFFICIAL_REPLACEMENT_NAMES) assert.equal(OFFICIAL_REPLACEMENTS[name], publicToolName(RAW_OFFICIAL_REPLACEMENTS[name]))
})

await test('every accepted settings field is described or explicitly excluded', () => {
  assert.deepEqual([...Object.keys(shellConfig.dict), ...NON_EDITABLE_CONFIG_KEYS].sort(), [...CORE_CONFIG_KEYS].sort())
  assert.deepEqual(Object.keys(discoveryConfig.dict).sort(), [...DISCOVERY_CONFIG_KEYS].sort())
  for (const [config, input] of [[shellConfig, { allowSystemShellFallback: true }], [discoveryConfig, { required: true, denyCredentialReads: false, binaryPath: 'fixture' }]]) {
    const normalized = config['~standard'].validate(input)
    assert.equal(normalized.issues, undefined)
    for (const [key, value] of Object.entries(input)) {
      assert.equal(config.dict[key].meta.volatile, true)
      assert.equal(normalized.value[key], value)
    }
  }
})

await test('component declaration checks reject entry, target, tool, default and command drift', () => {
  const rows = JSON.parse(fs.readFileSync(new URL('../dsh-plugin.json', import.meta.url))).contributes['x-components']
  const failed = values => componentChecks(values).filter(([okay]) => !okay)
  assert.deepEqual(failed(rows), [])
  for (const [id, key, value] of [
    ['shell', 'entry', 'wrong'], ['file', 'targets', []], ['discovery', 'tools', []],
    ['panel', 'tools', ['rogue']], ['tui', 'defaultEnabled', true], ['hide-official', 'retainedOfficialCommand', { win32: 'bash' }],
  ]) {
    const changed = structuredClone(rows)
    changed.find(row => row.id === `dsh-ops-${id}`)[key] = value
    assert.ok(failed(changed).length > 0, `${id}.${key}`)
  }
})

await test('valid but mismatched panel, TUI and discovery defaults fail the declaration gate', () => {
  for (const [name, resolve, key, changed] of [['panel', resolvePanelConfig, 'textLimit', 4000], ['tui', resolveTuiConfig, 'recentLimit', 4], ['discovery', resolveDiscoveryConfig, 'maxResults', 4]]) {
    const value = resolve({})[key]
    assert.ok(defaultChecks(name, { [key]: value }, resolve).every(([okay]) => okay))
    resolve({ [key]: changed }) // a merely valid value must not be confused with the default
    assert.equal(defaultChecks(name, { [key]: changed }, resolve)[0][0], false)
  }
})

await test('every catalogue worker name reaches an implemented Rust dispatch branch', () => withTempDir('catalogue-dispatch', async root => {
  const unknown = envelopeOf(await callTool('not_a_capability', {}, { root }), assert)
  assert.match(unknown.error.message, /Unknown capability/)
  for (const entry of [...FILE_CAPABILITIES, ...PTC_CAPABILITIES]) {
    const value = envelopeOf(await callTool(entry.rawName, {}, { root }), assert)
    assert.doesNotMatch(value.error?.message ?? '', /Unknown capability/, entry.rawName)
    assert.notEqual(value.error?.code, 'POLICY_DENIED', `${entry.rawName}: pre-dispatch denial hides coverage`)
  }
}))
report('catalogue-consistency')
