/**
 * A replacement keeps the file's metadata (report L1 / L9).
 *
 * `ops_replace` publishes by writing a new inode and renaming it over the target.
 * A new inode is created with the caller's umask and its own security state, so
 * everything the old inode carried had to be reapplied deliberately — and nothing
 * was. A `0600` `.env` came back `0664`, a `0755` script lost its execute bit, and
 * a POSIX ACL or a user xattr disappeared without a word. The replacement was more
 * permissive than what it replaced, silently, in the one direction a file tool
 * must never drift.
 *
 * What this suite locks in:
 *
 * - The mode survives, across the modes that actually matter: `0600` and `0400`
 *   (secrets), `0755` and `0750` (executables), `0640` and `0644` (config).
 * - A POSIX ACL comes back byte for byte, and the envelope says it was reapplied.
 * - User extended attributes come back with their values.
 * - The envelope reports what was kept (`items[].metadata`) and warns only when
 *   something could not be put back, so a clean replace carries no warning field.
 * - A dry run carries no metadata, because it published nothing.
 *
 * The policy the fix implements, and why the failure modes differ: the mode and a
 * POSIX ACL must be reapplied or nothing is published, since both are ways of
 * widening access if guessed. Owner and other xattrs are best-effort and reported
 * in `metadataWarnings`.
 *
 * Platform. Windows runs its own exact owner/group/DACL + timestamps test;
 * POSIX runs the mode/ACL/xattr cases below. Adversarial Windows ACL and staging
 * cleanup cases live in file-operations.test.mjs.
 *
 * Not asserted here, and why:
 *
 * - The refusal path — a mode that cannot be reapplied must publish nothing — is
 *   not reachable on a filesystem that supports `chmod`, which is every filesystem
 *   this gate runs on. It is defensive code held by reading, not by a probe.
 * - `metadataWarnings` needs a restore that genuinely fails (an owner that cannot
 *   be set, an attribute the filesystem rejects). Provoking either requires an
 *   unprivileged or unsupported-filesystem context, so the field's *absence* on a
 *   clean replace is asserted and its presence is not.
 *
 * @module dsh-ops/test/file-metadata
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { callTool, envelopeOf, requireWorker } from './lib/boundary.mjs'

requireWorker('file-metadata')
if (process.platform === 'win32') {
  await test('Windows overwrite/edit/replace/copy retain exact owner/group/DACL and timestamps', async () => {
    await withTempDir('file-windows-metadata', async root => {
      const source = path.join(root, 'source')
      fs.writeFileSync(source, 'TOKEN')
      fs.utimesSync(source, new Date('2020-01-02T00:00:00Z'), new Date('2020-01-03T00:00:00Z'))
      const acl = target => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Acl -LiteralPath '${target.replaceAll("'", "''")}').Sddl`], { encoding: 'utf8', env: { ...process.env, PSModulePath: '' } }).trim()
      const before = acl(source), timestamp = fs.statSync(source).mtimeMs
      const call = async (tool, args) => envelopeOf(await callTool(tool, { path: source, ...args }, { root }), assert)
      let revision = (await call('stat', {})).revision
      for (const [tool, args] of [
        ['write_file', { content: 'NEXT' }],
        ['edit_file', { edits: [{ oldText: 'NEXT', newText: 'FINAL' }] }],
        ['replace', { pattern: 'FINAL', replacement: 'DONE' }],
      ]) {
        const value = await call(tool, { ...(tool === 'replace' ? {} : { expectedRevision: revision }), ...args })
        assert.equal(value.status, 'completed', JSON.stringify(value))
        revision = (await call('stat', {})).revision
        assert.equal(acl(source), before)
        assert.equal(fs.statSync(source).mtimeMs, timestamp)
      }
      const to = path.join(root, 'copied')
      const copied = await call('copy', { to, expectedRevision: revision })
      assert.equal(copied.status, 'completed', JSON.stringify(copied))
      assert.equal(acl(to), before)
      assert.equal(fs.statSync(to).mtimeMs, timestamp)
      assert.equal(fs.readFileSync(to, 'utf8'), 'DONE')
    })
  })
  report('file-metadata')
  process.exit(process.exitCode ?? 0)
}

const installed = command => {
  try { execFileSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }); return true } catch { return false }
}
const SETFACL = installed('setfacl') && installed('getfacl')
const PYTHON = installed('python3')
/** Whether this host can attach and read back a user attribute for the fixtures below. */
const ATTRIBUTES = process.platform === 'darwin' || PYTHON
const setUserAttribute = target => process.platform === 'darwin'
  ? execFileSync('/usr/bin/xattr', ['-w', 'user.dsh-ops', 'kept', target])
  : PYTHON && execFileSync('python3', ['-c', "import os,sys; os.setxattr(sys.argv[1],'user.dsh-ops',b'kept')", target])
const userAttribute = target => process.platform === 'darwin'
  ? execFileSync('/usr/bin/xattr', ['-p', 'user.dsh-ops', target], { encoding: 'utf8' }).trim()
  : execFileSync('python3', ['-c', "import os,sys; print(os.getxattr(sys.argv[1],'user.dsh-ops').decode())", target], { encoding: 'utf8' }).trim()

/** The low twelve bits, octal, so a comparison never depends on setuid or the file type. */
const modeOf = target => (fs.statSync(target).mode & 0o7777).toString(8).padStart(4, '0')
const octal = mode => mode.toString(8).padStart(4, '0')

/** A file whose only content is the marker the replacement looks for. */
const seed = (target, mode) => {
  fs.writeFileSync(target, 'TOKEN\n')
  fs.chmodSync(target, mode)
  return target
}

/** The same fixture with a user attribute attached while the mode still allows it. */
const seedWithAttribute = (target, mode) => {
  fs.writeFileSync(target, 'TOKEN\n')
  setUserAttribute(target)
  fs.chmodSync(target, mode)
  return target
}

const replaceToken = async (target, workspace) =>
  envelopeOf(await callTool('replace', { path: target, pattern: 'TOKEN', replacement: 'DONE' }, { root: workspace }), assert)

await test('every mode a caller can set survives a replacement', async () => {
  await withTempDir('file-metadata-mode', async workspace => {
    for (const mode of [0o600, 0o400, 0o640, 0o644, 0o755, 0o750]) {
      // A read-only mode denies `setxattr`, so the attribute has to be attached
      // while the fixture is still writable. That is what makes this case catch a
      // restore that applies the final mode before the attributes, on every host
      // rather than only where macOS supplies `com.apple.provenance` for free.
      const target = ATTRIBUTES
        ? seedWithAttribute(path.join(workspace, `mode-${octal(mode)}.txt`), mode)
        : seed(path.join(workspace, `mode-${octal(mode)}.txt`), mode)
      const body = await replaceToken(target, workspace)

      assert.equal(body.items[0].metadata.mode, octal(mode), `the envelope must report ${octal(mode)} as kept`)
      assert.equal(modeOf(target), octal(mode), `mode ${octal(mode)} must survive the replace`)
      assert.equal(fs.readFileSync(target, 'utf8'), 'DONE\n', 'the content still has to change')
      assert.equal(body.items[0].metadata.owner, true)
      assert.equal(body.items[0].metadata.acl, false)
      assert.equal(body.items[0].metadataWarnings, undefined, 'a clean restore must not carry a warning')
      if (ATTRIBUTES) {
        assert.ok(body.items[0].metadata.xattrs.includes('user.dsh-ops'), `mode ${octal(mode)} must still put the attribute back`)
        assert.equal(userAttribute(target), 'kept', `mode ${octal(mode)} must restore the attribute exactly`)
      }
    }
  })
})

await test('a POSIX ACL comes back entry for entry', async () => {
  await withTempDir('file-metadata-acl', async workspace => {
    const target = seed(path.join(workspace, 'acl.txt'), 0o640)
    if (!SETFACL) {
      // Not installed here; the mode and xattr cases still run. Stated rather than
      // skipped silently so a Linux host without acl tools is not mistaken for a pass.
      assert.ok(true, 'setfacl/getfacl are not installed, so the ACL case cannot be exercised on this host')
      return
    }
    execFileSync('setfacl', ['-m', 'u:65534:r--', target])
    const before = execFileSync('getfacl', ['-cpn', target], { encoding: 'utf8' })
    assert.match(before, /user:65534:r--/u, 'the fixture must actually carry the extra entry')

    const body = await replaceToken(target, workspace)
    assert.equal(body.items[0].metadata.acl, true, 'the envelope must report that an ACL was reapplied')
    assert.equal(execFileSync('getfacl', ['-cpn', target], { encoding: 'utf8' }), before, 'the ACL must be restored exactly')
    assert.equal(modeOf(target), '0640', 'the mask and the mode must stay consistent')
  })
})

await test('user extended attributes come back with their values', async () => {
  await withTempDir('file-metadata-xattr', async workspace => {
    if (process.platform === 'darwin') {
      const target = seed(path.join(workspace, 'attrs.txt'), 0o644)
      execFileSync('/usr/bin/xattr', ['-w', 'user.dsh-ops', 'kept', target])
      const body = await replaceToken(target, workspace)
      assert.equal(body.status, 'completed', JSON.stringify(body))
      assert.ok(body.items[0].metadata.xattrs.includes('user.dsh-ops'))
      assert.equal(execFileSync('/usr/bin/xattr', ['-p', 'user.dsh-ops', target], { encoding: 'utf8' }).trim(), 'kept')
      return
    }
    if (!PYTHON) {
      assert.ok(true, 'python3 is not installed, so the xattr case cannot be exercised on this host')
      return
    }
    const target = seed(path.join(workspace, 'attrs.txt'), 0o644)
    const set = "import os,sys; os.setxattr(sys.argv[1],'user.dsh-ops',b'kept'); os.setxattr(sys.argv[1],'user.other',b'second')"
    execFileSync('python3', ['-c', set, target])

    const body = await replaceToken(target, workspace)
    assert.deepEqual(
      [...body.items[0].metadata.xattrs].sort(),
      ['user.dsh-ops', 'user.other'],
      'the envelope must name every attribute it put back',
    )
    const get = "import os,sys; print(os.getxattr(sys.argv[1],'user.dsh-ops').decode(), os.getxattr(sys.argv[1],'user.other').decode())"
    assert.equal(execFileSync('python3', ['-c', get, target], { encoding: 'utf8' }).trim(), 'kept second')
    assert.equal(modeOf(target), '0644')
  })
})

await test('a dry run reports no metadata because it published nothing', async () => {
  await withTempDir('file-metadata-dryrun', async workspace => {
    const target = seed(path.join(workspace, 'dry.txt'), 0o600)
    const body = envelopeOf(await callTool('replace', { path: target, pattern: 'TOKEN', replacement: 'DONE', dryRun: true }, { root: workspace }), assert)
    assert.equal(body.changed, 0)
    assert.equal(body.items[0].metadata, undefined, 'nothing was written, so there is nothing to report')
    assert.equal(modeOf(target), '0600')
    assert.equal(fs.readFileSync(target, 'utf8'), 'TOKEN\n')
  })
})

await test('full overwrite, precise edit and copy retain private mode and user attributes', async () => {
  await withTempDir('file-metadata-new', async workspace => {
    const source = seed(path.join(workspace, 'private.txt'), 0o600)
    setUserAttribute(source)
    const stat = () => callTool('stat', { path: source }, { root: workspace }).then(value => envelopeOf(value, assert))
    const written = envelopeOf(await callTool('write_file', { path: source, content: 'NEXT', expectedRevision: (await stat()).revision }, { root: workspace }), assert)
    assert.equal(written.status, 'completed', JSON.stringify(written)); assert.equal(modeOf(source), '0600')
    const edited = envelopeOf(await callTool('edit_file', { path: source, expectedRevision: written.revision, edits: [{ oldText: 'NEXT', newText: 'FINAL' }] }, { root: workspace }), assert)
    assert.equal(edited.status, 'completed', JSON.stringify(edited)); assert.equal(modeOf(source), '0600')
    if (process.platform === 'darwin' || PYTHON) assert.equal(userAttribute(source), 'kept')
    const to = path.join(workspace, 'copy.txt')
    const copied = envelopeOf(await callTool('copy', { path: source, to, expectedRevision: edited.revision }, { root: workspace }), assert)
    assert.equal(copied.status, 'completed', JSON.stringify(copied)); assert.equal(modeOf(to), '0600')
    assert.equal(fs.statSync(to).mtimeMs, fs.statSync(source).mtimeMs)
    if (process.platform === 'darwin' || PYTHON) assert.equal(userAttribute(to), 'kept')
  })
})

await test('Darwin extended ACL copy and replace fail closed before creating siblings', async () => {
  if (process.platform !== 'darwin') return
  await withTempDir('file-metadata-darwin-acl', async workspace => {
    const source = seed(path.join(workspace, 'source'), 0o600)
    execFileSync('/bin/chmod', ['+a', 'everyone deny delete', source])
    const acl = target => execFileSync('/bin/ls', ['-lde', target], { encoding: 'utf8' }).split(String.fromCharCode(10)).slice(1).join(String.fromCharCode(10))
    const to = path.join(workspace, 'copy')
    try {
      const before = acl(source)
      assert.match(before, /everyone deny delete/u, 'fixture must carry a Darwin deny ACE')
      const revision = envelopeOf(await callTool('stat', { path: source }, { root: workspace }), assert).revision
      const copied = envelopeOf(await callTool('copy', { path: source, to, expectedRevision: revision }, { root: workspace }), assert)
        assert.equal(copied.error.code, 'METADATA_UNSUPPORTED', JSON.stringify(copied))
      assert.equal(copied.error.effectState, 'none')
      assert.match(copied.error.nextAction, /metadata|filesystem/)
      assert.equal(fs.existsSync(to), false)
      assert.equal(acl(source), before)
      assert.equal(fs.readdirSync(workspace).some(name => /[.]dsh-ops-[0-9a-f-]{36}$/.test(name)), false)
      const replaced = await replaceToken(source, workspace)
      assert.equal(replaced.error.code, 'METADATA_UNSUPPORTED')
      assert.equal(replaced.error.effectState, 'none')
      assert.equal(fs.readFileSync(source, 'utf8'), 'TOKEN' + String.fromCharCode(10))
    } finally {
      // Clear only fixture ACLs, including any unpublished clone left by a
      // failed assertion, so the deny-delete fixture cannot defeat cleanup.
      for (const name of fs.readdirSync(workspace)) execFileSync('/bin/chmod', ['-N', path.join(workspace, name)])
    }
  })
})

report('file-metadata')
