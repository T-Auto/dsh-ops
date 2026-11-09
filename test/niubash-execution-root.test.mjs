/**
 * Hardlink execution clone, read-only seal and stat-only verification, on
 * synthetic trees with injected filesystem operations.
 *
 * The real Niubash payload only exists on Windows x64 and is validated by the
 * Windows-gated suites; these checks exercise the mechanics on every platform,
 * including the EXDEV fallback and the Windows ACL paths that the other suites
 * cannot reach off Windows.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import {
  cloneExecutionTree,
  nodeTreeOps,
  verifyExecutionReceipt,
  verifyTreeStat,
} from '../lib/niubash/execution-tree.js'
import {
  isSealedMode,
  releaseShared,
  retainShared,
  removeSealedTree,
  sealReadOnly,
  sealShared,
  sealTree,
  unsealTree,
} from '../lib/niubash/seal.js'
import { executionRootFor, isSameDirectory, niubashDeepVerification, niubashExecutionRootParent, prepareNiubash, sameVolume, sameVolumeRoots } from '../lib/niubash/runtime.js'
import { NIUBASH_PIN, niubashExecutionReceipt } from '../lib/cli/niubash-payload.js'

const CONTENT = {
  'LICENSE.txt': 'license-bytes',
  'bin/winuxcmd.exe': 'E'.repeat(4096),
  'bin/helper.dll': 'dll-bytes',
}
const FILES = Object.fromEntries(Object.entries(CONTENT).map(([name, content]) => [name, Buffer.byteLength(content)]))
const DERIVED = { 'bin/cat.exe': 'bin/winuxcmd.exe', 'bin/awk.exe': 'bin/winuxcmd.exe' }
const DIRECTORIES = ['bin']
const STATE_DIRECTORIES = ['tmp', 'tmp/shm']
const EXTRA = ['provenance.json']
const RECEIPT = 'execution-provenance.json'
// Synthetic trees never need the Windows ACL; the ACL paths are covered by
// injected runners below. Keeping the platform off win32 keeps the fixtures
// cheap on a Windows host too.
const NO_ACL = { platform: 'linux' }

function buildSource(base) {
  const source = path.join(base, 'source')
  fs.mkdirSync(path.join(source, 'bin'), { recursive: true })
  for (const [name, content] of Object.entries(CONTENT)) fs.writeFileSync(path.join(source, name), content)
  fs.writeFileSync(path.join(source, 'provenance.json'), '{"version":1}')
  return source
}

async function cloneInto(source, root, options = {}) {
  const clone = await cloneExecutionTree({ source, root, files: FILES, derived: DERIVED, directories: DIRECTORIES,
    stateDirectories: STATE_DIRECTORIES, extra: EXTRA, ...options })
  return clone
}

async function cloneTree(base, options = {}) {
  const source = buildSource(base)
  const sourceLinks = Object.fromEntries(Object.keys(FILES).map(name => [name, fs.lstatSync(path.join(source, name)).nlink]))
  const root = path.join(base, 'exec')
  const clone = await cloneInto(source, root, options)
  return { source, root, clone, sourceLinks }
}

function filesOf(root, clone) {
  return Object.keys(clone.sizes).map(name => path.join(root, name))
}

/** Seal the synthetic clone and write the same kind of receipt production writes. */
async function sealAndRecord(root, clone) {
  const files = filesOf(root, clone)
  const writable = [...STATE_DIRECTORIES.map(directory => path.join(root, directory)), root]
  await sealTree({ root, files, writableDirectories: writable, ...NO_ACL })
  const receipt = { version: 1, mode: clone.mode, seal: 'readonly', sourceManifestSha256: '0'.repeat(64) }
  const text = JSON.stringify(receipt)
  await fs.promises.writeFile(path.join(root, RECEIPT), text)
  await sealReadOnly([path.join(root, RECEIPT)])
  return {
    receipt,
    sizes: { ...clone.sizes, [RECEIPT]: Buffer.byteLength(text) },
    links: { ...clone.links, [RECEIPT]: fs.lstatSync(path.join(root, RECEIPT)).nlink },
    directories: [...DIRECTORIES, ...STATE_DIRECTORIES],
  }
}

/** A sparse payload with the real manifest sizes and the receipt a provisioned tree carries. */
function buildPinnedPayload(base) {
  const source = path.join(base, 'payload')
  fs.mkdirSync(source, { recursive: true })
  for (const directory of NIUBASH_PIN.directories) fs.mkdirSync(path.join(source, directory), { recursive: true })
  for (const [name, size] of Object.entries(NIUBASH_PIN.sizes)) {
    fs.writeFileSync(path.join(source, name), '')
    fs.truncateSync(path.join(source, name), size)
  }
  fs.writeFileSync(path.join(source, 'provenance.json'), `${JSON.stringify({
    version: 1, backend: 'niubash', upstreamVersion: NIUBASH_PIN.upstreamVersion,
    archive: NIUBASH_PIN.archive, url: NIUBASH_PIN.url, archiveSha256: NIUBASH_PIN.archiveSha256,
    archiveBytes: NIUBASH_PIN.archiveBytes, executable: NIUBASH_PIN.executable,
    executableSha256: NIUBASH_PIN.executableSha256, files: NIUBASH_PIN.files, sizes: NIUBASH_PIN.sizes,
  }, null, 2)}\n`)
  return source
}

/** Leave every synthetic file writable so the harness can always remove its temp tree. */
async function tidy(base) {
  await unsealTree(base, NO_ACL).catch(() => undefined)
}

await test('execution tree is a hardlink clone with zero copied data bytes', async () => withTempDir('niu-clone', async base => {
  try {
    const { source, root, clone, sourceLinks } = await cloneTree(base)
    assert.equal(clone.mode, 'hardlink')
    assert.equal(clone.dataBytes, 0)
    for (const name of Object.keys(FILES)) {
      const sourceStat = fs.lstatSync(path.join(source, name))
      const targetStat = fs.lstatSync(path.join(root, name))
      assert.equal(targetStat.size, sourceStat.size, name)
      assert.equal(clone.links[name], targetStat.nlink, name)
      // Every clone name adds one link; winuxcmd.exe also parents the argv0 faces.
      const faces = name === 'bin/winuxcmd.exe' ? Object.keys(DERIVED).length : 0
      assert.equal(targetStat.nlink, sourceLinks[name] + 1 + faces, name)
      if (process.platform !== 'win32') assert.equal(targetStat.ino, sourceStat.ino, name)
    }
    assert.equal(clone.sizes['provenance.json'], Buffer.byteLength('{"version":1}'))
    // The argv0 faces share winuxcmd.exe's inode instead of copying 153 times.
    assert.equal(fs.lstatSync(path.join(root, 'bin/cat.exe')).nlink, fs.lstatSync(path.join(root, 'bin/winuxcmd.exe')).nlink)
    assert.equal(fs.readFileSync(path.join(root, 'bin/cat.exe'), 'utf8'), CONTENT['bin/winuxcmd.exe'])
    assert.equal(fs.existsSync(path.join(root, 'tmp/shm')), true)
    await verifyTreeStat({ root, sizes: clone.sizes, links: clone.links,
      directories: [...DIRECTORIES, ...STATE_DIRECTORIES], sealed: false })
  } finally { await tidy(base) }
}))

await test('a cross-device link rebuilds the whole tree as copies and records the mode', async () => withTempDir('niu-exdev', async base => {
  try {
    const crossDevice = Object.assign(new Error('cross-device link'), { code: 'EXDEV' })
    const { source, root, clone } = await cloneTree(base, { ops: { link: async () => { throw crossDevice } } })
    assert.equal(clone.mode, 'copy')
    assert.equal(clone.fallback?.code, 'EXDEV')
    assert.match(clone.fallback?.detail ?? '', /cross-device/u)
    assert.equal(clone.dataBytes, Object.values(clone.sizes).reduce((total, size) => total + size, 0))
    for (const name of Object.keys(clone.sizes)) {
      assert.equal(fs.lstatSync(path.join(root, name)).nlink, 1, name)
    }
    for (const [name, content] of Object.entries(CONTENT)) {
      assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), content, name)
    }
    for (const face of Object.keys(DERIVED)) {
      assert.equal(fs.readFileSync(path.join(root, face), 'utf8'), CONTENT['bin/winuxcmd.exe'], face)
    }
    if (process.platform !== 'win32') {
      assert.notEqual(fs.lstatSync(path.join(root, 'bin/cat.exe')).ino, fs.lstatSync(path.join(root, 'bin/winuxcmd.exe')).ino)
      assert.notEqual(fs.lstatSync(path.join(root, 'bin/winuxcmd.exe')).ino, fs.lstatSync(path.join(source, 'bin/winuxcmd.exe')).ino)
    }
    await verifyTreeStat({ root, sizes: clone.sizes, links: clone.links,
      directories: [...DIRECTORIES, ...STATE_DIRECTORIES], sealed: false })
  } finally { await tidy(base) }
}))

await test('cancellation stops the clone at the next checkpoint', async () => withTempDir('niu-cancel', async base => {
  try {
    const source = buildSource(base)
    const controller = new AbortController()
    let links = 0
    const cloning = cloneExecutionTree({ source, root: path.join(base, 'exec'), files: FILES, derived: DERIVED,
      directories: DIRECTORIES, stateDirectories: STATE_DIRECTORIES, extra: EXTRA, signal: controller.signal,
      ops: { link: async (from, to) => { links += 1; if (links === 2) controller.abort(new Error('cancel clone')); return nodeTreeOps.link(from, to) } } })
    await assert.rejects(cloning, /cancel clone/)
    assert.ok(links >= 1 && links < Object.keys(FILES).length + EXTRA.length + Object.keys(DERIVED).length)
  } finally { await tidy(base) }
}))

await test('the read-only seal covers the shared inode and unseal makes removal possible', async () => withTempDir('niu-seal', async base => {
  try {
    const { source, root, clone } = await cloneTree(base)
    const files = filesOf(root, clone)
    const sealed = await sealTree({ root, files, ...NO_ACL })
    assert.equal(sealed.level, 'readonly')
    assert.deepEqual(sealed.diagnostics, [])
    for (const file of files) assert.equal(isSealedMode(fs.lstatSync(file).mode), true, file)
    // Execution names are hardlinks of the source inode: sealing one seals both.
    for (const name of Object.keys(FILES)) assert.equal(isSealedMode(fs.lstatSync(path.join(source, name)).mode), true, name)
    // Directories stay writable; only files are sealed.
    assert.equal(isSealedMode(fs.lstatSync(path.join(root, 'tmp')).mode), false)
    assert.deepEqual(await unsealTree(root, NO_ACL), [])
    for (const file of files) assert.equal(isSealedMode(fs.lstatSync(file).mode), false, file)
    for (const name of Object.keys(FILES)) assert.equal(isSealedMode(fs.lstatSync(path.join(source, name)).mode), false, name)
    await removeSealedTree(root, NO_ACL)
    assert.equal(fs.existsSync(root), false)
    assert.equal(fs.existsSync(path.join(source, 'LICENSE.txt')), true)
    assert.equal(fs.lstatSync(path.join(source, 'LICENSE.txt')).nlink, 1)
  } finally { await tidy(base) }
}))

await test('the Windows deny ACL is one recursive batch per tree, and degrades with diagnostics', async () => withTempDir('niu-acl', async base => {
  try {
    const { root, clone } = await cloneTree(base)
    const files = filesOf(root, clone)
    const calls = []
    const applied = await sealTree({ root, files, writableDirectories: [path.join(root, 'tmp'), path.join(root, 'tmp/shm')],
      platform: 'win32', runAcl: async args => { calls.push([...args]); return [] } })
    assert.equal(applied.level, 'readonly+acl')
    assert.deepEqual(applied.diagnostics, [])
    const denials = calls.filter(args => args.includes('/deny'))
    assert.equal(denials.length, 1, 'one recursive deny, never one process per file')
    assert.deepEqual(denials[0], [root, '/deny', '*S-1-1-0:(WD,AD,DE,DC)', '/T', '/C', '/Q'])
    // FILE_WRITE_ATTRIBUTES stays available so a later pass can re-apply READONLY.
    assert.doesNotMatch(denials[0][2], /WEA/u)
    assert.ok(calls.length <= 1 + 1 + 2, 'the deny plus one re-allow per writable directory, plus the root')
    assert.ok(calls.length < files.length, 'never a per-file process')
    for (const file of files) assert.equal(isSealedMode(fs.lstatSync(file).mode), true, file)

    const degraded = await sealTree({ root, files, platform: 'win32',
      runAcl: async () => ['icacls could not run: missing'] })
    assert.equal(degraded.level, 'readonly')
    assert.deepEqual(degraded.diagnostics, ['icacls could not run: missing'])
    for (const file of files) assert.equal(isSealedMode(fs.lstatSync(file).mode), true, file)

    let denyCalls = 0
    const rolledBack = await sealTree({ root, files, writableDirectories: [path.join(root, 'tmp')],
      platform: 'win32', runAcl: async args => {
        if (args.includes('/deny')) { denyCalls += 1; return [] }
        return args.includes('/T') ? [] : ['state directory re-allow failed']
      } })
    assert.equal(denyCalls, 1)
    assert.equal(rolledBack.level, 'readonly')
    assert.ok(rolledBack.diagnostics.some(text => /rolled back/u.test(text)))
  } finally { await tidy(base) }
}))

await test('stat-only verification rejects every structural deviation without reading payload bytes', async () => withTempDir('niu-stat', async base => {
  try {
    const { root, clone } = await cloneTree(base)
    const record = await sealAndRecord(root, clone)
    const verify = (options = {}) => verifyTreeStat({ root, sizes: record.sizes, links: record.links,
      directories: record.directories, sealed: true, ...options })
    await verify()
    // The whole point of the change: zero payload bytes read on the pre-spawn check.
    let reads = 0
    await verify({ ops: { readFile: async file => { reads += 1; return nodeTreeOps.readFile(file) } } })
    assert.equal(reads, 0)

    await assert.rejects(verify({ sizes: { ...record.sizes, 'LICENSE.txt': record.sizes['LICENSE.txt'] + 1 } }), /size mismatch/u)
    await assert.rejects(verify({ sizes: { ...record.sizes, 'bin/extra.exe': 1 } }), /Incomplete/u)
    await assert.rejects(verify({ directories: [...record.directories, 'missing'] }), /Incomplete/u)
    await assert.rejects(verify({ links: { ...record.links, 'bin/winuxcmd.exe': record.links['bin/winuxcmd.exe'] + 1 } }), /link count mismatch/u)

    fs.writeFileSync(path.join(root, 'extra.exe'), 'extra')
    await assert.rejects(verify(), /Unsafe Niubash execution tree member/u)
    fs.unlinkSync(path.join(root, 'extra.exe'))

    fs.mkdirSync(path.join(root, 'unexpected'))
    await assert.rejects(verify(), /Unknown Niubash execution directory/u)
    fs.rmdirSync(path.join(root, 'unexpected'))

    await assert.rejects(verifyExecutionReceipt(root, RECEIPT, { ...record.receipt, mode: 'copy' }), /Invalid Niubash execution receipt/u)
    await verifyExecutionReceipt(root, RECEIPT, record.receipt)

    await unsealTree(root, NO_ACL)
    await assert.rejects(verify(), /is not sealed/u)

    fs.unlinkSync(path.join(root, 'LICENSE.txt'))
    assert.equal(fs.existsSync(path.join(root, 'LICENSE.txt')), false)
    assert.equal(fs.existsSync(path.join(root, 'bin/cat.exe')), true)
    await sealReadOnly([...filesOf(root, clone), path.join(root, RECEIPT)].filter(file => fs.existsSync(file)))
    await assert.rejects(verify(), /Incomplete/u)

    // A junction works without the Windows symlink privilege, and a link entry is
    // rejected the same way on every platform.
    const alias = path.join(root, 'alias-dir')
    fs.symlinkSync(path.join(root, 'bin'), alias, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(verify(), /Unsafe Niubash (?:execution )?tree member/u)
    if (process.platform === 'win32') fs.rmdirSync(alias)
    else fs.unlinkSync(alias)
  } finally { await tidy(base) }
}))

await test('concurrent execution trees keep the shared inode sealed until the last one is disposed', async () => withTempDir('niu-shared', async base => {
  try {
    const source = buildSource(base)
    const first = await cloneInto(source, path.join(base, 'exec-1'))
    const second = await cloneInto(source, path.join(base, 'exec-2'))
    const request = (root, clone) => ({ root, files: filesOf(root, clone),
      writableDirectories: [...STATE_DIRECTORIES.map(directory => path.join(root, directory)), root], ...NO_ACL })
    await sealShared(source, request(path.join(base, 'exec-1'), first))
    await sealShared(source, request(path.join(base, 'exec-2'), second))
    assert.equal(isSealedMode(fs.lstatSync(path.join(source, 'LICENSE.txt')).mode), true)
    // The first tree finishes while the second still runs: its unseal and removal
    // must wait, or the running tree would get a writable window through its links.
    await releaseShared(source, path.join(base, 'exec-1'))
    assert.equal(fs.existsSync(path.join(base, 'exec-1')), true)
    assert.equal(isSealedMode(fs.lstatSync(path.join(base, 'exec-2/bin/winuxcmd.exe')).mode), true)
    assert.equal(isSealedMode(fs.lstatSync(path.join(source, 'LICENSE.txt')).mode), true)
    await releaseShared(source, path.join(base, 'exec-2'))
    assert.equal(fs.existsSync(path.join(base, 'exec-1')), false)
    assert.equal(fs.existsSync(path.join(base, 'exec-2')), false)
    assert.equal(isSealedMode(fs.lstatSync(path.join(source, 'LICENSE.txt')).mode), false)
  } finally { await tidy(base) }
}))

await test('a link created outside the tree changes the recorded link count', async () => withTempDir('niu-link', async base => {
  try {
    const { root, clone } = await cloneTree(base)
    const record = await sealAndRecord(root, clone)
    const alias = path.join(base, 'outside-alias')
    fs.linkSync(path.join(root, 'bin/helper.dll'), alias)
    await assert.rejects(verifyTreeStat({ root, sizes: record.sizes, links: record.links,
      directories: record.directories, sealed: true }), /link count mismatch/u)
    fs.unlinkSync(alias)
    await verifyTreeStat({ root, sizes: record.sizes, links: record.links, directories: record.directories, sealed: true })
  } finally { await tidy(base) }
}))

await test('the execution root parent and the deep escape hatch come from the environment', () => {
  assert.equal(niubashExecutionRootParent({}), os.tmpdir())
  assert.equal(niubashExecutionRootParent({ DSH_OPS_EXEC_ROOT: '   ' }), os.tmpdir())
  assert.equal(niubashExecutionRootParent({ DSH_OPS_EXEC_ROOT: 'relative/root' }), path.resolve('relative/root'))
  assert.equal(niubashDeepVerification({ NIUBASH_VERIFY: 'deep' }), true)
  assert.equal(niubashDeepVerification({ NIUBASH_VERIFY: 'DEEP' }), false)
  assert.equal(niubashDeepVerification({}), false)
})

await test('a same-volume payload keeps the OS temporary directory', () => {
  // Without a source there is nothing to compare against.
  assert.equal(niubashExecutionRootParent({}), os.tmpdir())
  // A payload below the temp directory is on the same volume by construction.
  assert.equal(niubashExecutionRootParent({}, path.join(os.tmpdir(), 'payload', 'niubash')), os.tmpdir())
  assert.equal(sameVolume(os.tmpdir(), path.join(os.tmpdir(), 'payload')), true)
})

await test('a payload on another volume moves the execution root onto that volume', () => {
  // Synthetic drive roots keep this deterministic on every platform: reverting the
  // same-volume rule now fails here instead of skipping on POSIX or a non-C: TEMP.
  const rootOf = name => name.startsWith('Z:') ? 'z:\\' : 'c:\\'
  assert.equal(sameVolumeRoots('c:\\', 'c:\\'), true)
  assert.equal(sameVolumeRoots('c:\\', 'z:\\'), false)
  // A UNC share or an extended-length prefix is never proven equal to a drive root.
  assert.equal(sameVolumeRoots('\\\\server\\share\\', '\\\\server\\share\\sub'), false)
  assert.equal(sameVolumeRoots('\\\\?\\C:\\', 'c:\\'), false)
  // Equal UNC roots do read as the same share.
  assert.equal(sameVolumeRoots('\\\\server\\share\\', '\\\\server\\share\\'), true)

  const cross = executionRootFor('Z:\\payload\\niubash', 'C:\\temp', rootOf)
  // One fixed, readable name: the ownership check decides who may use it, not
  // whether the name hides the account.
  assert.equal(path.basename(cross), 'dsh-ops-exec')
  assert.equal(executionRootFor('C:\\payload\\niubash', 'C:\\temp', rootOf), 'C:\\temp')

  // An explicit operator choice always wins over the same-volume heuristic.
  assert.equal(niubashExecutionRootParent({ DSH_OPS_EXEC_ROOT: 'D:\\custom-root' }, 'Z:\\payload'),
    path.resolve('D:\\custom-root'))
})

await test('a symlinked temp path still names the same directory', async () => withTempDir('niu-same-dir', async base => {
  // Only the realpath short-circuit makes a link and its target compare equal; a
  // plain `path.resolve` comparison reports two different directories and would
  // then treat the platform temp directory as a foreign, owner-checked root.
  const target = path.join(base, 'real-temp')
  fs.mkdirSync(target)
  const link = path.join(base, 'linked-temp')
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    // No symbolic-link privilege: name the skip instead of passing with zero
    // assertions. A run that requires the runtime treats it as a failure, exactly
    // as a suite skip does, so a green gate can never hide an unverified path.
    const code = error && typeof error === 'object' && 'code' in error ? error.code : 'unknown'
    if (process.env.DSH_OPS_REQUIRE_RUNTIME === '1') throw new Error(`cannot create a symbolic-link fixture on this platform (${code})`)
    console.log(`  skip a symlinked temp path still names the same directory (no symbolic-link privilege: ${code})`)
    return
  }
  assert.equal(await isSameDirectory(link, target), true)
  assert.equal(await isSameDirectory(link, path.join(base, 'other')), false)
  // A trailing separator must not change the answer.
  assert.equal(await isSameDirectory(link + path.sep, target), true)
}))

await test('a hardlink refusal builds a complete copy tree and records the cause', async () => withTempDir('niu-fallback', async base => {
  try {
    const refusal = Object.assign(new Error('hardlink refused by the filesystem'), { code: 'EPERM' })
    const { root, clone } = await cloneTree(base, { ops: { link: async () => { throw refusal } } })
    assert.equal(clone.mode, 'copy')
    assert.equal(clone.fallback?.code, 'EPERM')
    assert.match(clone.fallback?.detail ?? '', /hardlink refused/u)
    // The fallback is a whole-tree rebuild, so nothing is left half linked or missing.
    for (const [name, content] of Object.entries(CONTENT)) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), content, name)
    await verifyTreeStat({ root, sizes: clone.sizes, links: clone.links,
      directories: [...DIRECTORIES, ...STATE_DIRECTORIES], sealed: false })
    const slowPath = niubashExecutionReceipt({ mode: clone.mode, seal: 'readonly', cloneFallback: clone.fallback })
    assert.equal(slowPath.cloneFallbackCode, 'EPERM')
    assert.equal(slowPath.cloneDiagnostics.length, 1)
    const fastPath = niubashExecutionReceipt({ mode: 'hardlink', seal: 'readonly+acl' })
    assert.equal(fastPath.cloneFallbackCode, null)
    assert.deepEqual(fastPath.cloneDiagnostics, [])
  } finally { await tidy(base) }
}))

await test('an UNKNOWN link refusal falls back to copies instead of failing every Bash call', async () => withTempDir('niu-unknown', async base => {
  try {
    // Windows reports ERROR_TOO_MANY_LINKS, a filter driver holding the target directory
    // and a directory still being torn down all as `UNKNOWN`, with no finer code on the
    // Node error. Rethrowing it took the whole Bash runtime down until something outside
    // the plugin cleared the condition; the copy fallback exists for exactly this case.
    const refusal = Object.assign(new Error("UNKNOWN: unknown error, link 'payload' -> 'clone'"), { code: 'UNKNOWN' })
    const { root, clone } = await cloneTree(base, { ops: { link: async () => { throw refusal } } })
    assert.equal(clone.mode, 'copy')
    assert.equal(clone.fallback?.code, 'UNKNOWN')
    assert.match(clone.fallback?.detail ?? '', /unknown error/u)
    for (const [name, content] of Object.entries(CONTENT)) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), content, name)
    const receipt = niubashExecutionReceipt({ mode: clone.mode, seal: 'readonly', cloneFallback: clone.fallback })
    assert.equal(receipt.cloneFallbackCode, 'UNKNOWN')
  } finally { await tidy(base) }
}))

await test('a clone that must not share payload inodes copies without a fallback', async () => withTempDir('niu-copy', async base => {
  try {
    const { source, root, clone } = await cloneTree(base, { hardlink: false })
    assert.equal(clone.mode, 'copy')
    assert.equal(clone.fallback, undefined)
    assert.equal(clone.dataBytes, Object.values(clone.sizes).reduce((total, size) => total + size, 0))
    for (const name of Object.keys(CONTENT)) {
      assert.equal(fs.statSync(path.join(root, name)).nlink, 1, name + ' is a private copy')
      assert.equal(fs.statSync(path.join(source, name)).nlink, 1, name + ' stays unshared in the payload')
    }
    await verifyTreeStat({ root, sizes: clone.sizes, links: clone.links,
      directories: [...DIRECTORIES, ...STATE_DIRECTORIES], sealed: false })
    assert.equal(niubashExecutionReceipt({ mode: clone.mode, seal: 'readonly' }).mode, 'copy')
  } finally { await tidy(base) }
}))

await test('an execution root that resolves inside the payload is refused', async () => withTempDir('niu-root', async base => {
  try {
    const source = buildPinnedPayload(base)
    const link = path.join(base, 'root-link')
    fs.symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir')
    const previous = process.env.DSH_OPS_EXEC_ROOT
    try {
      // Both the link itself and a not-yet-existing child below it resolve inside
      // the payload; the raw path.relative comparison would accept both.
      for (const configured of [link, path.join(link, 'nested')]) {
        process.env.DSH_OPS_EXEC_ROOT = configured
        await assert.rejects(prepareNiubash(path.join(source, 'niu.exe'), '', new AbortController().signal),
          /DSH_OPS_EXEC_ROOT must not be inside the Niubash payload/u)
      }
    } finally {
      if (previous === undefined) delete process.env.DSH_OPS_EXEC_ROOT
      else process.env.DSH_OPS_EXEC_ROOT = previous
    }
  } finally { await tidy(base) }
}))

await test('shared identities survive sibling churn without copying, and reject same-size replacement', async () => withTempDir('niu-identity', async base => {
  try {
    const source = buildSource(base)
    const firstRoot = path.join(base, 'first')
    const first = await cloneInto(source, firstRoot)
    const verify = () => verifyTreeStat({ root: firstRoot, sizes: first.sizes, identities: first.identities,
      directories: [...DIRECTORIES, ...STATE_DIRECTORIES], sealed: false })
    await verify()
    // Force a count change AFTER the first expectation was captured.
    for (let i = 0; i < 8; i++) {
      const sibling = path.join(base, `sibling-${i}`)
      const clone = await cloneInto(source, sibling)
      assert.equal(clone.mode, 'hardlink'); assert.equal(clone.dataBytes, 0)
      assert.notEqual(fs.statSync(path.join(firstRoot, 'LICENSE.txt')).nlink, first.links['LICENSE.txt'])
      await verify()
      await removeSealedTree(sibling, NO_ACL)
      await verify()
    }
    assert.equal(fs.statSync(path.join(source, 'LICENSE.txt')).nlink, 2, 'only source and live tree remain')
    // Keep the old inode alive through source; replacing a name with identical
    // bytes/size must fail identity verification, not pass as an equivalent file.
    const target = path.join(firstRoot, 'LICENSE.txt')
    fs.unlinkSync(target); fs.copyFileSync(path.join(source, 'LICENSE.txt'), target)
    await assert.rejects(verify(), /identity mismatch/)
  } finally { await tidy(base) }
}))

await test('unregistered failed clones cannot release a sealed sibling or leak after final disposal', async () => withTempDir('niu-failed-clone', async base => {
  try {
    const source = buildSource(base), live = path.join(base, 'live'), failed = path.join(base, 'failed')
    const clone = await cloneInto(source, live)
    await sealShared(source, { root: live, files: filesOf(live, clone), ...NO_ACL })
    await cloneInto(source, failed)
    await releaseShared(source, failed, NO_ACL)
    assert.ok(fs.existsSync(live)); assert.ok(fs.existsSync(failed))
    assert.equal(isSealedMode(fs.statSync(path.join(live, 'LICENSE.txt')).mode), true)
    await releaseShared(source, live, NO_ACL)
    assert.equal(fs.existsSync(live), false); assert.equal(fs.existsSync(failed), false)
    assert.equal(fs.statSync(path.join(source, 'LICENSE.txt')).nlink, 1)
  } finally { await tidy(base) }
}))

await test('a preparing tree retains the shared seal until its own cleanup', async () => withTempDir('niu-retain', async base => {
  try {
    const source = buildSource(base), live = path.join(base, 'live'), preparing = path.join(base, 'preparing')
    const clone = await cloneInto(source, live)
    await sealShared(source, { root: live, files: filesOf(live, clone), ...NO_ACL })
    await retainShared(source, preparing)
    await releaseShared(source, live, NO_ACL)
    assert.ok(fs.existsSync(live))
    assert.equal(isSealedMode(fs.statSync(path.join(source, 'LICENSE.txt')).mode), true)
    await cloneInto(source, preparing)
    await releaseShared(source, preparing, NO_ACL)
    assert.equal(fs.existsSync(live), false); assert.equal(fs.existsSync(preparing), false)
    assert.equal(fs.statSync(path.join(source, 'LICENSE.txt')).nlink, 1)
  } finally { await tidy(base) }
}))
report('niubash-execution-root')