/** The source compiler builds a clean, runnable package without touching this checkout's lib/. */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { assert, test, report, PACKAGE_ROOT, withTempDir } from './lib/harness.mjs'

function write(root, name, content) {
  const file = path.join(root, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function fixture(root) {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })
  fs.copyFileSync(path.join(PACKAGE_ROOT, 'scripts/build.mjs'), path.join(root, 'scripts/build.mjs'))
  fs.copyFileSync(path.join(PACKAGE_ROOT, 'tsconfig.json'), path.join(root, 'tsconfig.json'))
  write(root, 'scripts/lib/build/client.mjs', fs.readFileSync(path.join(PACKAGE_ROOT, 'scripts/lib/build/client.mjs')))
  write(root, 'cordis.patch.yml', fs.readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml')))
  // Copies also work in Windows sandboxes where directory junctions are unavailable.
  for (const name of ['typescript', '@types/node', 'undici-types', 'yaml']) {
    fs.cpSync(path.join(PACKAGE_ROOT, 'node_modules', name),
      path.join(root, 'node_modules', name), { recursive: true })
  }
  write(root, 'package.json', JSON.stringify({ name: 'build-fixture', private: true, type: 'module' }))
}

function build(root) {
  // The caller's current directory must not determine which package is rebuilt.
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/build.mjs')], {
    cwd: PACKAGE_ROOT, encoding: 'utf8', timeout: 30_000,
  })
  assert.ifError(result.error)
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

await test('build emits TypeScript as runnable JavaScript at the existing package paths', () =>
  withTempDir('source-build-modules', async root => {
    fixture(root)
    write(root, 'src/index.ts', "import { prefix } from './policy.js'\nexport const answer: string = `${prefix}:42`\n")
    write(root, 'src/policy.ts', "export const prefix = 'ops'\n")
    write(root, 'src/nested/module.mts', 'export const count: number = 3\n')
    write(root, 'src/nested/module.cts', 'export const count: number = 4\n')
    write(root, 'src/types.d.ts', 'export interface Config { enabled: boolean }\n')
    const result = build(root)
    assert.equal(result.status, 0, result.output)
    assert.equal((await import(pathToFileURL(path.join(root, 'lib/index.js')).href)).answer, 'ops:42')
    assert.equal((await import(pathToFileURL(path.join(root, 'lib/nested/module.mjs')).href)).count, 3)
    assert.equal((await import(pathToFileURL(path.join(root, 'lib/nested/module.cjs')).href)).count, 4)
    for (const name of ['index.ts', 'nested/module.mts', 'nested/module.cts', 'types.d.ts']) {
      assert.equal(fs.existsSync(path.join(root, 'lib', name)), false, `uncompiled source copied: ${name}`)
    }
  }))

await test('rebuild removes retired modules and assets while preserving every asset byte', () =>
  withTempDir('source-build-assets', root => {
    fixture(root)
    write(root, 'src/index.ts', 'export const enabled = true\n')
    write(root, 'src/retired.ts', 'export default false\n')
    write(root, 'src/panel/retired.html', '<p>retired</p>\n')
    const assets = {
      'components/panel/package.json': Buffer.from('{"type":"module"}\n'),
      'components/panel/locale/en-US.json': Buffer.from('{"name":"Panel"}\r\n'),
      'components/panel/icon.png': Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]),
      'components/tui/dsh-plugin.json': Buffer.from('{"id":"dsh-ops/tui"}\n'),
      'panel/panel.html': Buffer.from('<!doctype html>\r\n<p>面板</p>\r\n'),
    }
    for (const [name, bytes] of Object.entries(assets)) write(root, `src/${name}`, bytes)
    const initial = build(root)
    assert.equal(initial.status, 0, initial.output)
    assert.ok(fs.existsSync(path.join(root, 'lib/retired.js')))
    assert.ok(fs.existsSync(path.join(root, 'lib/panel/retired.html')))
    fs.unlinkSync(path.join(root, 'src/retired.ts'))
    fs.unlinkSync(path.join(root, 'src/panel/retired.html'))
    write(root, 'lib/obsolete/nested.txt', 'old build output')
    const rebuilt = build(root)
    assert.equal(rebuilt.status, 0, rebuilt.output)
    for (const name of ['retired.js', 'panel/retired.html', 'obsolete']) {
      assert.equal(fs.existsSync(path.join(root, 'lib', name)), false, `stale output remains: ${name}`)
    }
    for (const [name, bytes] of Object.entries(assets)) {
      assert.deepEqual(fs.readFileSync(path.join(root, 'lib', name)), bytes, `asset changed: ${name}`)
    }
    assert.equal(fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8'), 'export const enabled = true\n')
  }))

await test('compiler errors fail the build with diagnostics and no stale or partially copied package', () =>
  withTempDir('source-build-error', root => {
    fixture(root)
    write(root, 'src/index.ts', "export const count: number = 'wrong type'\n")
    write(root, 'src/panel/panel.html', '<p>must not be published</p>\n')
    write(root, 'lib/index.js', 'export const count = 42\n')
    const result = build(root)
    assert.notEqual(result.status, 0, result.output)
    assert.match(result.output, /error TS2322/u)
    assert.equal(fs.existsSync(path.join(root, 'lib/index.js')), false)
    assert.equal(fs.existsSync(path.join(root, 'lib/panel/panel.html')), false)
  }))

await test('unimported JavaScript source fails packaging instead of silently disappearing', () =>
  withTempDir('source-build-unchecked', root => {
    fixture(root)
    write(root, 'src/index.ts', 'export const enabled = true\n')
    for (const extension of ['js', 'mjs', 'cjs', 'jsx']) {
      const unsupported = `src/nested/unimported.${extension}`
      write(root, unsupported, 'export const unchecked = true\n')
      write(root, 'lib/index.js', 'export const stale = true\n')
      const result = build(root)
      assert.notEqual(result.status, 0, result.output)
      assert.match(result.output, /JavaScript source is not supported/)
      assert.ok(result.output.includes(path.normalize(unsupported)), result.output)
      assert.equal(fs.existsSync(path.join(root, 'lib/index.js')), false)
      fs.unlinkSync(path.join(root, unsupported))
    }
  }))

report('build')
