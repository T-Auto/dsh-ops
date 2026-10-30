import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { managedBashInventory, removeManagedBash, selectBashRuntime, gitBashCandidates } from '../lib/shells/manager.js'
import { pinnedBashExecutable } from '../lib/shells/pinned.js'
import { assert, report, test, withTempDir, PACKAGE_ROOT } from './lib/harness.mjs'

function seed(home, version, owned = true) {
  const directory = path.join(home, 'dsh-ops/shells/bash', version)
  fs.mkdirSync(path.join(directory, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(directory, 'bin/bash.exe'), 'fixture')
  if (owned) fs.writeFileSync(path.join(directory, '.provisioned.json'), JSON.stringify({ schemaVersion: 1, name: 'bash', version, sha256: 'a'.repeat(64) }))
  return directory
}

await test('managed removal previews, honors dry-run, and deletes only receipt-marked Bash versions', async () => {
  await withTempDir('manager-remove', home => {
    const owned = seed(home, '1.0'), other = seed(home, 'unowned', false)
    const pwsh = path.join(home, 'dsh-ops/shells/pwsh/keep.txt')
    fs.mkdirSync(path.dirname(pwsh), { recursive: true }); fs.writeFileSync(pwsh, 'keep')
    const env = { DSH_HOME: home }
    assert.equal(removeManagedBash({ env }).action, 'preview'); assert.equal(fs.existsSync(owned), true)
    assert.equal(removeManagedBash({ env, yes: true, dryRun: true }).action, 'preview'); assert.equal(fs.existsSync(owned), true)
    const result = removeManagedBash({ env, yes: true })
    assert.equal(result.action, 'removed'); assert.equal(result.versions.length, 1); assert.equal(result.kept.length, 1)
    assert.equal(fs.existsSync(owned), false); assert.equal(fs.existsSync(other), true); assert.equal(fs.readFileSync(pwsh, 'utf8'), 'keep')
  })
})

await test('a linked managed ancestor is refused before any removal', async () => {
  await withTempDir('manager-links', root => {
    const home = path.join(root, 'home'), outside = path.join(root, 'outside')
    fs.mkdirSync(home); fs.mkdirSync(path.join(outside, 'shells/bash/1.0'), { recursive: true })
    fs.writeFileSync(path.join(outside, 'shells/bash/1.0/keep'), 'keep')
    fs.symlinkSync(outside, path.join(home, 'dsh-ops'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => removeManagedBash({ env: { DSH_HOME: home }, yes: true }), /must not traverse links/)
    assert.equal(fs.readFileSync(path.join(outside, 'shells/bash/1.0/keep'), 'utf8'), 'keep')
  })
})

await test('cache cleanup is preview-only until all hosts are explicitly stopped', async () => {
  await withTempDir('manager-cache-clean', home => {
    const cache = path.join(home, 'dsh-ops/bash-ipc')
    const names = ['a', 'b', 'c'].map(value => value.repeat(24))
    for (const [index, name] of names.entries()) {
      const dir = path.join(cache, name)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, '.ops-ipc.json'), JSON.stringify({ identity: name, files: {}, tree: {} }))
      fs.writeFileSync(path.join(dir, 'payload.bin'), 'fixture')
      fs.utimesSync(dir, new Date(2026, 0, index + 1), new Date(2026, 0, index + 1))
    }
    const unknown = path.join(cache, 'backup.stale-notes')
    fs.mkdirSync(unknown)
    const call = args => spawnSync(process.execPath, [path.join(PACKAGE_ROOT, 'bin/dsh-ops.mjs'), 'bash-runtime', 'clean-cache', ...args], { encoding: 'utf8', env: { ...process.env, DSH_HOME: home } })
    const preview = call([])
    assert.equal(preview.status, 0, preview.stderr)
    assert.equal(JSON.parse(preview.stdout).action, 'preview')
    assert.equal(fs.existsSync(path.join(cache, names[0])), true)
    assert.notEqual(call(['--yes']).status, 0)
    assert.equal(fs.existsSync(path.join(cache, names[0])), true)
    assert.equal(call(['--yes', '--all-hosts-stopped', '--dry-run']).status, 0)
    assert.equal(fs.existsSync(path.join(cache, names[0])), true)
    const applied = call(['--yes', '--all-hosts-stopped'])
    assert.equal(applied.status, 0, applied.stderr)
    assert.equal(fs.existsSync(path.join(cache, names[0])), false)
    assert.equal(fs.existsSync(path.join(cache, names[2])), true)
    assert.equal(fs.existsSync(unknown), true)
  })
})

await test('Git selection prints an absolute config and never chooses a PATH WSL launcher', async () => {
  await withTempDir('manager-git', root => {
    const file = path.join(root, 'programs/Git/bin/bash.exe'), wsl = path.join(root, 'system/System32/bash.exe')
    for (const target of [file, wsl]) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'fixture') }
    const env = { ProgramFiles: path.join(root, 'programs'), SystemRoot: path.join(root, 'system'), PATH: path.dirname(wsl), DSH_HOME: root }
    assert.deepEqual(gitBashCandidates({ env, platform: 'win32' }).filter(value => value.startsWith(root)), [file])
    const selected = selectBashRuntime('git', { env, platform: 'win32' })
    assert.equal(selected.config.bashPath, file); assert.equal(selected.restricted.compatible, false)
    assert.equal(fs.existsSync(path.join(root, 'config.json')), false)
    assert.deepEqual(gitBashCandidates({ env, platform: 'linux' }), [])
  })
})

await test('managed selection retains the provisioned store layout and absence is actionable', async () => {
  await withTempDir('manager-select', home => {
    assert.deepEqual(managedBashInventory({ env: { DSH_HOME: home } }), [])
    assert.throws(() => selectBashRuntime('managed', { env: { DSH_HOME: home }, platform: 'win32', arch: 'x64' }), /bash-runtime install/)
    seed(home, '9.0', false)
    const directory = seed(home, '2.0')
    assert.equal(selectBashRuntime('managed', { env: { DSH_HOME: home }, platform: 'win32', arch: 'x64' }).file, path.join(directory, 'bin/bash.exe'))
  })
})

await test('offline build inputs require an absolute pinned executable digest', async () => {
  await withTempDir('manager-pin', root => {
    const file = path.join(root, 'bash.exe'); fs.writeFileSync(file, 'wrong bytes')
    assert.throws(() => pinnedBashExecutable({ file: 'bash.exe' }), /absolute executable path/)
    assert.throws(() => pinnedBashExecutable({ file }), /pinned executable SHA-256/)
  })
})

await test('the real CLI previews removal and applies it only with yes', async () => {
  await withTempDir('manager-cli', home => {
    const directory = seed(home, '1.0')
    const call = args => spawnSync(process.execPath, [path.join(PACKAGE_ROOT, 'bin/dsh-ops.mjs'), 'bash-runtime', ...args], { encoding: 'utf8', env: { ...process.env, DSH_HOME: home } })
    const preview = call(['remove']); assert.equal(preview.status, 0, preview.stderr); assert.match(preview.stdout, /"action": "preview"/); assert.equal(fs.existsSync(directory), true)
    const removed = call(['remove', '--yes']); assert.equal(removed.status, 0, removed.stderr); assert.equal(fs.existsSync(directory), false)
    assert.notEqual(call(['invalid']).status, 0)
    const install = call(['install', '--dry-run'])
    assert.equal(install.status, process.platform === 'win32' ? 0 : 1, install.stderr)
    if (process.platform === 'win32') assert.match(install.stdout, /dry run: no download, no writes/)
  })
})

await test('bash-runtime status reports the private runtime cache without writing to it', async () => {
  await withTempDir('manager-status', (home) => {
    const cache = path.join(home, 'dsh-ops', 'bash-ipc')
    const current = 'a'.repeat(24), older = 'b'.repeat(24)
    for (const [name, size] of [[current, 7], [older, 11]]) {
      fs.mkdirSync(path.join(cache, name), { recursive: true })
      fs.writeFileSync(path.join(cache, name, 'payload.bin'), Buffer.alloc(size))
      const when = new Date(Date.UTC(2026, 0, 2))
      fs.utimesSync(path.join(cache, name), when, when)
    }
    const bash = path.join(home, 'bash-stub')
    fs.writeFileSync(bash, 'stub')
    const config = path.join(home, 'config.json')
    fs.writeFileSync(config, JSON.stringify({ bashPath: bash, allowSystemShellFallback: false }))
    const run = spawnSync(process.execPath, [path.join(PACKAGE_ROOT, 'bin/dsh-ops.mjs'), 'bash-runtime', 'status', '--config', config],
      { encoding: 'utf8', env: { ...process.env, DSH_HOME: home } })
    assert.equal(run.status, 0, run.stderr)
    const parsed = JSON.parse(run.stdout)
    assert.equal(parsed.bashIpc.root, cache)
    assert.equal(parsed.bashIpc.generations, 2)
    assert.equal(parsed.bashIpc.totalBytes, 18)
    // Unmarked legacy directories are observed, never claimed automatically reclaimable.
    assert.equal(parsed.bashIpc.reclaimableBytes, 0)
    assert.deepEqual(parsed.bashIpc.entries.map((entry) => entry.name), [current, older])
    assert.equal(fs.readFileSync(path.join(cache, current, 'payload.bin')).length, 7, 'status never writes')
  })
})

await test('the Windows Bash payload is a declared, locked and assembled optional dependency', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  const lock = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package-lock.json'), 'utf8'))
  assert.equal(manifest.optionalDependencies?.['@dsh-ops/bash-win32-x64'], '0.2.1')
  assert.equal(lock.packages['']?.optionalDependencies?.['@dsh-ops/bash-win32-x64'], '0.2.1')
  assert.equal(lock.packages['node_modules/@dsh-ops/bash-win32-x64']?.version, '0.2.1')
  const { describePackages } = await import('../scripts/lib/build/assemble.js')
  const packages = describePackages('win32', 'x64', 'unused')
  assert.equal(packages.length, 1)
  assert.equal(packages[0].name, '@dsh-ops/bash-win32-x64')
  assert.equal(packages[0].kind, 'bash')
  assert.equal(packages[0].version, '0.2.1', 'the payload version comes from the committed pin, never the main version')
})

report('shells-manager')
