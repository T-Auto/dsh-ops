/**
 * Setup B: the preflight half.
 *
 * Every check runs against a temporary home, a temporary checkout and a temporary staged
 * runtime — the real `~/.dsh` is never read, let alone written — and every external command
 * is a stand-in: `main` is given the resolved launcher, an `invoke` that records what dsh
 * would have been asked to do (and emulates profile creation, plugin installs and
 * `--dump-config`), and a `runGate` that answers the canonical native-runtime check without
 * spawning it. Nothing calls dsh, pnpm, npm or pwsh, and the `PSModulePath` probe is judged
 * on Windows-shaped values with an injected directory probe, so the ordering rule can be
 * exercised from any host.
 */

import fs from 'node:fs'
import path from 'node:path'
import { assert, report, test, withTempDir } from './lib/harness.mjs'
import {
  EXTRA_FLAGS, SANDBOX_MODES, checkLocalBuild, closingLines, inspectLocalBuild,
  inspectModulePath, inspectPermissions, layerPair, pinnedPair, preflight,
} from '../bench/setup/preflight.mjs'
import { parseArgs } from '../bench/setup/profile.mjs'
import { main } from '../bench/setup.mjs'
import { workerName } from '../lib/ptc/runtime.js'

const IN_BOX = 'C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules'
const CORE = 'C:\\Program Files\\PowerShell\\7\\Modules'
const USER_MODULES = 'C:\\Users\\dev\\Documents\\PowerShell\\Modules'
/** The shipped profile patch layer: comments plus the `[]` placeholder. */
const TEMPLATE_PATCH = '# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries.\n[]\n'
const EXAMPLE_TEMPLATE = '# bench LLM overlay template\nproviders:\n  bench-server:\n    baseURL: https://<your-server>/v1\n'
/** The permission pair a foreign hand-edit leaves behind: consistent, but not what was asked. */
const FOREIGN_PATCH = '- id: sandbox-policy\n  config:\n    mode: workspace-write\n- id: approval\n  config:\n    policy: ask\n'

/** Read one profile's patch layer as the composed tree `dsh --dump-config` would print it. */
function dumpConfig(profileDir) {
  const file = path.join(profileDir, 'cordis.patch.yml')
  if (!fs.existsSync(file)) return ''
  const out = []
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const id = /^- id:\s*(\S+)\s*$/.exec(line)
    if (id) { out.push(`- id: ${id[1]}`, '  config:'); continue }
    const key = /^\s+([A-Za-z][\w-]*):\s+(\S.*?)\s*$/.exec(line)
    if (key && out.length > 0) out.push(`    ${key[1]}: ${key[2]}`)
  }
  return `${out.join('\n')}\n`
}

/** Stage a target the way `npm run build:ptc -- stage` would: the worker and its receipt. */
function stageRuntime(root, target) {
  const directory = path.join(root, 'runtime', target)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, workerName(target.split('-')[0])), 'binary\n')
  fs.writeFileSync(path.join(directory, 'provenance.json'), JSON.stringify({ target }), 'utf8')
}

/**
 * A temporary bench home, a temporary checkout (staged for linux-x64 unless `built: false`),
 * an overlay template and the stand-in dsh.
 */
function fixture(dir, { version = '0.3.1', built = true } = {}) {
  const home = path.join(dir, 'home')
  const checkout = path.join(dir, 'checkout')
  const overlay = path.join(dir, 'llm.patch.yml')
  const example = path.join(dir, 'llm.patch.example.yml')
  fs.mkdirSync(checkout, { recursive: true })
  fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ name: 'dsh-ops', version }), 'utf8')
  if (built) stageRuntime(checkout, 'linux-x64')
  fs.writeFileSync(example, EXAMPLE_TEMPLATE, 'utf8')

  const calls = []
  const gates = []
  const out = []
  const err = []
  const profileDir = (name) => path.join(home, 'profiles', name)
  const pluginDir = (name) => path.join(profileDir(name), 'node_modules', 'dsh-ops')
  const install = (name, spec) => {
    const resolved = /^dsh-ops@/.test(spec)
      ? spec.slice('dsh-ops@'.length)
      : JSON.parse(fs.readFileSync(path.join(spec, 'package.json'), 'utf8')).version
    fs.mkdirSync(pluginDir(name), { recursive: true })
    fs.writeFileSync(path.join(pluginDir(name), 'package.json'), JSON.stringify({ name: 'dsh-ops', version: resolved }), 'utf8')
  }
  const invoke = (args) => {
    calls.push([...args])
    const at = args.indexOf('--profile')
    // Profile creation names the new profile positionally, not with --profile.
    const created = args.indexOf('--from-default-profile')
    const profile = at === -1 ? args[created - 1] : args[at + 1]
    if (created !== -1) {
      fs.mkdirSync(profileDir(profile), { recursive: true })
      fs.writeFileSync(path.join(profileDir(profile), 'cordis.patch.yml'), TEMPLATE_PATCH, 'utf8')
      return { status: 0, stdout: dumpConfig(profileDir(profile)), stderr: '', errorCode: null }
    }
    if (args.includes('--dump-config')) return { status: 0, stdout: dumpConfig(profileDir(profile)), stderr: '', errorCode: null }
    if (args.includes('plugin')) {
      const spec = args[args.length - 1]
      if (args.includes('remove')) fs.rmSync(pluginDir(profile), { recursive: true, force: true })
      else install(profile, spec)
      return { status: 0, stdout: '', stderr: '', errorCode: null }
    }
    return { status: 0, stdout: '', stderr: '', errorCode: null }
  }
  const io = (over = {}) => ({
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    env: { SystemRoot: 'C:\\Windows' },
    platform: 'linux', arch: 'x64',
    repoRoot: checkout,
    entry: { file: path.join(dir, 'dsh', 'lib', 'bin.js'), kind: 'js', notes: ['fixture'] },
    invoke,
    runGate: (target) => { gates.push(target); return { status: 0, stdout: '', stderr: '', errorCode: null } },
    overlay,
    overlayExample: example,
    ...over,
  })
  return {
    home, checkout, overlay, example, calls, gates,
    out: () => out.join('\n'), err: () => err.join('\n'),
    profileDir, pluginDir,
    baseFile: () => path.join(profileDir('bench-base'), 'cordis.patch.yml'),
    candFile: () => path.join(profileDir('bench-ops'), 'cordis.patch.yml'),
    seed(profile, text) {
      fs.mkdirSync(profileDir(profile), { recursive: true })
      fs.writeFileSync(path.join(profileDir(profile), 'cordis.patch.yml'), text, 'utf8')
    },
    io,
  }
}

await test('the permission combination comes from profile.mjs, and a foreign mode is refused', () => {
  // The pair is read out of permissionEntries/approvalPolicyFor, never re-derived here.
  assert.deepEqual(pinnedPair('danger-full-access'), { mode: 'danger-full-access', approval: 'never' })
  assert.deepEqual(pinnedPair('workspace-write'), { mode: 'workspace-write', approval: 'ask' })
  assert.deepEqual(pinnedPair('read-only'), { mode: 'read-only', approval: 'ask' })
  assert.deepEqual(SANDBOX_MODES, ['danger-full-access', 'workspace-write', 'read-only'])

  const consistent = inspectPermissions({
    requested: 'danger-full-access',
    base: pinnedPair('danger-full-access'),
    cand: pinnedPair('danger-full-access'),
  })
  assert.equal(consistent.ok, true, consistent.problems.join('; '))
  assert.deepEqual(consistent.problems, [])
  assert.deepEqual(consistent.expected, { mode: 'danger-full-access', approval: 'never' })

  // A mode paired with the wrong preset is not self-consistent: dsh-base derives "never"
  // only for danger-full-access.
  const contradictory = inspectPermissions({ requested: 'danger-full-access', cand: { mode: 'danger-full-access', approval: 'ask' } })
  assert.equal(contradictory.ok, false)
  assert.match(contradictory.problems[0], /danger-full-access/)
  assert.match(contradictory.problems[0], /never/)
  assert.match(contradictory.problems[0], /--force/)

  // An approval preset without a sandbox mode was hand-edited; the two go together.
  const orphan = inspectPermissions({ requested: 'danger-full-access', cand: { mode: null, approval: 'ask' } })
  assert.equal(orphan.ok, false)
  assert.match(orphan.problems[0], /without a sandbox mode/)

  // "Foreign" is a mode outside the set profile.mjs pins: named, with the set spelled out.
  const foreign = inspectPermissions({ requested: 'danger-full-access', cand: { mode: 'yolo', approval: 'ask' } })
  assert.equal(foreign.ok, false)
  assert.match(foreign.problems[0], /"yolo"/)
  assert.match(foreign.problems[0], /refused/)
  for (const mode of SANDBOX_MODES) assert.ok(foreign.problems[0].includes(mode), foreign.problems[0])
  assert.equal(inspectPermissions({ requested: 'yolo' }).ok, false, 'a foreign request is refused too')

  // Both sides have to run in one mode; the request is not a suggestion.
  const mismatch = inspectPermissions({ requested: 'danger-full-access', cand: pinnedPair('workspace-write') })
  assert.equal(mismatch.ok, false)
  assert.match(mismatch.problems[0], /workspace-write/)
  assert.match(mismatch.problems[0], /danger-full-access/)
  assert.match(mismatch.problems[0], /--force/)

  // --force lets profile.mjs rewrite the pair, so the same diagnosis stops being a refusal.
  assert.equal(inspectPermissions({ requested: 'danger-full-access', cand: pinnedPair('workspace-write'), force: true }).ok, true)
  assert.equal(inspectPermissions({ requested: 'danger-full-access', cand: { mode: 'yolo', approval: 'ask' }, force: true }).ok, true)

  // --permission-mode none writes nothing, so --force cannot repair a split pair.
  const split = inspectPermissions({ requested: 'none', base: pinnedPair('danger-full-access'), cand: pinnedPair('workspace-write'), force: true })
  assert.equal(split.ok, false)
  assert.match(split.problems[0], /different modes/)
  assert.equal(inspectPermissions({ requested: 'none', base: pinnedPair('read-only'), cand: pinnedPair('read-only') }).ok, true)
  const oneSided = inspectPermissions({ requested: 'none', cand: pinnedPair('read-only') })
  assert.equal(oneSided.ok, true)
  assert.equal(oneSided.warnings.length, 1)
  const unpinned = inspectPermissions({ requested: 'none' })
  assert.equal(unpinned.ok, true)
  assert.equal(unpinned.warnings.length, 1)

  // The layer reader is profile.mjs's own entry reader, so a patch layer and a composed
  // tree spell an entry the same way.
  assert.deepEqual(layerPair('- id: approval\n  config:\n    policy: ask\n- id: sandbox-policy\n  config:\n    mode: workspace-write\n'), { mode: 'workspace-write', approval: 'ask' })
  assert.equal(layerPair('# comments only\n\n'), null)
  assert.equal(layerPair(''), null)
  assert.equal(layerPair(undefined), null)
})

await test('PSModulePath is judged on Windows-shaped values from any host, and in-box first is clean', () => {
  const isDirectory = (file) => file === path.win32.join(CORE, 'Microsoft.PowerShell.Security')
  const hit = inspectModulePath({ modulePath: `${CORE};${IN_BOX}`, windows: 'C:\\Windows', isDirectory })
  assert.ok(hit, 'Core ahead of the in-box directory is the poisoned order')
  assert.equal(hit.entry, CORE)
  assert.match(hit.warning, /Get-Acl/)
  assert.match(hit.warning, /cmd\.exe/, 'the fix is a fresh cmd.exe, not an edit from inside this process')
  assert.match(hit.warning, /PowerShell 7/)

  // `;` is the delimiter even on a POSIX host: a drive-letter colon is not a separator.
  assert.equal(inspectModulePath({ modulePath: `${CORE};${IN_BOX}`, windows: 'C:\\Windows', isDirectory }).entry, CORE)
  assert.equal(inspectModulePath({ modulePath: `${IN_BOX};${CORE}`, windows: 'C:\\Windows', isDirectory }), null, 'in-box first never reaches Core')
  assert.equal(inspectModulePath({ modulePath: `${USER_MODULES};${IN_BOX}`, windows: 'C:\\Windows', isDirectory }), null, 'a user module folder is harmless')
  assert.equal(inspectModulePath({ modulePath: CORE, windows: 'C:\\Windows', isDirectory }).entry, CORE, 'without the in-box entry every entry is in front of it')
  assert.equal(inspectModulePath({ modulePath: undefined }), null)
  assert.equal(inspectModulePath({ modulePath: '' }), null)
  assert.equal(inspectModulePath({}), null)
})

await test('the preflight reports the poisoned PSModulePath as a warning with the order spelled out', async () => {
  await withTempDir('bench-pre-module-', async (dir) => {
    const poisoned = { SystemRoot: 'C:\\Windows', PSModulePath: `${CORE};${IN_BOX}` }
    const isDirectory = (file) => file === path.win32.join(CORE, 'Microsoft.PowerShell.Security')
    const options = { baseProfile: 'bench-base', candProfile: 'bench-ops', permissionMode: 'danger-full-access', plugin: 'local', noBuildCheck: true }
    const lines = []
    const dirty = preflight(options, { home: path.join(dir, 'home'), env: poisoned, platform: 'win32', arch: 'x64', log: (line) => lines.push(line), isDirectory })
    assert.equal(dirty.ok, true, 'a poisoned module path is a warning, not a refusal')
    assert.equal(dirty.outcomes.modulePath, 'poisoned')
    assert.equal(dirty.warnings.length, 1)
    assert.match(dirty.warnings[0], /cmd\.exe/)
    assert.match(lines.join('\n'), /search order: 1\. C:\\Program Files\\PowerShell\\7\\Modules/)
    assert.match(lines.join('\n'), /preflight: PSModulePath/)

    const clean = preflight(options, { home: path.join(dir, 'home'), env: { SystemRoot: 'C:\\Windows' }, platform: 'win32', arch: 'x64' })
    assert.equal(clean.outcomes.modulePath, 'clean')
    assert.deepEqual(clean.warnings, [])
  })
})

await test('the local-build preflight names the one rebuild command and judges what is staged', async () => {
  await withTempDir('bench-pre-build-', async (dir) => {
    const missing = inspectLocalBuild({ root: dir, platform: 'linux', arch: 'x64' })
    assert.equal(missing.problems.length, 1)
    assert.match(missing.problems[0].what, /runtime[\\/]linux-x64/)
    assert.match(missing.problems[0].fix, /npm run build:ptc/)

    stageRuntime(dir, 'linux-x64')
    assert.deepEqual(inspectLocalBuild({ root: dir, platform: 'linux', arch: 'x64' }).problems, [])

    // A worker older than native/src is a warning: it may measure a stale build, but the
    // artifact is there and the fix is the same one command.
    fs.mkdirSync(path.join(dir, 'native', 'src'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'native', 'src', 'lib.rs'), '// rust\n')
    const past = new Date('2000-01-01T00:00:00Z')
    fs.utimesSync(path.join(dir, 'runtime', 'linux-x64', workerName('linux')), past, past)
    const stale = inspectLocalBuild({ root: dir, platform: 'linux', arch: 'x64' })
    assert.deepEqual(stale.problems, [])
    assert.match(stale.warnings[0], /native[\\/]src[\\/]lib\.rs/)
    assert.match(stale.warnings[0], /npm run build:ptc/)

    // Workspace crates and platform adapters are equally capable of making a staged worker stale.
    for (const relative of ['crates/ops-files/src/lib.rs', 'windows-metadata/src/lib.rs', 'darwin-metadata/src/lib.rs']) {
      const file = path.join(dir, 'native', relative)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, '// workspace source\n')
      const future = new Date(Date.now() + 60000)
      fs.utimesSync(file, future, future)
      const changed = inspectLocalBuild({ root: dir, platform: 'linux', arch: 'x64' })
      assert.ok(changed.warnings.some(warning => warning.includes(path.relative(dir, file))))
      fs.utimesSync(file, past, past)
    }

    fs.utimesSync(path.join(dir, 'native', 'src', 'lib.rs'), past, past)
    const cache = path.join(dir, 'native', 'crates', 'ops-files', 'target', 'debug', 'cache')
    fs.mkdirSync(path.dirname(cache), { recursive: true })
    fs.writeFileSync(cache, 'build output')
    const staged = new Date('2020-01-01T00:00:00Z')
    fs.utimesSync(path.join(dir, 'runtime', 'linux-x64', workerName('linux')), staged, staged)
    assert.deepEqual(inspectLocalBuild({ root: dir, platform: 'linux', arch: 'x64' }).warnings, [])

    // An unsupported target is named as unsupported, not reported as a missing build.
    assert.match(inspectLocalBuild({ root: dir, platform: 'win32', arch: 'arm64' }).problems[0].what, /support matrix/)

    // The Windows Bash IPC proxies are a build of their own, judged against their receipt.
    fs.mkdirSync(path.join(dir, 'native', 'bash-ipc'), { recursive: true })
    for (const name of ['security.h', 'opsipc.cpp', 'opsnt.cpp']) fs.writeFileSync(path.join(dir, 'native', 'bash-ipc', name), `${name}\n`)
    const absent = inspectLocalBuild({ root: dir, platform: 'win32', arch: 'x64' }).problems
    const ipc = absent.find((problem) => /Bash IPC proxies/.test(problem.what))
    assert.ok(ipc, absent.map((problem) => problem.what).join('; '))
    assert.match(ipc.fix, /npm run build:bash-ipc/)

    const ipcDir = path.join(dir, 'runtime', 'win32-x64', 'bash-ipc')
    fs.mkdirSync(ipcDir, { recursive: true })
    fs.writeFileSync(path.join(ipcDir, 'provenance.json'), JSON.stringify({ files: {}, sources: {} }), 'utf8')
    const broken = inspectLocalBuild({ root: dir, platform: 'win32', arch: 'x64' }).problems
    assert.ok(broken.some((problem) => /opsipc\.dll/.test(problem.what)), broken.map((problem) => problem.what).join('; '))
    assert.ok(broken.some((problem) => /security\.h/.test(problem.what)))
    assert.ok(broken.every((problem) => /npm run build/.test(problem.fix)))
  })
})

await test('the build check honors --plugin, --no-build-check and --dry-run and runs the canonical gate', async () => {
  await withTempDir('bench-pre-check-', async (dir) => {
    const lines = []
    const log = (line) => lines.push(line)
    const bare = { plugin: 'local' }
    const missing = checkLocalBuild(bare, { root: dir, platform: 'linux', arch: 'x64', log })
    assert.equal(missing.status, 'problems')
    assert.match(missing.problems[0].fix, /npm run build:ptc/)

    // A published package means the checkout's build is not what runs; the operator's
    // --no-build-check is the other deliberate skip. Both say so.
    assert.equal(checkLocalBuild({ plugin: 'dsh-ops@0.3.1' }, { root: dir, platform: 'linux', arch: 'x64', log }).status, 'skipped')
    assert.equal(checkLocalBuild({ plugin: 'local', noBuildCheck: true }, { root: dir, platform: 'linux', arch: 'x64', log }).status, 'skipped')
    assert.match(lines.join('\n'), /--no-build-check: skipped/)

    // --dry-run plans the gate and demotes the missing artifact to a note.
    const planned = checkLocalBuild({ plugin: 'local', dryRun: true }, { root: dir, platform: 'linux', arch: 'x64', log })
    assert.equal(planned.status, 'planned')
    assert.deepEqual(planned.problems, [])
    assert.ok(planned.warnings.some((warning) => warning.includes('npm run build:ptc')), planned.warnings.join('; '))
    assert.match(lines.join('\n'), /\[dry-run\] would run the canonical gate/)

    // With the artifact staged, the gate is what decides; its failure names the same command.
    stageRuntime(dir, 'linux-x64')
    const gates = []
    const ok = checkLocalBuild({ plugin: 'local' }, { root: dir, platform: 'linux', arch: 'x64', log, runGate: (target) => { gates.push(target); return { status: 0, stdout: '', stderr: '', errorCode: null } } })
    assert.equal(ok.status, 'ok')
    assert.deepEqual(gates, ['linux-x64'])
    const failed = checkLocalBuild({ plugin: 'local' }, { root: dir, platform: 'linux', arch: 'x64', log, runGate: () => ({ status: 1, stdout: '', stderr: 'hash mismatch', errorCode: null }) })
    assert.equal(failed.status, 'problems')
    assert.match(failed.problems[0].what, /hash mismatch/)
    assert.match(failed.problems[0].fix, /npm run build:ptc/)
  })
})

await test('the closing hint is the one sweep command, with the renamed pair\'s flags', () => {
  const lines = closingLines({ baseProfile: 'bench-base', candProfile: 'bench-ops' })
  assert.equal(lines.length, 1, 'one command, not a menu')
  assert.match(lines[0], /node bench\/cli\.mjs ab/)
  assert.ok(!lines[0].includes('--base'), 'the default pair needs no flags')
  assert.ok(!lines[0].includes('bench/run.mjs'), 'the three manual commands are ab\'s business, not the operator\'s')
  const renamed = closingLines({ baseProfile: 'alt-base', candProfile: 'alt-ops' })
  assert.equal(renamed.length, 1)
  assert.match(renamed[0], /--base alt-base --cand alt-ops/)
})

await test('setup B\'s own flag is merged by profile.mjs\'s parser, not by editing it', () => {
  assert.equal(parseArgs(['--no-build-check'], EXTRA_FLAGS).noBuildCheck, true)
  assert.equal(parseArgs([], EXTRA_FLAGS).noBuildCheck, undefined)
  assert.throws(() => parseArgs(['--no-build-check']), /unknown option/)
  const merged = parseArgs(['--no-build-check', '--permission-mode', 'read-only'], EXTRA_FLAGS)
  assert.equal(merged.noBuildCheck, true)
  assert.equal(merged.permissionMode, 'read-only', 'the extra flags merge over profile.mjs\'s own, they do not replace them')
})

await test('main prepares the pair, prints one sweep command and exits 0', async () => {
  await withTempDir('bench-pre-main-', async (dir) => {
    const fx = fixture(dir)
    const code = await main(['--dsh-home', fx.home, '--no-pin'], fx.io())
    assert.equal(code, 0, fx.err())
    assert.equal(fx.err(), '', 'a clean first run has nothing to warn about')
    assert.match(fs.readFileSync(path.join(fx.pluginDir('bench-ops'), 'package.json'), 'utf8'), /0\.3\.1/)
    for (const profile of ['bench-base', 'bench-ops']) {
      const patch = fs.readFileSync(path.join(fx.profileDir(profile), 'cordis.patch.yml'), 'utf8')
      assert.match(patch, /- id: sandbox-policy\n  config:\n    mode: danger-full-access/, `${profile} pin`)
      assert.match(patch, /- id: approval\n  config:\n    policy: never/, `${profile} approval`)
    }
    assert.deepEqual(fx.gates, ['linux-x64'], 'the canonical gate ran once')
    assert.equal(fx.out().split('\n').filter((line) => line.includes('node bench/cli.mjs ab')).length, 1)
    assert.match(fx.out(), /setup complete\./)
  })
})

await test('main exits 2 on a usage error and 0 for --help', async () => {
  await withTempDir('bench-pre-usage-', async (dir) => {
    const fx = fixture(dir)
    assert.equal(await main(['--bogus'], fx.io()), 2)
    assert.match(fx.err(), /unknown option "--bogus"/)
    assert.match(fx.err(), /usage: node bench\/cli\.mjs setup/)
    const bad = fixture(path.join(dir, 'mode'))
    assert.equal(await main(['--permission-mode', 'yolo'], bad.io()), 2)
    assert.match(bad.err(), /--permission-mode/)
    const help = fixture(path.join(dir, 'help'))
    assert.equal(await main(['--help'], help.io()), 0)
    assert.match(help.out(), /--no-build-check/)
    assert.deepEqual(help.calls, [], '--help runs nothing')
  })
})

await test('a failed preflight exits non-zero, names the fix and prepares nothing', async () => {
  await withTempDir('bench-pre-refuse-', async (dir) => {
    const fx = fixture(dir, { built: false })
    const code = await main(['--dsh-home', fx.home, '--no-pin'], fx.io())
    assert.equal(code, 1)
    assert.match(fx.err(), /preflight refused/)
    assert.match(fx.err(), /npm run build:ptc/)
    assert.equal(fs.existsSync(path.join(fx.home, 'profiles')), false, 'the refusal comes before any profile is created')
    assert.deepEqual(fx.calls, [], 'no dsh command was run')
    assert.deepEqual(fx.gates, [], 'the gate is not reached when the artifact is absent')

    // Each deliberate opt-out gets past the same refusal.
    const skipped = fixture(path.join(dir, 'skipped'), { built: false })
    assert.equal(await main(['--dsh-home', skipped.home, '--no-pin', '--no-build-check'], skipped.io()), 0)
    const published = fixture(path.join(dir, 'published'), { built: false })
    assert.equal(await main(['--dsh-home', published.home, '--no-pin', '--plugin', 'dsh-ops@0.3.1'], published.io()), 0)
  })
})

await test('--dry-run writes nothing, plans the gate and still names a missing build', async () => {
  await withTempDir('bench-pre-dry-', async (dir) => {
    const fx = fixture(dir, { built: false })
    const code = await main(['--dsh-home', fx.home, '--no-pin', '--dry-run'], fx.io())
    assert.equal(code, 0, fx.err())
    assert.match(fx.err(), /npm run build:ptc/)
    assert.match(fx.out(), /\[dry-run\] would run the canonical gate/)
    assert.deepEqual(fx.gates, [], 'the gate is planned, never spawned')
    assert.deepEqual(fx.calls, [], 'dsh is not asked to do anything')
    assert.equal(fs.existsSync(fx.home), false, 'not even the home was created')
    assert.match(fx.out(), /\[dry-run\] everything above is a plan/)
  })
})

await test('a hand-edited permission pair is refused before anything is written, and --force rewrites it', async () => {
  await withTempDir('bench-pre-perm-', async (dir) => {
    const fx = fixture(dir)
    fx.seed('bench-ops', FOREIGN_PATCH)
    const code = await main(['--dsh-home', fx.home, '--no-pin'], fx.io())
    assert.equal(code, 1)
    assert.match(fx.err(), /workspace-write/)
    assert.match(fx.err(), /--force/)
    assert.equal(fs.readFileSync(fx.candFile(), 'utf8'), FOREIGN_PATCH, 'the conflicting layer is untouched')
    assert.deepEqual(fx.calls, [], 'nothing was written behind the refusal')

    const forced = fixture(path.join(dir, 'forced'))
    forced.seed('bench-ops', FOREIGN_PATCH)
    assert.equal(await main(['--dsh-home', forced.home, '--no-pin', '--force'], forced.io()), 0, forced.err())
    const patched = fs.readFileSync(forced.candFile(), 'utf8')
    assert.match(patched, /mode: danger-full-access/)
    assert.match(patched, /policy: never/)
    assert.equal(patched.split('mode:').length - 1, 1, 'the key is replaced, not duplicated')
  })
})

await test('a foreign mode is refused by name, and --permission-mode none refuses a split pair even with --force', async () => {
  await withTempDir('bench-pre-foreign-', async (dir) => {
    const fx = fixture(dir)
    fx.seed('bench-ops', '- id: sandbox-policy\n  config:\n    mode: yolo\n- id: approval\n  config:\n    policy: never\n')
    assert.equal(await main(['--dsh-home', fx.home, '--no-pin'], fx.io()), 1)
    assert.match(fx.err(), /"yolo"/)
    assert.match(fx.err(), /refused/)
    for (const mode of SANDBOX_MODES) assert.ok(fx.err().includes(mode), fx.err())

    const forced = fixture(path.join(dir, 'forced'))
    forced.seed('bench-ops', '- id: sandbox-policy\n  config:\n    mode: yolo\n- id: approval\n  config:\n    policy: never\n')
    assert.equal(await main(['--dsh-home', forced.home, '--no-pin', '--force'], forced.io()), 0, forced.err())
    assert.ok(!fs.readFileSync(forced.candFile(), 'utf8').includes('yolo'), '--force replaces the foreign value')

    const split = fixture(path.join(dir, 'split'))
    split.seed('bench-base', '- id: sandbox-policy\n  config:\n    mode: danger-full-access\n- id: approval\n  config:\n    policy: never\n')
    split.seed('bench-ops', FOREIGN_PATCH)
    assert.equal(await main(['--dsh-home', split.home, '--no-pin', '--permission-mode', 'none', '--force'], split.io()), 1)
    assert.match(split.err(), /different modes/)
    assert.equal(fs.readFileSync(split.candFile(), 'utf8'), FOREIGN_PATCH, 'nothing repins a pair --permission-mode none was told to leave alone')
  })
})

await test('the poisoned PSModulePath reaches main as a warning and never blocks a planned run', async () => {
  await withTempDir('bench-pre-main-module-', async (dir) => {
    const fx = fixture(dir)
    const io = fx.io({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows', PSModulePath: `${CORE};${IN_BOX}` },
      isDirectory: (file) => file === path.win32.join(CORE, 'Microsoft.PowerShell.Security'),
    })
    const code = await main(['--dsh-home', fx.home, '--no-pin', '--dry-run', '--no-build-check'], io)
    assert.equal(code, 0, fx.err())
    assert.match(fx.err(), /cmd\.exe/)
    assert.match(fx.out(), /preflight: PSModulePath/)
    assert.match(fx.out(), /search order/)
    assert.equal(fx.out().split('\n').filter((line) => line.includes('node bench/cli.mjs ab')).length, 1)
  })
})

report('bench-setup-preflight')
