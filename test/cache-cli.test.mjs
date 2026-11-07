/**
 * "dsh-ops cache": the report, the preview, the offline confirmation, and the
 * exit codes. Every case seeds a root this suite owns and names it with --kind,
 * so a real temporary directory on the runner is never a target.
 */
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PACKAGE_ROOT, assert, report, test, withTempDir } from './lib/harness.mjs'
import { pendingRoot, recordPendingScratch } from '../lib/cli/pending-scratch.js'

const CLI = path.join(PACKAGE_ROOT, 'bin', 'dsh-ops.mjs')

/** Run the CLI with one throwaway home. */
function runCli(home, user, args) {
  const result = spawnSync(process.execPath, [CLI, 'cache', ...args], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home, HOME: user, USERPROFILE: user },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', json: tryJson(result.stdout) }
}

/** Parse the JSON a --json run prints, or undefined. */
function tryJson(text) {
  try { return JSON.parse(text) } catch { return undefined }
}

/** A scratch directory at the temporary root, removed by the caller. */
function scratchDirectory(name, bytes) {
  const directory = path.join(fs.realpathSync.native(os.tmpdir()), name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'payload.bin'), Buffer.alloc(bytes))
  return directory
}

await test('status reports and reclaim previews without deleting, and --yes alone is a refusal', async () => {
  await withTempDir('cache-pending', (root) => {
    const home = path.join(root, 'home'), user = path.join(root, 'user')
    fs.mkdirSync(user, { recursive: true })
    // The records are minutes old here: the count budget, not the age budget, is under test.
    const now = Date.now()
    const directories = []
    try {
      for (let index = 0; index < 5; index += 1) {
        const name = 'dsh-ops-pwsh-cache' + index
        const directory = scratchDirectory(name, 16)
        directories.push(directory)
        recordPendingScratch({
          root: pendingRoot(home), kind: 'pwsh', pinSha256: String(index).repeat(64).slice(0, 64),
          scratch: directory, reason: 'the downloaded archive did not match the pinned sha256',
          now: () => now - index * 60_000,
        })
      }
      const status = runCli(home, user, ['status', '--json', '--kind', 'pending-scratch'])
      assert.equal(status.status, 0, status.stderr)
      const rows = status.json.items.filter((item) => item.kind === 'pending-scratch')
      assert.equal(rows.length, 5)
      assert.equal(rows.filter((item) => item.decision === 'reclaimable').length, 1, 'the oldest is outside the count budget')
      assert.equal(rows.filter((item) => item.evidence === 'pending-record').length, 5)

      const preview = runCli(home, user, ['reclaim', '--kind', 'pending-scratch'])
      assert.equal(preview.status, 0, preview.stderr)
      assert.match(preview.stdout, /Preview only/u)
      assert.equal(directories.every((directory) => fs.existsSync(directory)), true, 'a preview deletes nothing')

      const refused = runCli(home, user, ['reclaim', '--yes', '--kind', 'pending-scratch'])
      assert.equal(refused.status, 2, 'a --yes without the offline confirmation is a refusal')
      assert.match(refused.stderr, /all-hosts-stopped/u)
      assert.equal(directories.every((directory) => fs.existsSync(directory)), true)

      const applied = runCli(home, user, ['reclaim', '--yes', '--all-hosts-stopped', '--kind', 'pending-scratch', '--json'])
      assert.equal(applied.status, 0, applied.stderr)
      assert.ok(applied.json.deletedBytes > 0, 'the report names the bytes it freed')
      const oldest = directories[4]
      assert.equal(fs.existsSync(oldest), false, 'the reclaimable directory is gone')
      assert.equal(directories.slice(0, 4).every((directory) => fs.existsSync(directory)), true, 'the budget keeps four')
    } finally {
      for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})

await test('audit writer temporaries are reclaimable by namespace, and nothing else in .dsh-ops is', async () => {
  await withTempDir('cache-audit', (root) => {
    const home = path.join(root, 'home'), user = path.join(root, 'user'), store = path.join(root, 'repo', '.dsh-ops')
    fs.mkdirSync(user, { recursive: true })
    fs.mkdirSync(store, { recursive: true })
    const temporary = path.join(store, 'j-' + randomUUID() + '.' + randomUUID() + '.tmp')
    fs.writeFileSync(temporary, 'half written\n')
    fs.writeFileSync(path.join(store, 'notes.txt'), 'not ours\n')
    fs.writeFileSync(path.join(store, 'j-' + randomUUID() + '.json'), '{}\n')

    const status = runCli(home, user, ['status', '--json', '--root', path.join(root, 'repo'), '--kind', 'audit-tmp'])
    assert.equal(status.status, 0, status.stderr)
    assert.deepEqual(status.json.items.filter((item) => item.kind === 'audit-tmp').map((item) => item.path), [temporary])

    const applied = runCli(home, user, ['reclaim', '--yes', '--all-hosts-stopped', '--root', path.join(root, 'repo'), '--kind', 'audit-tmp'])
    assert.equal(applied.status, 0, applied.stderr)
    assert.equal(fs.existsSync(temporary), false)
    assert.equal(fs.existsSync(path.join(store, 'notes.txt')), true, 'a foreign name is never removed')
    assert.equal(fs.readdirSync(store).filter((name) => name.endsWith('.json')).length, 1, 'a committed record survives')
  })
})

await test('offline cleanup reclaims quarantined Bash IPC copies beyond the two it keeps', async () => {
  await withTempDir('cache-quarantine', (root) => {
    const home = path.join(root, 'home'), user = path.join(root, 'user'), ipc = path.join(home, 'dsh-ops', 'bash-ipc')
    fs.mkdirSync(ipc, { recursive: true })
    fs.mkdirSync(user, { recursive: true })
    const names = ['a'.repeat(24), 'b'.repeat(24), 'c'.repeat(24)]
    const directories = names.map((name, index) => {
      const directory = path.join(ipc, name + '.bad-m' + index)
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(directory, 'payload.bin'), Buffer.alloc(8))
      const when = new Date(Date.UTC(2026, 0, 1 + index))
      fs.utimesSync(directory, when, when)
      return directory
    })
    const status = runCli(home, user, ['status', '--json', '--kind', 'ipc-quarantine'])
    assert.equal(status.status, 0, status.stderr)
    const rows = status.json.items.filter((item) => item.kind === 'ipc-quarantine')
    assert.equal(rows.length, 3)
    assert.equal(rows.filter((item) => item.decision === 'reclaimable').length, 1, 'the newest two are retained')

    const applied = runCli(home, user, ['reclaim', '--yes', '--all-hosts-stopped', '--kind', 'ipc-quarantine'])
    assert.equal(applied.status, 0, applied.stderr)
    assert.equal(fs.existsSync(directories[0]), false, 'the oldest quarantine is reclaimed offline')
    assert.equal(fs.existsSync(directories[1]), true)
    assert.equal(fs.existsSync(directories[2]), true)
  })
})

await test('cache status on a clean home succeeds and a bad kind is rejected', async () => {
  await withTempDir('cache-empty', (root) => {
    const home = path.join(root, 'home'), user = path.join(root, 'user')
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(user, { recursive: true })
    const status = runCli(home, user, ['status', '--kind', 'pending-scratch'])
    assert.equal(status.status, 0, status.stderr)
    assert.match(status.stdout, /Preview only/u)
    const bad = runCli(home, user, ['status', '--kind', 'session-temp'])
    assert.notEqual(bad.status, 0, 'an unknown kind is rejected rather than scanned')
  })
})

report('cache-cli')
