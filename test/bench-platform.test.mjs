import fs from 'node:fs'
import path from 'node:path'
import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { parseArgs as setupArgs } from '../bench/setup/profile.mjs'
import { preflight } from '../bench/setup/preflight.mjs'
import { compareSummaries } from '../bench/lib/compare-core.mjs'
import { main as compare, renderReport } from '../bench/compare.mjs'
import { componentFacts } from '../bench/lib/environment.mjs'
import { dumpProfileConfig, profileFingerprints } from '../bench/run.mjs'
import { main as setup } from '../bench/setup.mjs'

await test('POSIX setup never probes Windows module directories or pins PowerShell', () => {
  for (const platform of ['linux', 'darwin']) {
    const options = setupArgs(['--plugin', 'none', '--dry-run'], { platform })
    assert.equal(options.pinShell, null)
    const lines = []
    const result = preflight(options, { platform, log: line => lines.push(line),
      env: { PSModulePath: 'C:\\Core;C:\\Windows', SystemRoot: 'C:\\Windows' },
      isDirectory: () => { throw new Error('Windows probe on POSIX') } })
    assert.equal(result.outcomes.modulePath, 'skipped')
    assert.equal(result.problems.length, 0)
    assert.match(lines.join('\n'), /skipped.*Windows/)
  }
})

await test('platform mismatch refuses pairing before statistics, including A/A inputs', () => {
  const base = { meta: { platform: 'linux-x64' }, results: [] }
  const cand = { meta: { platform: 'darwin-arm64' }, results: [] }
  assert.throws(() => compareSummaries(base, cand), /linux-x64.*darwin-arm64/)
  assert.throws(() => compareSummaries(base, base, { noise: { base, cand } }), /platform/)
  const diagnostic = compareSummaries(base, cand, { allowCrossPlatform: true })
  assert.match(renderReport(diagnostic), /not a plugin effect/)
  assert.equal(diagnostic.environment.crossPlatform, true)
  assert.doesNotThrow(() => compareSummaries({ results: [] }, { results: [] }))
})

await test('compare CLI returns 2 for different platforms and requires an explicit override', async () => {
  await withTempDir('bench-platform-', async dir => {
    const files = ['base', 'cand'].map(name => path.join(dir, `${name}.json`))
    for (const [i, file] of files.entries()) fs.writeFileSync(file, JSON.stringify({ format: 'dsh-ops-bench-summary-v1', meta: { platform: ['linux-x64', 'win32-x64'][i] }, results: [] }))
    const lines = []
    const io = { out: line => lines.push(line), err: line => lines.push(line) }
    assert.equal(await compare([...files, '--out', '-'], io), 2)
    assert.match(lines.join('\n'), /linux-x64.*win32-x64/)
    lines.length = 0
    assert.equal(await compare([...files, '--out', '-', '--allow-cross-platform'], io), 0)
    assert.match(lines.join('\n'), /not a plugin effect/)
  })
})

await test('composed component facts distinguish disabled, absent and unevaluated rows', () => {
  const dump = '- id: dsh-ops-shell\n  disabled: false\n- id: dsh-ops-discovery\n  config:\n    enabled: false\n- id: dsh-ops-panel\n  disabled: process.platform !== "win32"\n'
  const facts = componentFacts(dump)
  assert.equal(facts.shell, 'enabled')
  assert.equal(facts.discovery, 'disabled')
  assert.equal(facts.panel, 'unknown')
  assert.equal(facts.ptc, 'absent')
  const arms = [{ side: 'base', profile: 'base' }, { side: 'cand', profile: 'cand' }]
  profileFingerprints(arms, { dump: () => dump })
  assert.deepEqual(arms[0].components, facts)
  assert.deepEqual(arms[1].components, facts)
  assert.equal(componentFacts('bad: [').shell, 'unknown')
  assert.equal(componentFacts('- id: dsh-ops-shell\n- id: dsh-ops-shell\n').shell, 'unknown')
})

await test('Linux and macOS dry-run traverse setup without executing or writing profiles', async () => {
  await withTempDir('bench-posix-setup-', async dir => {
    const example = path.join(dir, 'example.yml')
    fs.writeFileSync(example, '[]\n')
    for (const platform of ['linux', 'darwin']) {
      const home = path.join(dir, platform)
      const lines = []
      const code = await setup(['--dsh-home', home, '--plugin', 'none', '--dry-run'], {
        platform, arch: 'x64', env: {}, entry: { kind: 'exe', file: 'fixture-dsh' },
        overlay: path.join(dir, 'overlay.yml'), overlayExample: example,
        invoke: () => { throw new Error('dry-run spawned the host') },
        out: line => lines.push(line), err: line => lines.push(line),
      })
      assert.equal(code, 0, lines.join('\n'))
      assert.match(lines.join('\n'), /skipped: Windows PowerShell pin/)
      assert.match(lines.join('\n'), /skipped: Windows PSModulePath/)
      assert.equal(fs.existsSync(home), false)
    }
  })
})

await test('host diagnostics cannot contaminate component configuration parsing', () => {
  const text = dumpProfileConfig({ kind: 'exe', file: 'fixture-dsh' }, 'bench', { run: () => ({
    status: 0, stdout: '- id: dsh-ops-shell\n', stderr: 'Warning: diagnostic, not configuration\n',
  }) })
  assert.equal(componentFacts(text).shell, 'enabled')
  assert.doesNotMatch(text, /Warning/)
})

report('bench-platform')
