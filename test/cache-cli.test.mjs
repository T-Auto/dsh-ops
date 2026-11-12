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
import { cacheInventory, cacheReclaim } from '../lib/cli/cache-reclaim.js'
import { NIUBASH_MANIFEST_SHA256, NIUBASH_PIN } from '../lib/cli/niubash-payload.js'
import { NIUBASH_FACES } from '../lib/niubash/faces.js'
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
  const directory = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), name))
  fs.writeFileSync(path.join(directory, 'payload.bin'), Buffer.alloc(bytes))
  return directory
}

await test('scratch fixtures with the same label do not alias across runs', async () => {
  const first = scratchDirectory('dsh-ops-pwsh-cache', 8)
  const second = scratchDirectory('dsh-ops-pwsh-cache', 16)
  try {
    assert.notEqual(first, second)
    fs.rmSync(first, { recursive: true, force: true })
    assert.equal(fs.statSync(path.join(second, 'payload.bin')).size, 16)
  } finally {
    for (const directory of [first, second]) fs.rmSync(directory, { recursive: true, force: true })
  }
})

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

const LEGACY_MEMBER = 'winuxcmd/opt/niugit/etc/gitconfig'
const LEGACY_BYTES = '[http]\n\tsslBackend = schannel\n'

/** Emulate an old interrupted seal without depending on the removed runtime seal API. */
function legacyAcl(directory, operation) {
  if (process.platform !== 'win32') return
  const result = spawnSync('icacls.exe', [directory, ...operation, '/T', '/C', '/Q'], { encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.error ?? ''} ${result.stdout} ${result.stderr}`)
}

await test('offline legacy cleanup reclaims receiptless half-built hardlinks and copies, including deny ACLs', async () => {
  await withTempDir('cache-execution', root => {
    const home = path.join(root, 'home'), temp = path.join(root, 'temp')
    fs.mkdirSync(temp)
    const source = path.join(root, 'source')
    fs.writeFileSync(source, LEGACY_BYTES)
    const owned = ['hardlink', 'copy', 'partial-receipt', 'empty'].map(mode => path.join(temp, `dsh-ops-niu-exec-${mode}`))
    const files = []
    for (const [index, directory] of owned.entries()) {
      fs.mkdirSync(directory)
      if (index === 3) continue
      const file = path.join(directory, LEGACY_MEMBER)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      if (index === 0) fs.linkSync(source, file)
      else fs.copyFileSync(source, file)
      if (index === 2) fs.writeFileSync(path.join(directory, 'execution-provenance.json'), '{')
      fs.chmodSync(file, 0o444)
      files.push(file)
      legacyAcl(directory, ['/deny', '*S-1-1-0:(WD,AD,DE,DC)'])
    }
    const previous = process.env.DSH_OPS_EXEC_ROOT
    try {
      process.env.DSH_OPS_EXEC_ROOT = temp
      const inventory = cacheInventory({ home })
      for (const directory of owned) assert.equal(inventory.items.find(item => item.path === directory)?.decision, 'reclaimable')
      const options = { home, tmpRoot: temp, kinds: ['exec-tree'] }
      assert.throws(() => cacheReclaim({ ...options, apply: true }), /all-hosts-stopped/)
      cacheReclaim(options)
      assert.ok(owned.every(directory => fs.existsSync(directory)), 'preview preserves every tree')
      assert.equal(fs.statSync(files[0]).mode & 0o222, 0, 'inventory and preview leave the seal intact')
      const result = cacheReclaim({ ...options, apply: true, allHostsStopped: true })
      assert.equal(result.errors, 0, JSON.stringify(result.items))
      assert.equal(result.items.filter(item => item.action === 'deleted').length, 4)
      assert.ok(owned.every(directory => !fs.existsSync(directory)))
      assert.equal(fs.readFileSync(source, 'utf8'), LEGACY_BYTES, 'the shared source inode survives cleanup')
      assert.ok(fs.statSync(source).mode & 0o200, 'the shared readonly attribute was cleared')
    } finally {
      if (previous === undefined) delete process.env.DSH_OPS_EXEC_ROOT
      else process.env.DSH_OPS_EXEC_ROOT = previous
      for (const directory of owned) if (fs.existsSync(directory)) legacyAcl(directory, ['/remove:d', '*S-1-1-0'])
      for (const file of files) if (fs.existsSync(file)) fs.chmodSync(file, 0o666)
    }
  })
})

await test('legacy cleanup preserves unknown members, directories, links and same-size altered payload or faces', async () => {
  await withTempDir('cache-execution-foreign', root => {
    const home = path.join(root, 'home'), temp = path.join(root, 'temp')
    fs.mkdirSync(temp)
    const cases = [
      ['unknown-file', 'notes.txt', 'keep'],
      ['unknown-directory', 'private', undefined],
      ['altered-payload', LEGACY_MEMBER, 'x'.repeat(NIUBASH_PIN.sizes[LEGACY_MEMBER])],
      ['altered-face', `winuxcmd/usr/bin/${NIUBASH_FACES[0]}.exe`, ''],
    ]
    for (const [label, member, bytes] of cases) {
      const file = path.join(temp, `dsh-ops-niu-exec-${label}`, member)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      if (bytes === undefined) fs.mkdirSync(file)
      else fs.writeFileSync(file, bytes)
      if (label === 'altered-face') fs.truncateSync(file, NIUBASH_PIN.sizes['winuxcmd/usr/bin/winuxcmd.exe'])
    }
    const linked = path.join(temp, 'dsh-ops-niu-exec-linked')
    fs.mkdirSync(linked)
    fs.symlinkSync(root, path.join(linked, 'winuxcmd'), process.platform === 'win32' ? 'junction' : 'dir')
    const options = { home, tmpRoot: temp, kinds: ['exec-tree'] }
    const result = cacheReclaim({ ...options, apply: true, allHostsStopped: true })
    assert.equal(result.items.length, 5)
    assert.ok(result.items.every(item => item.action === 'unverified'), JSON.stringify(result.items))
    assert.ok(result.items.every(item => fs.existsSync(item.path)))
    assert.equal(result.deletedBytes, 0)
    assert.equal(result.errors, 0)
    for (const item of result.items.filter(item => /altered-/u.test(item.path))) assert.match(item.detail, /checksum mismatch/u)
  })
})

/** Seed namespace-owned partial prepared trees without a payload or receipt. */
function preparedFixture(root) {
  const home = path.join(root, 'home')
  const prepared = path.join(home, 'dsh-ops', 'shells', 'niubash-prepared')
  const oldHash = (NIUBASH_MANIFEST_SHA256 === 'a'.repeat(64) ? 'b' : 'a').repeat(64)
  const names = [oldHash, `${oldHash}.broken-one`, `${NIUBASH_MANIFEST_SHA256}.stage-two`,
    `${oldHash}.retired-three`, `${oldHash}.broken-one.retired-four`]
  fs.mkdirSync(prepared, { recursive: true })
  const directories = names.map(name => {
    const directory = path.join(prepared, name)
    fs.mkdirSync(directory)
    fs.writeFileSync(path.join(directory, 'partial.bin'), 'partial')
    return directory
  })
  return { home, prepared, directories }
}

await test('exec-tree status and offline reclaim include obsolete prepared versions and leftovers, never the current tree or links', async () => {
  await withTempDir('cache-prepared', root => {
    const { home, prepared, directories } = preparedFixture(root)
    const user = path.join(root, 'user')
    const current = path.join(prepared, NIUBASH_MANIFEST_SHA256)
    const unrelated = ['notes', 'f'.repeat(63), `${'e'.repeat(64)}.stage-`, `${'d'.repeat(64)}.other-one`]
    fs.mkdirSync(user)
    fs.mkdirSync(current)
    fs.writeFileSync(path.join(current, 'keep'), 'current')
    for (const name of unrelated) fs.mkdirSync(path.join(prepared, name))
    const outside = path.join(root, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'keep'), 'outside')
    const linked = path.join(prepared, 'c'.repeat(64) + '.broken-link')
    fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
    const originalNames = fs.readdirSync(prepared).sort()
    const status = runCli(home, user, ['status', '--kind', 'exec-tree', '--json'])
    assert.equal(status.status, 0, status.stderr)
    const rows = status.json.items.filter(item => item.evidence === 'prepared-cache-namespace')
    assert.deepEqual(rows.map(item => item.path).sort(), [...directories].sort())
    assert.ok(rows.every(item => item.decision === 'reclaimable' && item.bytes === 7 && item.files === 1))
    assert.equal(status.json.items.some(item => item.path === current || item.path === linked), false)
    const preview = runCli(home, user, ['reclaim', '--kind', 'exec-tree', '--json'])
    assert.equal(preview.status, 0, preview.stderr)
    const refused = runCli(home, user, ['reclaim', '--yes', '--kind', 'exec-tree'])
    assert.equal(refused.status, 2)
    assert.deepEqual(fs.readdirSync(prepared).sort(), originalNames, 'status, preview and refusal do not select or prepare a runtime')
    const temp = path.join(root, 'temp')
    fs.mkdirSync(temp)
    const applied = cacheReclaim({ home, tmpRoot: temp, kinds: ['exec-tree'], apply: true, allHostsStopped: true })
    assert.equal(applied.errors, 0)
    assert.equal(applied.deletedBytes, directories.length * 7)
    assert.ok(applied.items.every(item => item.action === 'deleted'))
    assert.ok(directories.every(directory => !fs.existsSync(directory)))
    assert.equal(fs.readFileSync(path.join(current, 'keep'), 'utf8'), 'current')
    assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'outside')
    assert.equal(fs.lstatSync(linked).isSymbolicLink(), true)
    assert.ok(unrelated.every(name => fs.existsSync(path.join(prepared, name))))
  })
})

await test('prepared reclaim renames a live name once before deletion, removes a retired name in place, retains a busy sibling and never selects a missing current version', async () => {
  await withTempDir('cache-prepared-busy', root => {
    const { home, prepared, directories } = preparedFixture(root)
    const temp = path.join(root, 'temp')
    fs.mkdirSync(temp)
    const busy = directories[0]
    const rename = fs.renameSync, remove = fs.rmSync
    const renames = [], removals = []
    fs.renameSync = (source, destination) => {
      renames.push([source, destination])
      assert.match(destination.slice(source.length), /^\.retired-[A-Za-z0-9-]+$/u)
      if (source === busy) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      return rename(source, destination)
    }
    fs.rmSync = (target, options) => {
      removals.push(target)
      const retiredInPlace = /\.retired-[A-Za-z0-9-]+$/u.test(target) && directories.includes(target)
      assert.ok(retiredInPlace || renames.some(([source, destination]) => source !== busy && destination === target), 'delete only a successfully renamed directory or an already retired one')
      if (retiredInPlace) assert.ok(!renames.some(([source]) => source === target), 'a retired name is never renamed again')
      assert.equal(options.maxRetries ?? 0, 0, 'deletion has no retries')
      return remove(target, options)
    }
    let result
    try {
      result = cacheReclaim({ home, tmpRoot: temp, kinds: ['exec-tree'], apply: true, allHostsStopped: true })
    } finally {
      fs.renameSync = rename
      fs.rmSync = remove
    }
    assert.equal(result.errors, 1)
    assert.equal(result.items.find(item => item.path === busy)?.action, 'kept')
    assert.equal(renames.filter(([source]) => source === busy).length, 1, 'busy rename is not retried')
    assert.equal(removals.length, directories.length - 1)
    assert.equal(fs.readFileSync(path.join(busy, 'partial.bin'), 'utf8'), 'partial')
    assert.ok(directories.slice(1).every(directory => !fs.existsSync(directory)), 'one busy sibling does not block other candidates')
    assert.deepEqual(fs.readdirSync(prepared), [path.basename(busy)], 'cleanup neither selects nor prepares the missing current version')
  })
})

report('cache-cli')
