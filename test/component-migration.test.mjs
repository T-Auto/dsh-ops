/** A saved eight-row profile refreshes into the one-row bundle without rewriting it. */
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { assert, test, report, PACKAGE_ROOT, waitFor } from './lib/harness.mjs'
import { componentProfile } from './lib/component-profile.mjs'
import { shutdown } from './lib/host.mjs'
const current = fs.readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')
/**
 * The 0.5.x eight-row fixture. Frozen here (not read from git history) because it
 * is the input the merge has to keep tolerating: saved overrides for rows that no
 * longer exist must be skipped, never fatal, and never rewritten in place.
 */
const LEGACY_ROWS = [
  { id: 'dsh-ops-mode-minimal', name: 'dsh-ops/mode-minimal', config: { promptPolicy: true } },
  { id: 'dsh-ops-mode-standard', name: 'dsh-ops/mode-standard', config: { promptPolicy: true, required: false } },
  { id: 'dsh-ops-discovery', name: 'dsh-ops/discovery', config: { enabled: true, maxResults: 3 } },
  { id: 'dsh-ops-compat', name: 'dsh-ops/compat', disabled: true },
  { id: 'dsh-ops-panel', name: 'dsh-ops/panel', disabled: true, config: { capture: true, textLimit: 777 } },
  { id: 'dsh-ops-tui', name: 'dsh-ops/tui', disabled: true, config: { maxSessions: 32 } },
]
const previous = JSON.stringify([{ insert: LEGACY_ROWS }])

await test('a saved eight-row profile composes the one row and keeps its overrides untouched', async () => {
  const choices = LEGACY_ROWS.map((row, index) => ({ id: row.id, name: row.name, disabled: index % 2 === 0,
    config: { ...row.config, ...(row.id === 'dsh-ops-panel' ? { textLimit: 777 } : {}) } }))
  const foreign = { insert: [{ id: 'theme-sentinel', name: 'cordis:fixtureTheme', config: { preference: 'dark', fontSize: 17 } }] }
  const fixture = componentProfile('merge-legacy', previous, [...choices, foreign])
  const original = fs.readFileSync(fixture.profile.patchPath, 'utf8')
  const check = (host, expectMerged) => {
    const rows = host.entries()
    const merged = rows.filter(entry => entry.options.id === 'dsh-ops')
    assert.equal(merged.length, expectMerged ? 1 : 0, 'the merged row is composed exactly once the bundle ships it')
    // Saved overrides for retired rows are tolerated: they either compose as inert
    // rows or stay unapplied, but they never become fatal and never get rewritten.
    for (const choice of choices) assert.ok(fs.readFileSync(fixture.profile.patchPath, 'utf8').includes(choice.id), `${choice.id} stays in the operator's patch`)
    const theme = [...host.ctx.loader.entries()].find(entry => entry.options.id === 'theme-sentinel')
    assert.deepEqual(theme.options.config, foreign.insert[0].config, 'foreign rows survive the merge')
    assert.equal(fs.readFileSync(fixture.profile.patchPath, 'utf8'), original, 'the merge never rewrites saved overrides')
  }
  let host = await fixture.boot('linux')
  try {
    check(host, false)
    fs.writeFileSync(fixture.bundlePath, current)
    await host.refresh(); check(host, true)
    await shutdown(host.ctx)
    host = await fixture.boot('linux')
    check(host, true)
  } finally { await shutdown(host.ctx) }
})

await test('a fresh profile composes the one row with the bundle defaults', async () => {
  const fixture = componentProfile('merge-fresh', current)
  const host = await fixture.boot('linux')
  try {
    assert.deepEqual(host.entries().map(entry => entry.options.id), ['dsh-ops'])
    assert.equal(fs.readFileSync(fixture.profile.patchPath, 'utf8'), '[]', 'startup does not write a composed tree')
    const config = host.entries()[0].options.config
    for (const feature of ['minimal', 'standard', 'ptc', 'cordis', 'discovery']) assert.equal(config[feature].enabled, true, feature)
    for (const feature of ['panel', 'tui']) assert.equal(config[feature].enabled, false, feature)
  } finally { await shutdown(host.ctx) }
})

await test('the panel feature starts collection only when its own switch and capture are on', async () => {
  const cwd = fs.mkdtempSync(path.join(tmpdir(), 'dsh-ops-panel-merged-'))
  const fixture = componentProfile('merge-panel', current)
  const host = await fixture.boot()
  const emit = id => host.ctx.emit('session/event', { id, header: { cwd } }, { type: 'user/message', seq: 0, time: 1,
    data: { content: [{ type: 'text', text: 'merged panel row' }] } })
  const dir = path.join(cwd, '.dsh-ops/panel')
  try {
    emit('default-off')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(fs.existsSync(dir), false, 'the feature is off by default')
    // Disabled capture inside an enabled feature stays inert, exactly as the row
    // switch used to; enabling both starts collection.
    fs.writeFileSync(fixture.profile.patchPath, JSON.stringify([{ id: 'dsh-ops', config: { panel: { enabled: true, capture: false } } }]))
    await host.refresh(); emit('capture-off')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(fs.existsSync(dir), false)
    fs.writeFileSync(fixture.profile.patchPath, JSON.stringify([{ id: 'dsh-ops', config: { panel: { enabled: true, capture: true } } }]))
    await host.refresh(); emit('capture-on')
    await waitFor(() => fs.existsSync(path.join(dir, 'capture-on.ndjson')))
  } finally { await shutdown(host.ctx); fs.rmSync(cwd, { recursive: true, force: true }) }
})
report('component-migration')
