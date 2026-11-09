/**
 * Scope helpers come from the copy the running host uses (#752).
 *
 * `@deepseek-ai/dsh-scope` tags a context with a module-private
 * `Symbol('dsh.scope')` and keeps ancestry in a module-private `WeakMap`, so a
 * second copy cannot read host contexts: `scopeOf` returns `undefined` and
 * session publication fails its scope check. A profile install can resolve a
 * copy hoisted by another bundle, and a `link:`ed checkout resolves its own.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assert, test, report, PACKAGE_ROOT, withTempDir } from './lib/harness.mjs'
import { chooseScopeSource } from '../lib/adapter/dsh/host.js'

const adapter = path.join(PACKAGE_ROOT, 'lib', 'adapter', 'dsh', 'host.js')
/** A minimal package-shaped scope copy that reports its own marker. */
function scopeCopy(root, marker) {
  write(root, 'node_modules/@deepseek-ai/dsh-scope/package.json', JSON.stringify({
    name: '@deepseek-ai/dsh-scope', version: '0.0.0', type: 'module', exports: './index.js',
  }))
  write(root, 'node_modules/@deepseek-ai/dsh-scope/index.js',
    `export const copyMarker = ${JSON.stringify(marker)}\nexport function scopeOf() { return ${JSON.stringify(marker)} }\n`)
}


function write(root, name, content) {
  const file = path.join(root, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

/** A host-shaped entry that reports which scope copy `loadScopes()` loaded. */
function hostEntry(root) {
  write(root, 'entry.mjs', [
    `import { loadScopes } from ${JSON.stringify(pathToFileURL(adapter).href)}`,
    'const scopes = await loadScopes()',
    "console.log(typeof scopes.scopeOf === 'function' ? (scopes.copyMarker ?? 'host') : 'none')",
    '',
  ].join('\n'))
  return path.join(root, 'entry.mjs')
}

await test('a shadowing copy inside the checkout is re-pointed at the host entry', () => {
  const checkout = new URL('../', import.meta.url).href
  assert.equal(chooseScopeSource(`${checkout}node_modules/@deepseek-ai/dsh-scope/lib/index.js`,
    'file:///host/scope.js'), 'file:///host/scope.js')
  assert.equal(chooseScopeSource('file:///elsewhere/scope.js', 'file:///host/scope.js'),
    'file:///elsewhere/scope.js')
  assert.equal(chooseScopeSource(undefined, 'file:///host/scope.js'), 'file:///host/scope.js')
})

await test('without a host entry, a copy inside this checkout yields to the profile layer', () => {
  const checkout = new URL('../', import.meta.url).href
  assert.equal(chooseScopeSource(new URL('node_modules/@deepseek-ai/dsh-scope/lib/index.js', checkout).href,
    undefined, 'file:///profile-layer/scope.js'), 'file:///profile-layer/scope.js')
  assert.equal(chooseScopeSource('file:///elsewhere/scope.js', undefined, 'file:///profile-layer/scope.js'),
    'file:///elsewhere/scope.js')
  assert.equal(chooseScopeSource(undefined, undefined), undefined)
})

await test('the same file under a different spelling keeps the bare URL', () =>
  withTempDir('host-scope-spelling', async root => {
    const file = path.join(root, 'scope.js')
    fs.writeFileSync(file, '')
    const bare = path.join(PACKAGE_ROOT, 'node_modules', '@deepseek-ai', 'dsh-scope', 'lib', 'index.js')
    const spelled = pathToFileURL(bare).href.replace('/index.js', '/%69ndex.js')
    assert.notEqual(spelled, pathToFileURL(bare).href)
    assert.equal(chooseScopeSource(pathToFileURL(bare).href, spelled), pathToFileURL(bare).href)
  }))

await test('loadScopes loads the copy the running host entry resolves', () =>
  withTempDir('host-scope-entry', async root => {
    scopeCopy(root, 'host-copy')
    const result = spawnSync(process.execPath, [hostEntry(root)], { cwd: root, encoding: 'utf8', timeout: 30_000 })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'host-copy')
  }))

await test('without a host copy the adapter still loads the bare resolution', () =>
  withTempDir('host-scope-bare', async root => {
    const result = spawnSync(process.execPath, [hostEntry(root)], { cwd: root, encoding: 'utf8', timeout: 30_000 })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'host')
  }))

await test('an installed profile resolves the host copy over a hoisted one (#752)', () =>
  withTempDir('host-scope-installed', async root => {
    // The plugin lives in the profile tree, where a bundle can hoist its own copy.
    const installed = path.join(root, 'profiles', 'web', 'node_modules', 'dsh-ops', 'lib', 'adapter', 'dsh', 'host.js')
    fs.mkdirSync(path.dirname(installed), { recursive: true })
    fs.copyFileSync(adapter, installed)
    scopeCopy(path.join(root, 'profiles', 'web'), 'hoisted')
    // The running host entry resolves the copy the host process itself uses.
    scopeCopy(path.join(root, 'host'), 'host-copy')
    write(root, 'host/entry.mjs', [
      `import { loadScopes } from ${JSON.stringify(pathToFileURL(installed).href)}`,
      'const scopes = await loadScopes()',
      'console.log(scopes.copyMarker)',
      '',
    ].join('\n'))
    const result = spawnSync(process.execPath, [path.join(root, 'host', 'entry.mjs')],
      { cwd: path.join(root, 'host'), encoding: 'utf8', timeout: 30_000, env: { ...process.env, DSH_HOME: root } })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'host-copy')
  }))

report('host-scope-source')
