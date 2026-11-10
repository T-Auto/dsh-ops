/**
 * The ops-ptc preset fragment and the generator that keeps it honest.
 *
 * dsh-ops enhances presets the host already declares, so the ops-ptc preset is a
 * patch fragment of its own. The fragment is generated from the installed host
 * bundle; this suite proves the shipped bytes are the ones the generator would
 * produce, and that an unresolvable upstream fails loudly instead of pretending
 * the fragment is current.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { assert, test, report, PACKAGE_ROOT } from './lib/harness.mjs'
import {
  DEFAULT_OUT,
  FRAGMENT_PATH,
  PRESET_ID,
  PRESET_ORDER,
  ROW_ID,
  generateFragment,
  inspectFragment,
  resolveSource,
  sha256,
} from '../scripts/sync-preset-ops-ptc.mjs'

const fragmentFile = path.join(PACKAGE_ROOT, FRAGMENT_PATH)
const text = fs.readFileSync(fragmentFile, 'utf8')
/** The official PTC preset the fragment is generated from, when this checkout can see it. */
let source
try { source = resolveSource() } catch (error) { source = { error } }
const script = path.join(PACKAGE_ROOT, 'scripts', 'sync-preset-ops-ptc.mjs')
const check = () => spawnSync(process.execPath, [script, '--check'], { cwd: PACKAGE_ROOT, encoding: 'utf8', timeout: 60_000 })

await test('the fragment declares the ops-ptc identity and records its upstream checksum', () => {
  assert.equal(FRAGMENT_PATH, 'presets/ops-ptc.patch.yml')
  assert.equal(DEFAULT_OUT, fragmentFile)
  assert.ok(fs.existsSync(fragmentFile))
  const recorded = /^# Source sha256: ([0-9a-f]{64})$/m.exec(text)
  assert.ok(recorded, 'the header records the source sha256 so drift is detectable')
  assert.match(text, /do not edit by hand/i)
  // inspectFragment parses the document (keeping !!js expressions) and refuses a
  // fragment whose row id, plugin, preset identity or order drifts.
  const { pluginCount } = inspectFragment(text)
  assert.equal(PRESET_ID, 'ops-ptc')
  assert.equal(ROW_ID, 'preset-ops-ptc')
  assert.ok(PRESET_ORDER > 2, 'the preset sorts after the official ptc row (order 2)')
  assert.ok(pluginCount >= 20, 'the fragment carries the upstream plugin list, not a stub')
})

await test('the fragment is exactly what the installed host preset generates', () => {
  if (source.error !== undefined) {
    // No installed host bundle in this dependency graph (CI installs the plugin,
    // not the harness). The generator's contract for that state is a loud
    // failure: prove it refuses to verify nothing instead of exiting 0.
    const result = check()
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /cannot locate/)
    assert.match(result.stderr, /--source/)
    return
  }
  const sourceText = fs.readFileSync(source.file, 'utf8')
  const header = /^# Source sha256: ([0-9a-f]{64})$/m.exec(text)
  assert.equal(header[1], sha256(sourceText), 'the recorded checksum names the current upstream bytes')
  // generateFragment applies the identity transform and refuses body drift; the
  // committed file must be byte-identical to its output.
  const generated = generateFragment(sourceText)
  assert.equal(generated.text, text)
  const result = check()
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout + result.stderr, /up to date/)
})

report('preset-fragment')
