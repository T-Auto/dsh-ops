/**
 * `prepack` builds a checkout, and a packaged install repacks without the
 * repository-only `scripts/` directory (#713).
 *
 * The entry point has to live in a published directory: `files` refuses
 * `scripts/`, so an entry point there is missing from the tarball it packs.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { assert, test, report, PACKAGE_ROOT, withTempDir } from './lib/harness.mjs'

const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))
/** The package-relative entry point `prepack` runs, or `undefined` when it is not a plain node script. */
const entry = /^node\s+(\S+)$/u.exec(manifest.scripts?.prepack ?? '')?.[1]

function write(root, name, content) {
  const file = path.join(root, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

/** The published `prepack` entry point, refusing one that ships nothing. */
function packEntry() {
  assert.ok(entry, `prepack must run one node script; got ${JSON.stringify(manifest.scripts?.prepack)}`)
  assert.ok(!entry.startsWith('scripts/'), 'prepack must not point into scripts/, which files never publishes')
  const file = path.join(PACKAGE_ROOT, entry)
  assert.ok(fs.existsSync(file), `prepack entry point is missing: ${entry}`)
  return file
}

/**
 * Run `npm pack --dry-run` the way this platform's shell spells it. Lifecycle
 * output stays visible so the suite can prove npm ran the entry point at all.
 */
function pack(root) {
  const args = ['pack', '--dry-run', '--foreground-scripts']
  return process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`], { cwd: root, encoding: 'utf8', timeout: 60_000 })
    : spawnSync('npm', args, { cwd: root, encoding: 'utf8', timeout: 60_000 })
}

await test('the prepack entry point is published, not repository-only', () => {
  packEntry()
})

await test('an installed package repacks without the repository build scripts', () =>
  withTempDir('prepack-installed', root => {
    write(root, 'package.json', JSON.stringify({
      name: 'dsh-ops-installed-fixture', version: '0.0.0', type: 'module',
      scripts: { prepack: manifest.scripts.prepack }, files: ['bin', 'lib'],
    }, null, 2))
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
    fs.copyFileSync(packEntry(), path.join(root, entry))
    write(root, 'lib/index.js', 'export {}\n')
    const result = pack(root)
    const output = `${result.stdout}${result.stderr}`
    assert.equal(result.status, 0, `packing an installed package failed:\n${output}`)
    assert.ok(output.includes(entry), `npm did not run ${entry}:\n${output}`)
  }))

await test('a checkout still builds and checks the payload before packing', () =>
  withTempDir('prepack-checkout', root => {
    const trace = path.join(root, 'prepack-trace.txt')
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
    fs.copyFileSync(packEntry(), path.join(root, entry))
    write(root, 'scripts/build.mjs',
      `import fs from 'node:fs'\nfs.appendFileSync(${JSON.stringify(trace)}, 'build\\n')\n`)
    write(root, 'scripts/lib/build/niubash.mjs',
      `import fs from 'node:fs'\nfs.appendFileSync(${JSON.stringify(trace)}, 'check ' + process.argv.slice(2).join(' ') + '\\n')\n`)
    const result = spawnSync(process.execPath, [path.join(root, entry)], { cwd: root, encoding: 'utf8', timeout: 30_000 })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(fs.readFileSync(trace, 'utf8'), 'build\ncheck --check\n')
  }))

report('prepack')
