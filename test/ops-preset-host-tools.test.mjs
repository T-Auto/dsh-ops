/**
 * A preset can ask for an OPS-only file surface even when its mode publishes no native file tools.
 *
 * The PTC plan replaces nothing and publishes no native file surface, so before this switch a row
 * could set hideOfficialTools:true and still keep read/glob/grep visible: the replacement list was
 * gated on plan.nativeFiles. The switch moves that decision to the preset instead of the mode.
 */
import { resolveModeConfig } from '../lib/presets/config.js'
import { replacementTargets } from '../lib/consumer/replacements.js'
import { MODE_PLANS } from '../lib/presets/defaults.js'
import { assert, report, test } from './lib/harness.mjs'

await test('the switch replaces host file tools without a native file surface', () => {
  // Off by default: the shipped ptc preset must keep its official tools.
  assert.equal(resolveModeConfig({}).replaceHostTools, false)
  assert.equal(resolveModeConfig({ hideOfficialTools: true }).replaceHostTools, false)
  assert.equal(resolveModeConfig({ replaceHostTools: true }).replaceHostTools, true)
  assert.throws(() => resolveModeConfig({ replaceHostTools: 'yes' }), /replaceHostTools must be boolean/)

  // The mode itself is unchanged: replacements stay empty and there is still no native surface,
  // so the switch (not the mode) is what turns the mapping on.
  assert.deepEqual([...MODE_PLANS.ptc.replacements], [])
  assert.equal(MODE_PLANS.ptc.nativeFiles, false)

  // The map the switch feeds, resolved through the same reviewed catalogue.
  const targets = replacementTargets(true, false, 'win32')
  assert.equal(targets.get('read'), 'ops_inspect_local_file')
  assert.equal(targets.get('glob'), 'ops_glob')
  assert.equal(targets.get('grep'), 'ops_grep')
  // write and edit have no reviewed counterpart, so they must never be hidden this way.
  assert.equal(targets.has('write'), false)
  assert.equal(targets.has('edit'), false)
  assert.equal(targets.size, 3)
})

report('ops-preset-host-tools')
