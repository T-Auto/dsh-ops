/**
 * The install-channel contract (#524): the only channel that produces a loadable
 * plugin is the registry tarball, and no lifecycle hook may pretend otherwise.
 *
 * `prepare` runs for a git-hosted dependency after pnpm unpacks it. Adding one
 * would compile `lib/` — only half of what a git install needs — and would make
 * every git install pay for a full TypeScript build while the native worker stays
 * unstaged (`npm run build:ptc` needs cargo). This suite runs the real manifest
 * gate against a copy of the package so the refusal is proven by the shipped
 * validator, not by a re-implementation of its rule.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { assert, PACKAGE_ROOT, report, test, withTempDir } from './lib/harness.mjs'

/** Everything the validator reads: built `lib/`, the gates, payloads and manifests. */
const PUBLISHED = ['lib', 'scripts', 'locale', 'licenses', 'dsh-plugin.json', 'cordis.patch.yml',
  'package.json', 'LICENSE', 'NOTICE', 'README.md', 'README.zh.md', 'README.en.md',
  'docs/PROVENANCE.md', 'docs/CHANGELOG.md', 'docs/assets/icon.png']

/** Stage a copy of the package the validator can run against, dependencies included. */
function fixture(root) {
  for (const entry of PUBLISHED) {
    const from = path.join(PACKAGE_ROOT, entry)
    fs.mkdirSync(path.dirname(path.join(root, entry)), { recursive: true })
    fs.cpSync(from, path.join(root, entry), { recursive: true })
  }
  fs.symlinkSync(path.join(PACKAGE_ROOT, 'node_modules'), path.join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir')
}

/** Run the shipped gate in the fixture and return its exit code and output. */
function validate(root) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/validate-manifest.mjs')],
    { cwd: root, encoding: 'utf8', timeout: 90_000 })
  assert.ifError(result.error)
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

/** Rewrite the fixture's `scripts` block, keeping every other field. */
function withScripts(root, patch) {
  const file = path.join(root, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
  pkg.scripts = { ...pkg.scripts, ...patch }
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2))
}

await test('the manifest gate passes on the shipped package and names no lifecycle hook', () =>
  withTempDir('install-channel-clean', root => {
    fixture(root)
    const result = validate(root)
    assert.equal(result.status, 0, result.output)
    assert.match(result.output, /validate-manifest: all \d+ checks passed/u)
  }))

await test('a prepare hook fails the gate, whatever else the tree looks like', () =>
  withTempDir('install-channel-prepare', root => {
    fixture(root)
    withScripts(root, { prepare: 'node scripts/build.mjs' })
    const result = validate(root)
    assert.equal(result.status, 1, result.output)
    assert.match(result.output, /declares no install-time lifecycle hook/u)
    // The failure has to say which hook it found, or the author cannot tell what to remove.
    assert.match(result.output, /found prepare/u)
  }))

await test('a postinstall hook fails the same check', () =>
  withTempDir('install-channel-postinstall', root => {
    fixture(root)
    withScripts(root, { postinstall: 'node scripts/install-payload.mjs' })
    const result = validate(root)
    assert.equal(result.status, 1, result.output)
    assert.match(result.output, /found postinstall/u)
  }))

// The check label and the docs say "install-time lifecycle hook", not "prepare or
// postinstall": the rule matches the whole `(pre|post)?(prepare|install)` family. An
// unrelated hook is the case that proves the broader wording — it neither compiles
// `lib/` nor downloads a payload, and is still refused.
await test('an unrelated install-time hook is refused by the same rule', () =>
  withTempDir('install-channel-preinstall', root => {
    fixture(root)
    withScripts(root, { preinstall: 'node scripts/check-toolchain.mjs' })
    const result = validate(root)
    assert.equal(result.status, 1, result.output)
    assert.match(result.output, /declares no install-time lifecycle hook/u)
    assert.match(result.output, /found preinstall/u)
  }))

report('install-channel')
