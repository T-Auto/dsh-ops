import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { assert, test, report, withTempDir, PACKAGE_ROOT } from './lib/harness.mjs'
import { bashIntegrityReport, integrityLabel } from '../lib/cli/integrity.js'

await test('label parsing preserves unknown and never treats failure as Medium', () => {
  assert.deepEqual(integrityLabel(''), { label: 'unlabeled', rid: null })
  assert.deepEqual(integrityLabel('S:AINO_ACCESS_CONTROL'), { label: 'unlabeled', rid: null })
  assert.deepEqual(integrityLabel('S:(ML;OICI;NW;;;LW)'), { label: 'low', rid: 4096 })
  assert.deepEqual(integrityLabel('S:(ML;;NW;;;S-1-16-8192)'), { label: 'medium', rid: 8192 })
  assert.equal(integrityLabel('not a descriptor').label, 'unknown')
  assert.equal(integrityLabel('S:(ML;;NW;;;LW)(ML;;NW;;;ME)').label, 'unknown')
})

await test('ladder separates actual Low image/ancestor labels from static compatibility', () => withTempDir('ladder-integrity', root => {
  const image = path.join(root, 'label fixture 字', 'bin', 'bash.exe')
  const actual = path.join(root, 'label fixture 字', 'usr', 'bin', 'bash.exe')
  fs.mkdirSync(path.dirname(image), { recursive: true })
  fs.mkdirSync(path.dirname(actual), { recursive: true })
  if (process.platform === 'win32') fs.copyFileSync(path.join(process.env.SystemRoot, 'System32', 'where.exe'), image)
  else fs.writeFileSync(image, 'not executed')
  fs.copyFileSync(image, actual)
  const config = path.join(root, 'config.json')
  fs.writeFileSync(config, JSON.stringify({ bashPath: image }))
  const run = json => {
    const result = spawnSync(process.execPath, [path.join(PACKAGE_ROOT, 'bin/dsh-ops.mjs'), 'ladder', '--config', config, ...(json ? ['--json'] : [])], { encoding: 'utf8', timeout: 20_000, windowsHide: true })
    assert.equal(result.status, 0, result.stderr)
    return json ? JSON.parse(result.stdout) : result.stdout
  }
  const before = run(true)
  if (process.platform !== 'win32') {
    assert.equal(before.shells.bash.integrity.status, 'not-applicable')
    return
  }
  assert.equal(before.shells.bash.integrity.entries.find(entry => entry.path === image).label, 'unlabeled', JSON.stringify(before.shells.bash.integrity))
  assert.equal(before.shells.bash.integrity.entries.find(entry => entry.path === actual).label, 'unlabeled', 'the wrapper and actual image are inspected separately')
  // Only our temporary copies change labels. Neither the installed image nor user data is touched.
  for (const target of [image, path.dirname(image)]) {
    assert.ok(path.resolve(target).startsWith(path.resolve(root) + path.sep))
    const lowered = spawnSync('icacls.exe', [target, '/setintegritylevel', 'Low'], { encoding: 'utf8', windowsHide: true })
    assert.equal(lowered.status, 0, lowered.stdout + lowered.stderr)
  }
  const after = run(true)
  const integrity = after.shells.bash.integrity
  assert.equal(integrity.entries.find(entry => entry.path === image).label, 'low')
  assert.equal(integrity.entries.find(entry => entry.path === actual).label, 'unlabeled', 'an ancestor warning does not guess the other image label')
  assert.equal(integrity.entries.find(entry => entry.path === path.dirname(image)).label, 'low')
  assert.ok(integrity.warnings.some(text => /image.*Low/i.test(text)))
  assert.ok(integrity.warnings.some(text => /ancestor.*inherit/i.test(text)))
  assert.deepEqual(after.shells.bash.restricted, before.shells.bash.restricted, 'file labels do not change hash compatibility')
  assert.match(run(false), /Low.*write.*Medium/i)
  assert.equal(fs.readFileSync(image).equals(fs.readFileSync(path.join(process.env.SystemRoot, 'System32', 'where.exe'))), true, 'querying labels never changes executable bytes')
}))

await test('unreadable paths and real ConstrainedLanguage return unknown, with no privilege changes', () => withTempDir('integrity-unknown', root => {
  const missing = path.join(root, 'missing.exe')
  const result = bashIntegrityReport(missing)
  if (process.platform !== 'win32') { assert.equal(result.status, 'not-applicable'); return }
  assert.equal(result.status, 'partial')
  assert.equal(result.entries[0].label, 'unknown')
  assert.ok(result.entries[0].reason)
  const script = "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage';\n" + fs.readFileSync(path.join(PACKAGE_ROOT, 'lib/cli/integrity-labels.ps1'), 'utf8')
  const clm = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
  assert.equal(clm.status, 0, clm.stderr)
  assert.match(JSON.parse(clm.stdout).error, /ConstrainedLanguage/)
  assert.equal(JSON.parse(clm.stdout).entries, undefined, 'no invented clean labels under a denied query')
}))
report('cli-integrity')
