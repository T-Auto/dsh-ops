/** npm source closure: compiled host code and path crates survive packing, without build caches. */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { assert, test, report, PACKAGE_ROOT } from './lib/harness.mjs'

await test('npm pack includes compiled host code and native sources, never host sources or build caches', () => {
  const started = performance.now()
  const result = spawnSync(process.platform === 'win32' ? 'cmd.exe' : 'npm',
    process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd pack --dry-run --json --ignore-scripts'] : ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: PACKAGE_ROOT, encoding: 'utf8', timeout: 30000 })
  assert.equal(result.status, 0, JSON.stringify({ elapsedMs: Math.round(performance.now() - started),
    signal: result.signal, error: result.error && { code: result.error.code, message: result.error.message },
    stderr: result.stderr, stdoutTail: result.stdout?.slice(-2000) }, null, 2))
  const files = JSON.parse(result.stdout)[0].files.map(file => file.path)
  const required = ['lib/ptc/sdk.d.ts', 'lib/index.js', 'lib/policy.js', 'lib/components/panel/index.js',
    'lib/components/panel/package.json', 'lib/components/panel/icon.png', 'lib/panel/panel.html',
    'lib/components/tui/dsh-plugin.json',
    'lib/components/mode-minimal/index.js', 'lib/components/mode-minimal/package.json', 'lib/components/mode-minimal/icon.png',
    'lib/components/mode-standard/index.js', 'lib/components/mode-standard/locale/en.json', 'lib/components/mode-standard/locale/zh.json',
    'lib/components/mode-ptc/index.js', 'lib/components/mode-cordis/index.js',
    'lib/settings/merged.js', 'lib/settings/schema.js', 'lib/settings/runtime-host.js',
    'lib/modes/plan.js', 'lib/modes/apply.js', 'lib/modes/detect.js', 'lib/publication/replacements.js',
    'lib/publication/native.js', 'lib/file/native/render.js', 'lib/ptc/projection/schema.js',
    'native/Cargo.toml', 'native/Cargo.lock', 'native/src/lib.rs',
    'native/windows-metadata/Cargo.toml', 'native/windows-metadata/src/lib.rs',
    'native/darwin-metadata/Cargo.toml', 'native/darwin-metadata/src/lib.rs',
    'native/crates/ops-documents/Cargo.toml', 'native/crates/ops-documents/src/lib.rs',
    'native/crates/ops-documents/src/decode.rs', 'native/crates/ops-documents/src/parse.rs',
    'native/crates/ops-documents/src/tests.rs', 'native/crates/ops-documents/src/archive.rs',
    'native/crates/ops-documents/src/xml.rs', 'native/crates/ops-documents/src/docx.rs',
    'native/crates/ops-documents/src/pdf_syntax.rs',
    'native/crates/ops-documents/src/pdf.rs', 'native/crates/ops-documents/src/pdf_text.rs',
    'native/crates/ops-documents/src/pdf_pages.rs',
    'native/crates/ops-documents/src/pdf_container.rs', 'native/crates/ops-documents/src/pdf_container_tests.rs',
    'licenses/documents/THIRD-PARTY-NOTICES.txt']
  for (const name of required) assert.ok(files.includes(name), `missing source-build dependency: ${name}`)
  for (const name of ['lib/adapter/dsh/host.js', 'lib/adapter/dsh/types.js']) assert.ok(files.includes(name), `adapter resource missing: ${name}`)
  assert.ok(files.includes('lib/integration/index.js'), 'public integration entry missing')
  assert.ok(files.includes('lib/integration/config.js'), 'public integration config missing')
  assert.ok(files.includes('lib/integration/diagnostics.js'), 'public diagnostics entry missing')
  assert.ok(files.includes('lib/discovery/providers.js'), 'external provider implementation missing')
  assert.equal(files.some(name => name.startsWith('src/')), false, 'host source must not ship beside compiled lib/')
  assert.equal(files.some(name => /^native\/(?:target[^/]*|(?:windows|darwin)-metadata\/target)\//u.test(name)), false)
  const pending = ['native/Cargo.toml'], visited = new Set()
  while (pending.length) {
    const name = pending.pop()
    if (visited.has(name)) continue
    visited.add(name)
    assert.ok(files.includes(name), `unpacked Cargo manifest is missing: ${name}`)
    const manifest = fs.readFileSync(path.join(PACKAGE_ROOT, name), 'utf8')
    const source = path.posix.join(path.posix.dirname(name), 'src/lib.rs')
    assert.ok(files.includes(source), `unpacked crate source is missing: ${source}`)
    for (const match of manifest.matchAll(/\bpath\s*=\s*"([^"]+)"/gu)) {
      const relative = path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1]))
      assert.ok(relative.startsWith('native/'), 'path dependencies stay within the native workspace')
      if (fs.statSync(path.join(PACKAGE_ROOT, relative)).isDirectory()) pending.push(`${relative}/Cargo.toml`)
      else assert.ok(files.includes(relative), `unpacked Cargo path is missing: ${relative}`)
    }
  }
})
report('package-source')
