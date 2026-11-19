/** The D2 parsing contract: one explicit disclosure policy key on the PTC rows.
 *
 * #979 splits the two-tier OPS-PTC work into slices; this suite locks the D2
 * slice (#986): the row key `disclosurePolicy` ('on-demand' | 'full', default
 * 'on-demand' = the legacy path), its validation diagnostics, its survival
 * through the settings save path, and the conservative precedence taken for the
 * D1 sign-off item 2 — the explicit full tier never overrides the bundle
 * `dynamicTools` switch, and no save, upgrade or switch flip ever writes the
 * key for the user (#979 §4). Publication of the full tier itself is D3; every
 * assertion here is resolver-level only.
 */
import { assert, test, report } from './lib/harness.mjs'
import { parsePtcConfig } from '../lib/ptc/config.js'
import { modeConfigForm, modeFields, resolveModeConfig } from '../lib/modes/config.js'
import { Config, effectiveMode, hostConfig, resolveMergedConfig } from '../lib/settings/merged.js'
import { changedFields, readRowValues } from '../lib/client/row-schema.js'

await test('input class 1 (key absent): every surface keeps the legacy default and slice', () => {
  // The parsed contract gains a defaulted field; the effective slice and every
  // published surface stay letter-identical to the pre-D2 baseline.
  assert.equal(parsePtcConfig({}).disclosurePolicy, 'on-demand')
  for (const mode of ['minimal', 'standard', 'ptc', 'ops-ptc', 'cordis']) {
    assert.equal(resolveModeConfig({}, mode).disclosurePolicy, 'on-demand', mode)
  }
})

await test('input class 2 (legal value): on-demand and full parse and ride the settings path', () => {
  assert.equal(parsePtcConfig({ disclosurePolicy: 'on-demand' }).disclosurePolicy, 'on-demand')
  assert.equal(parsePtcConfig({ disclosurePolicy: 'full' }).disclosurePolicy, 'full')
  for (const mode of ['ptc', 'ops-ptc']) {
    assert.equal(resolveModeConfig({ disclosurePolicy: 'full' }, mode).disclosurePolicy, 'full', mode)
    assert.equal(resolveModeConfig({ disclosurePolicy: 'on-demand' }, mode).disclosurePolicy, 'on-demand', mode)
  }
  // D2 adds no settings-page field: the key stays YAML-only (the entry is D5).
  assert.equal('disclosurePolicy' in modeFields('ops-ptc'), false)
  assert.equal('disclosurePolicy' in Config.dict['ops-ptc'].dict, false)
})

await test('input class 3 (misspelled value): the diagnostic names the key and the value', () => {
  assert.throws(() => parsePtcConfig({ disclosurePolicy: 'ondemand' }), error => {
    assert.match(error.message, /disclosurePolicy must be "on-demand" or "full"/)
    assert.match(error.message, /"ondemand"/)
    return true
  })
})

await test('input class 4 (wrong type): the diagnostic names the key and the type', () => {
  for (const value of [true, 5, ['full']]) {
    assert.throws(() => parsePtcConfig({ disclosurePolicy: value }), error => {
      assert.match(error.message, /disclosurePolicy must be "on-demand" or "full"/)
      assert.match(error.message, new RegExp('\\b' + typeof value + '\\b'))
      return true
    }, JSON.stringify(value))
  }
})

await test('modes without a PTC surface reject the key with a readable diagnostic', () => {
  // The key names a PTC publication tier; a Native row carrying it is a config
  // mistake that must fail loud, not silently drift (the denyCredentialReads
  // precedent for cross-surface keys).
  for (const mode of ['minimal', 'standard', 'cordis']) {
    assert.throws(() => resolveModeConfig({ disclosurePolicy: 'full' }, mode),
      /disclosurePolicy applies to the ptc and ops-ptc rows only/, mode)
    assert.throws(() => resolveModeConfig({ disclosurePolicy: 'full' }, mode), /disclosurePolicy/, mode)
  }
})

await test('round trip: read → save an unrelated setting → read again keeps the explicit choice', () => {
  const raw = { 'ops-ptc': { disclosurePolicy: 'full', allowedTools: ['grep', 'stat'] } }
  const first = resolveMergedConfig(raw)
  assert.equal(first['ops-ptc'].config.disclosurePolicy, 'full')
  assert.equal(first['ops-ptc'].raw?.disclosurePolicy, 'full')
  // The host settings layer serializes through hostConfig and validates through
  // the row descriptor; both preserve the key.
  assert.equal(hostConfig(raw)['ops-ptc'].disclosurePolicy, 'full')
  assert.equal(Config['~standard'].validate(raw).value['ops-ptc'].disclosurePolicy, 'full')
  // The component's own settings descriptor keeps raw ordinary keys too.
  const form = modeConfigForm('ops-ptc')
  assert.equal(form['~standard'].validate({ disclosurePolicy: 'full' }).value.disclosurePolicy, 'full')
  // The page writes only the field the operator touched: saving panel capture
  // produces exactly one op and never touches the ops-ptc section.
  const draft = readRowValues(raw)
  draft['panel.enabled'] = true
  assert.deepEqual(changedFields(draft, raw), [{ op: 'set', path: ['panel', 'enabled'], value: true }])
  // The host applies that one op; reading again still sees the explicit choice.
  const after = resolveMergedConfig({ ...raw, panel: { enabled: true } })
  assert.equal(after['ops-ptc'].config.disclosurePolicy, 'full', 'the explicit selection is not lost')
  assert.deepEqual(after['ops-ptc'].config.allowedTools, ['grep', 'stat'])
})

await test('legacy configs never gain the key; the global switch never rewrites it', () => {
  // The D1 truth-table five inputs, each re-resolved on the new parsing path.
  const inputs = [
    {},
    { global: { dynamicTools: false } },
    { 'ops-ptc': { dynamicTools: false } },
    { 'ops-ptc': { dynamicTools: false, alwaysLoaded: ['stat'] } },
    { 'ops-ptc': { residentTools: false } },
  ]
  for (const raw of inputs) {
    const merged = resolveMergedConfig(raw)
    for (const mode of ['minimal', 'standard', 'ptc', 'ops-ptc', 'cordis']) {
      const slice = effectiveMode(merged[mode], merged.global)
      assert.equal('disclosurePolicy' in slice, false, 'the effective slice stays letter-identical', mode)
      assert.equal('disclosurePolicy' in (merged[mode].raw ?? {}), false, mode)
    }
    assert.equal(merged.ptc.config.disclosurePolicy, 'on-demand')
    assert.equal(merged['ops-ptc'].config.disclosurePolicy, 'on-demand')
    // hostConfig is the save-path serializer: it never auto-writes the key.
    const saved = hostConfig(raw)
    for (const mode of ['minimal', 'standard', 'ptc', 'ops-ptc', 'cordis']) {
      assert.equal('disclosurePolicy' in saved[mode], false, 'an upgrade or save never picks full for the user')
    }
  }
})

await test('the explicit full tier never overrides the bundle switch (sign-off item 2)', () => {
  const saved = { 'ops-ptc': { disclosurePolicy: 'full' } }
  const on = resolveMergedConfig(saved)
  assert.equal(effectiveMode(on['ops-ptc'], on.global).disclosurePolicy, 'full')
  assert.equal(resolveModeConfig(effectiveMode(on['ops-ptc'], on.global), 'ops-ptc').disclosurePolicy, 'full')
  const off = resolveMergedConfig({ global: { dynamicTools: false }, ...saved })
  // The saved intent is kept; only the effective slice stops applying, exactly
  // like the existing dynamicTools AND gate keeps the operator's intent.
  assert.equal(off['ops-ptc'].config.disclosurePolicy, 'full')
  assert.equal(off['ops-ptc'].raw?.disclosurePolicy, 'full')
  assert.equal(hostConfig({ global: { dynamicTools: false }, ...saved })['ops-ptc'].disclosurePolicy, 'full')
  assert.equal(effectiveMode(off['ops-ptc'], off.global).disclosurePolicy, 'on-demand', 'the bundle switch keeps its veto')
  assert.equal(resolveModeConfig(effectiveMode(off['ops-ptc'], off.global), 'ops-ptc').disclosurePolicy, 'on-demand')
  assert.equal(effectiveMode(off['ops-ptc'], off.global).dynamicTools, false)
  // The row switch keeps its loader-only meaning; the full tier publishes no
  // loader, so a row that also turns the loader off keeps its explicit tier.
  const rowOff = resolveMergedConfig({ 'ops-ptc': { disclosurePolicy: 'full', dynamicTools: false } })
  assert.equal(effectiveMode(rowOff['ops-ptc'], rowOff.global).disclosurePolicy, 'full')
  // Flipping the global switch alone never writes the key anywhere.
  for (const global of [{ dynamicTools: false }, { dynamicTools: true }]) {
    const flipped = resolveMergedConfig({ global })
    assert.equal('disclosurePolicy' in (flipped['ops-ptc'].raw ?? {}), false, JSON.stringify(global))
  }
})

report('ptc-disclosure-policy')
