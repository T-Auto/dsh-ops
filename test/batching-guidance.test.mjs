/**
 * The batching guidance asset and the row switch that delivers it.
 *
 * The trigger itself lives in batching-trigger.test.mjs; this suite covers the shipped
 * Markdown, its loader contract, and the one row allowed to publish it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { assert, test, report, PACKAGE_ROOT } from './lib/harness.mjs'
import { BATCHING_GUIDANCE_ID, BATCHING_GUIDANCE_REVISION, loadBatchingGuidance } from '../lib/ptc/batching-guidance.js'

/** The editable guidance file shipped at the package root, outside the build output. */
const GUIDANCE_FILE = path.join(PACKAGE_ROOT, 'prompts', 'batching-guidance.md')

await test('the shipped guidance is English Markdown with its host-source identity', () => {
  // The wording is editable data, so pin its structure and the rules delivery relies on.
  const text = loadBatchingGuidance()
  for (const heading of ['# Batch tool calls', 'Core rules', 'Common mistakes', 'Promise.all', 'e.message']) {
    assert.ok(text.includes(heading), heading)
  }
  assert.equal(BATCHING_GUIDANCE_ID, 'batching-guidance')
  // A wording or format change is a product change and must bump the revision.
  assert.equal(BATCHING_GUIDANCE_REVISION, '3')
})

await test('the guidance loader returns exactly the shipped Markdown file', () => {
  assert.equal(loadBatchingGuidance(), fs.readFileSync(GUIDANCE_FILE, 'utf8').trim())
  // Repeated loads serve the cache instead of reading the file again.
  assert.equal(loadBatchingGuidance(), loadBatchingGuidance())
})

await test('an unreadable guidance file degrades to an empty string without throwing', () => {
  const missing = path.join(PACKAGE_ROOT, 'prompts', 'missing-guidance.md')
  let text
  assert.doesNotThrow(() => { text = loadBatchingGuidance(missing) })
  assert.equal(text, '')
  // The failure is cached as well, so later deliveries stay silent.
  assert.equal(loadBatchingGuidance(missing), '')
})

await test('the ops-ptc row is the one row configured to deliver the guidance', async () => {
  const { parse } = await import('yaml')
  const { resolveMergedConfig } = await import('../lib/settings/merged.js')
  const { resolveModeConfig } = await import('../lib/modes/config.js')
  const { modeGate } = await import('../lib/presets/builtin.js')
  // Default off everywhere; only the row-level YAML switch turns it on.
  const defaults = resolveMergedConfig()
  for (const mode of ['minimal', 'standard', 'ptc', 'cordis']) assert.equal(defaults[mode].config.batchingGuidance, false, mode)
  assert.equal(defaults['ops-ptc'].config.batchingGuidance, false)
  assert.equal(resolveModeConfig({ batchingGuidance: true }, 'ops-ptc').batchingGuidance, true)
  assert.throws(() => resolveModeConfig({ batchingGuidance: 'yes' }, 'ops-ptc'), /batchingGuidance must be boolean/)
  // The switch rides the consumer gate; a row that drops it cannot deliver.
  assert.equal(modeGate({}, 'ops-ptc', true).batching, true)
  assert.equal(modeGate({}, 'ops-ptc', false).batching, false)
  // The shipped bundle enables it for ops-ptc alone (the comparison arm).
  const patch = parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8'))
  const config = patch.flatMap(entry => entry.insert ?? [])[0].config
  assert.equal(config['ops-ptc'].batchingGuidance, true)
  for (const mode of ['minimal', 'standard', 'ptc', 'cordis']) assert.equal(Object.hasOwn(config[mode], 'batchingGuidance'), false, mode)
  assert.equal(resolveMergedConfig(config)['ops-ptc'].config.batchingGuidance, true)
  assert.equal(modeGate({}, 'ops-ptc', resolveMergedConfig(config)['ops-ptc'].config.batchingGuidance).batching, true)
  // The telemetry switch is diagnostics only: off by default, YAML-only, never context.
  assert.equal(resolveModeConfig({}).batchingTelemetry, false)
  assert.equal(resolveModeConfig({ batchingTelemetry: true }, 'ops-ptc').batchingTelemetry, true)
  assert.throws(() => resolveModeConfig({ batchingTelemetry: 'yes' }), /batchingTelemetry must be boolean/)
  assert.equal(modeGate({}, 'ops-ptc', true, true).telemetry, true)
  assert.equal(modeGate({}, 'ops-ptc', true).telemetry, false, 'an absent switch never turns observation on')
})

await test('the teacher trajectory pins the first-line plan and a runnable load step', () => {
  // The plan line is the mechanism, not decoration: it must be the first line of the
  // program, and every trajectory must stay copyable against the shipped SDK.
  const text = loadBatchingGuidance()
  assert.ok(text.includes('// plan:'), 'the plan directive is present')
  assert.ok((text.split('// plan:').length - 1) >= 5, 'every trajectory carries a plan line')
  assert.match(text, /first line of the program/, 'the plan line is pinned to the first line')
  for (const name of ['ops_glob', 'ops_grep', 'ops_read_files', 'ops_inspect_local_file']) {
    assert.ok(text.includes(name), name + ' is used by a trajectory')
  }
  assert.ok(text.includes('ops_load_sdk'), 'the load step is taught')
  assert.ok(text.includes('NEXT program'), 'the load lands on the next program')
  assert.ok(text.includes('128'), 'the per-program dispatch ceiling is stated')
  assert.ok(text.includes('nextOffset'), 'paging advances by the cursor')
  // File work belongs to the OPS APIs; a shell example here would teach the bypass.
  for (const banned of ['find .', 'ls -la', 'grep -rn']) assert.ok(!text.includes(banned), banned)
  assert.ok(text.length > 2500 && text.length < 9000, 'guidance stays bounded: ' + text.length)
})

report('batching-guidance')
