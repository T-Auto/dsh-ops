/**
 * Full native file surface: the shipped worker, driven through the
 * `test/lib/boundary.mjs` request shape, plus the generated tool contract. The host
 * lane (`lib/file/worker.js`: authority modes, credential fence, observations)
 * belongs to the security/atomicity issue and is deliberately not exercised here.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { FILE_TOOLS, FILE_MUTATIONS, publicToolName } from '../lib/policy.js'
import { PARAMETERS, definition, normalizeArguments } from '../lib/file/contract.js'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { callTool, callWorker, request, envelopeOf, requireWorker } from './lib/boundary.mjs'
requireWorker('file-operations')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const call = async (tool, args, root, options = {}) => envelopeOf(await callTool(tool, args, { root, ...options }), assert)
const failed = (value, code) => { assert.equal(value.status, 'error', JSON.stringify(value)); assert.equal(value.error.code, code, JSON.stringify(value)); assert.equal(value.error.effectState, 'none') }
const mutation = (value, target, content) => {
  assert.equal(value.status, 'completed', JSON.stringify(value)); assert.equal(fs.readFileSync(target, 'utf8'), content); return true
}
const rev = target => hash(fs.readFileSync(target))

await test('every new contract is strict, named consistently, and never marks writes concurrency-safe', () => {
  for (const raw of FILE_TOOLS) {
    const tool = definition(raw, () => {})
    assert.equal(tool.name, publicToolName(raw)); assert.equal(tool.parameters.additionalProperties, false)
    assert.equal(typeof tool.isConcurrencySafe === 'function', !FILE_MUTATIONS.includes(raw))
  }
  for (const raw of ['edit_file', 'copy', 'move', 'remove']) assert.ok(PARAMETERS[raw].required.includes('expectedRevision'))
  // write_file keeps the field in its schema but not in its required list: an omitted revision is
  // create-only, so strict adapters may leave it out (#419).
  assert.deepEqual(PARAMETERS.write_file.required, ['path', 'content']); assert.ok(PARAMETERS.write_file.properties.expectedRevision)
  assert.deepEqual(normalizeArguments('write_file', { path: 'a', content: '', expectedRevision: 'absent', dryRun: false }), { path: 'a', content: '', expectedRevision: 'absent', dryRun: false })
})
await test('inspect/stat share exact hashes and total line counts even for a partial read, empty or binary file', async () => {
  await withTempDir('file-stat', async root => {
    for (const [name, bytes, lineCount] of [['crlf', Buffer.from('\ufeffα\r\nβ\r\n'), 2], ['empty', Buffer.alloc(0), 0], ['binary', Buffer.from([0xff, 0]), null]]) {
      const target = path.join(root, name); fs.writeFileSync(target, bytes)
      const stat = await call('stat', { path: target }, root)
      assert.equal(stat.revision, hash(bytes)); assert.equal(stat.bytes, bytes.length); assert.equal(stat.lineCount, lineCount)
      assert.equal(stat.exists, true); assert.equal(typeof stat.modifiedMs, 'number'); assert.equal(stat.items, undefined)
      const read = await call('inspect_local_file', { path: target, limit: 1, view: name === 'binary' ? 'hex' : 'text' }, root)
      assert.equal(read.revision, stat.revision); assert.equal(read.lineCount, stat.lineCount); assert.equal(read.bytes, bytes.length)
    }
    const large = path.join(root, 'large'); fs.writeFileSync(large, Buffer.alloc(200_000, 1))
    const hex = await callTool('inspect_local_file', { path: large, view: 'hex', limit: 10000 }, { root })
    assert.ok(Buffer.byteLength(hex.stdout) < 128 * 1024); assert.equal(hex.body.complete, false); assert.equal(hex.body.nextOffset, 1901)
    const absent = await call('stat', { path: path.join(root, 'absent') }, root)
    assert.equal(absent.exists, false); assert.equal(absent.revision, 'absent')
  })
})
await test('full writes create empty/Unicode files, refuse stale/absent overwrites and produce short stable receipts', async () => {
  await withTempDir('file-write', async root => {
    const target = path.join(root, 'new.txt')
    const created = await call('write_file', { path: target, expectedRevision: 'absent', content: 'α\r\nβ\n' }, root)
    assert.equal(created.status, 'completed', JSON.stringify(created)); assert.equal(created.changed, 1)
    assert.equal(created.revision, rev(target)); assert.equal(created.lineCount, 2); assert.ok(JSON.stringify(created).length < 2000)
    failed(await call('write_file', { path: target, expectedRevision: 'absent', content: 'bad' }, root), 'REVISION_CONFLICT')
    failed(await call('write_file', { path: target, expectedRevision: '0'.repeat(64), content: 'bad' }, root), 'REVISION_CONFLICT')
    const dry = await call('write_file', { path: target, expectedRevision: created.revision, content: '', dryRun: true }, root)
    assert.equal(dry.changed, 0); assert.equal(dry.revision, hash('')); assert.equal(fs.readFileSync(target, 'utf8'), 'α\r\nβ\n')
    const written = await call('write_file', { path: target, expectedRevision: created.revision, content: '' }, root)
    mutation(written, target, '')
    const empty = await call('write_file', { path: path.join(root, 'empty'), expectedRevision: 'absent', content: '' }, root)
    assert.equal(empty.lineCount, 0); assert.equal(empty.bytes, 0)
    const noop = await call('write_file', { path: target, expectedRevision: rev(target), content: fs.readFileSync(target, 'utf8') }, root)
    assert.equal(noop.changed, 0)
  })
})
await test('an omitted expectedRevision is create-only while an explicit blank or null stays a refusal', async () => {
  await withTempDir('file-write-create-only', async root => {
    const target = path.join(root, 'omitted.txt')
    const created = await call('write_file', { path: target, content: 'first\n' }, root)
    mutation(created, target, 'first\n'); assert.equal(created.items[0].metadata.created, true)
    failed(await call('write_file', { path: target, content: 'second\n' }, root), 'REVISION_CONFLICT')
    assert.equal(fs.readFileSync(target, 'utf8'), 'first\n'); assert.equal(rev(target), created.revision)
    // Only the omitted field is relaxed. Blank and null keep their pre-#419 refusals at the
    // kernel boundary: #422 leaves "blank means create-only" open, so this worker does not take
    // that decision. The host bridge drops blanks for optional string fields instead
    // (src/file/contract.ts:22-25); test/file-args.test.mjs pins that lane separately.
    for (const [name, value] of [['blank', '   '], ['empty', '']]) {
      const explicit = path.join(root, name + '.txt')
      failed(await call('write_file', { path: explicit, expectedRevision: value, content: 'x\n' }, root), 'INVALID_ARGUMENT')
      assert.equal(fs.existsSync(explicit), false, name + ' must not be created')
    }
    const nulled = path.join(root, 'null.txt')
    const refused = await call('write_file', { path: nulled, expectedRevision: null, content: 'null\n' }, root)
    assert.equal(refused.status, 'error', JSON.stringify(refused)); assert.equal(refused.error.effectState, 'none')
    assert.equal(fs.existsSync(nulled), false, 'null must not be created')
    const preview = await call('write_file', { path: path.join(root, 'preview.txt'), content: 'dry\n', dryRun: true }, root)
    assert.equal(preview.changed, 0); assert.equal(fs.existsSync(path.join(root, 'preview.txt')), false)
  })
})
await test('precise edits use one original, preserve Unicode/CRLF/BOM and reject all ambiguous/overlapping hunks', async () => {
  await withTempDir('file-edit', async root => {
    const target = path.join(root, 'patch.txt'); const original = '\ufeffalpha\r\nβeta\r\nend\r\n'
    fs.writeFileSync(target, original)
    const expectedRevision = rev(target)
    for (const edits of [[{ oldText: '', newText: 'x' }], [{ oldText: 'absent', newText: 'x' }], [{ oldText: 'alpha', newText: 'x' }, { oldText: 'pha', newText: 'y' }]]) {
      const value = await call('edit_file', { path: target, expectedRevision, edits }, root)
      assert.equal(value.status, 'error'); assert.equal(value.error.effectState, 'none'); assert.equal(fs.readFileSync(target, 'utf8'), original)
    }
    const edits = [{ oldText: 'alpha', newText: 'βeta' }, { oldText: 'βeta', newText: 'DONE' }]
    const preview = await call('edit_file', { path: target, expectedRevision, edits, dryRun: true }, root)
    assert.equal(preview.revision, hash('\ufeffβeta\r\nDONE\r\nend\r\n')); assert.equal(preview.changed, 0)
    mutation(await call('edit_file', { path: target, expectedRevision, edits }, root), target, '\ufeffβeta\r\nDONE\r\nend\r\n')
    fs.writeFileSync(target, 'aaa')
    failed(await call('edit_file', { path: target, expectedRevision: rev(target), edits: [{ oldText: 'aa', newText: 'b' }] }, root), 'EDIT_CONFLICT')
    fs.writeFileSync(target, Buffer.from([255]))
    failed(await call('edit_file', { path: target, expectedRevision: rev(target), edits: [{ oldText: 'a', newText: '' }] }, root), 'ERR_INVALID_ENCODING')
  })
})
await test('diff is a bounded read-only replacement hunk with exact before/after facts and continuation', async () => {
  await withTempDir('file-diff', async root => {
    const target = path.join(root, 'diff.txt'); fs.writeFileSync(target, 'same\na\nb\ntail\n')
    const content = 'same\nA\nB\ntail\n'
    const first = await call('diff', { path: target, content, limit: 1 }, root, { readOnly: true })
    assert.deepEqual(first.hunk, { startLine: 2, removed: 2, added: 2 }); assert.equal(first.complete, false); assert.equal(first.nextOffset, 1)
    assert.equal(first.before.revision, rev(target)); assert.equal(first.after.revision, hash(content)); assert.equal(first.changed, 0)
    const next = await call('diff', { path: target, content, offset: first.nextOffset }, root)
    assert.equal(next.items.length, 3); assert.equal(next.complete, true)
    const none = await call('diff', { path: target, content: fs.readFileSync(target, 'utf8') }, root)
    assert.deepEqual(none.items, []); assert.equal(none.complete, true)
    const large = await callTool('diff', { path: target, content: '\0'.repeat(300_000) }, { root })
    assert.ok(Buffer.byteLength(large.stdout) < 128 * 1024); assert.equal(large.body.truncated, true); assert.equal(large.body.after.bytes, 300_000)
    assert.equal(fs.readFileSync(target, 'utf8'), 'same\na\nb\ntail\n')
  })
})
await test('copy/move/remove require source CAS, absent destination and regular files', async () => {
  await withTempDir('file-transfer', async root => {
    const source = path.join(root, 'source'); const to = path.join(root, 'dest'); fs.writeFileSync(source, Buffer.from([255, 0, 1]))
    const expectedRevision = rev(source)
    for (const tool of ['copy', 'move', 'remove']) failed(await call(tool, { path: source, expectedRevision: '0'.repeat(64), ...(tool === 'remove' ? {} : { to }) }, root), 'REVISION_CONFLICT')
    fs.writeFileSync(to, 'keep')
    for (const tool of ['copy', 'move']) failed(await call(tool, { path: source, to, expectedRevision }, root), 'REVISION_CONFLICT')
    assert.equal(fs.readFileSync(to, 'utf8'), 'keep'); fs.unlinkSync(to)
    const copied = await call('copy', { path: source, to, expectedRevision }, root)
    assert.equal(copied.status, 'completed', JSON.stringify(copied)); assert.equal(rev(to), expectedRevision); fs.unlinkSync(to)
    const moved = await call('move', { path: source, to, expectedRevision }, root)
    assert.equal(moved.status, 'completed', JSON.stringify(moved)); assert.equal(fs.existsSync(source), false); assert.equal(rev(to), expectedRevision)
    const removed = await call('remove', { path: to, expectedRevision }, root)
    assert.equal(removed.changed, 1); assert.equal(fs.existsSync(to), false)
    for (const tool of ['stat', 'diff', 'write_file', 'copy', 'move', 'remove']) {
      const value = await call(tool, { path: root, ...(tool === 'diff' ? { content: '' } : {}), ...(['write_file', 'copy', 'move', 'remove'].includes(tool) ? { expectedRevision, ...(tool === 'write_file' ? { content: '' } : tool === 'remove' ? {} : { to }) } : {}) }, root)
      assert.equal(value.status, 'error', tool); assert.ok(['IS_DIRECTORY', 'REVISION_CONFLICT'].includes(value.error.code), JSON.stringify(value))
    }
  })
})
await test('create-only concurrent writers publish exactly one entire file without lost updates', async () => {
  await withTempDir('file-cas-race', async root => {
    const target = path.join(root, 'raced')
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => call('write_file', { path: target, content: `writer ${i}\n`, expectedRevision: 'absent' }, root)))
    const winners = results.filter(v => v.status === 'completed')
    assert.equal(winners.length, 1, JSON.stringify(results)); assert.equal(winners[0].revision, rev(target))
    for (const loser of results.filter(v => v.status !== 'completed')) failed(loser, 'REVISION_CONFLICT')
  })
})
await test('concurrent full overwrites share a revision and only one publication survives', async () => {
  await withTempDir('file-overwrite-race', async root => {
    const target = path.join(root, 'raced'); fs.writeFileSync(target, 'original')
    const expectedRevision = rev(target)
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => call('write_file', { path: target, content: `writer ${i}`, expectedRevision }, root)))
    const winners = results.filter(v => v.status === 'completed')
    assert.equal(winners.length, 1, JSON.stringify(results)); assert.equal(winners[0].revision, rev(target))
    for (const loser of results.filter(v => v.status !== 'completed')) failed(loser, 'REVISION_CONFLICT')
  })
})
await test('no-follow ancestry rejects symlinks/junctions even for a missing write destination', async () => {
  await withTempDir('file-no-follow', async root => {
    const real = path.join(root, 'real'); fs.mkdirSync(real); fs.writeFileSync(path.join(real, 'a'), 'keep')
    const link = path.join(root, 'link'); fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir')
    for (const tool of ['stat', 'write_file', 'edit_file', 'copy', 'move', 'remove']) {
      const value = await call(tool, { path: path.join(link, tool === 'write_file' ? 'new' : 'a'), ...(tool === 'stat' ? {} : { expectedRevision: tool === 'write_file' ? 'absent' : hash('keep') }), ...(tool === 'write_file' ? { content: 'bad' } : tool === 'edit_file' ? { edits: [{ oldText: 'keep', newText: 'bad' }] } : ['copy', 'move'].includes(tool) ? { to: path.join(root, 'dest') } : {}) }, root)
      failed(value, 'PATH_RESTRICTED')
      assert.equal(value.error.reason, undefined)
    }
    assert.equal(fs.existsSync(path.join(real, 'new')), false); assert.equal(fs.readFileSync(path.join(real, 'a'), 'utf8'), 'keep')
  })
})
await test('native selector reasons never conflate credential or path restrictions with mode denial', async () => {
  await withTempDir('file-denial-reasons', async root => {
    const target = path.join(root, 'existing'); fs.writeFileSync(target, 'keep')
    const args = { path: target, content: 'bad', expectedRevision: rev(target) }
    for (const [options, reason] of [[{ readOnly: true }, 'read-only'], [{ writeRoots: [] }, 'write-roots']]) {
      const value = await call('write_file', args, root, options)
      failed(value, 'POLICY_DENIED'); assert.equal(value.error.reason, reason)
    }
    const denied = envelopeOf(await callWorker(JSON.stringify({ ...request('stat', { path: target }, { root }), deny_roots: [target] })), assert)
    // This security layer distinguishes the credential fence from selector denial.
    failed(denied, 'CREDENTIAL_DENIED'); assert.equal(denied.error.reason, undefined)
    const linked = path.join(root, 'link'); fs.symlinkSync(root, linked, process.platform === 'win32' ? 'junction' : 'dir')
    const restricted = await call('stat', { path: path.join(linked, 'existing') }, root)
    failed(restricted, 'PATH_RESTRICTED'); assert.equal(restricted.error.reason, undefined)
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep')
  })
})
await test('Windows protected DACLs survive successful overwrite/edit/replace/copy and move', async () => {
  if (process.platform !== 'win32') return
  await withTempDir('file-dacl', async root => {
    const source = path.join(root, 'secure'); fs.writeFileSync(source, 'keep')
    const ps = code => {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { encoding: 'utf8', env: { ...process.env, PSModulePath: '' } })
      assert.equal(result.status, 0, result.stderr); return result.stdout.trim()
    }
    const quoted = source.replaceAll("'", "''")
    ps(`$p='${quoted}'; $a=Get-Acl -LiteralPath $p; $a.SetAccessRuleProtection($true,$true); Set-Acl -LiteralPath $p -AclObject $a`)
    const acl = target => ps(`(Get-Acl -LiteralPath '${target.replaceAll("'", "''")}').Sddl`)
    const before = acl(source)
    for (const [tool, args] of [['write_file', { content: 'NEXT' }], ['edit_file', { edits: [{ oldText: 'NEXT', newText: 'FINAL' }] }], ['replace', { pattern: 'FINAL', replacement: 'keep' }], ['copy', { to: path.join(root, 'copy') }]]) {
      const value = await call(tool, { path: source, ...(tool === 'replace' ? {} : { expectedRevision: rev(source) }), ...args }, root)
      assert.equal(value.status, 'completed', JSON.stringify(value)); assert.equal(acl(source), before)
      if (tool === 'copy') assert.equal(acl(args.to), before)
    }
    const expectedRevision = rev(source)
    const dry = await call('replace', { path: source, pattern: 'keep', replacement: 'bad', dryRun: true }, root)
    assert.equal(dry.dryRun, true); assert.equal(dry.changed, 0)
    const dest = path.join(root, 'moved'); const moved = await call('move', { path: source, to: dest, expectedRevision }, root)
    assert.equal(moved.status, 'completed', JSON.stringify(moved)); assert.equal(acl(dest), before)
    // Hold a non-delete-sharing Windows handle: hard-link publication succeeds,
    // but unlink must report an applied partial effect and retain the source.
    fs.renameSync(dest, source)
    const code = `$h=[IO.File]::Open('${quoted}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite); [Console]::Out.WriteLine('READY'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null; $h.Dispose()`
    const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'pipe'] })
    try {
      await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject); holder.once('exit', code => reject(new Error(`holder exited ${code}`))) })
      const blocked = await call('write_file', { path: source, content: 'blocked', expectedRevision }, root)
      failed(blocked, 'ACCESS_DENIED'); assert.equal(fs.readFileSync(source, 'utf8'), 'keep'); assert.equal(acl(source), before)
      const partial = await call('move', { path: source, to: dest, expectedRevision }, root)
      assert.equal(partial.error.code, 'RESULT_PARTIAL', JSON.stringify(partial)); assert.equal(partial.error.effectState, 'applied'); assert.equal(fs.existsSync(source), true); assert.equal(fs.existsSync(dest), true)
    } finally { holder.stdin.end('release' + String.fromCharCode(10)); await new Promise(resolve => holder.once('close', resolve)) }
  })
})
await test('Windows inherited and explicit deny ACLs survive writes and copies into a different parent', async () => {
  if (process.platform !== 'win32') return
  const ps = code => {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';" + code, 'utf16le').toString('base64')], { encoding: 'utf8', env: { ...process.env, PSModulePath: '' } })
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim()
  }
  const quote = value => value.replaceAll("'", "''")
  const acl = target => ps(`(Get-Acl -LiteralPath '${quote(target)}').Sddl`)
  await withTempDir('file-windows-acls', async root => {
    const destination = path.join(root, 'destination'); fs.mkdirSync(destination)
    ps(`$p='${quote(destination)}'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a=[Security.AccessControl.DirectorySecurity]::new(); $a.SetAccessRuleProtection($true,$false); $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')); Set-Acl -LiteralPath $p -AclObject $a`)
    for (const kind of ['inherited', 'protected', 'deny']) {
      const source = path.join(root, kind); fs.writeFileSync(source, 'START')
      if (kind !== 'inherited') ps(`$p='${quote(source)}'; $a=Get-Acl -LiteralPath $p; $a.SetAccessRuleProtection($true,$true); ${kind === 'deny' ? "$sid=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-546'); $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'WriteData','Deny'));" : ''} Set-Acl -LiteralPath $p -AclObject $a`)
      const before = acl(source)
      if (kind === 'deny') assert.match(before, /\(D;;/u, 'fixture must really contain an explicit deny ACE')
      if (kind === 'inherited') assert.match(before, /;ID;/u)
      else assert.match(before, /D:P/u)
      for (const [tool, args, content] of [
        ['write_file', { content: 'NEXT' }, 'NEXT'],
        ['edit_file', { edits: [{ oldText: 'NEXT', newText: 'FINAL' }] }, 'FINAL'],
        ['replace', { pattern: 'FINAL', replacement: 'DONE' }, 'DONE'],
      ]) {
        const value = await call(tool, { path: source, ...(tool === 'replace' ? {} : { expectedRevision: rev(source) }), ...args }, root)
        assert.equal(value.status, 'completed', JSON.stringify(value)); assert.equal(fs.readFileSync(source, 'utf8'), content); assert.equal(acl(source), before)
      }
      const to = path.join(destination, kind)
      assert.equal((await call('copy', { path: source, to, expectedRevision: rev(source) }, root)).status, 'completed')
      assert.equal(acl(to), before); assert.equal(fs.readFileSync(to, 'utf8'), 'DONE')
      failed(await call('copy', { path: source, to, expectedRevision: rev(source) }, root), 'REVISION_CONFLICT')
      fs.chmodSync(source, 0o444)
      try {
        failed(await call('write_file', { path: source, content: 'bad', expectedRevision: rev(source) }, root), 'ACCESS_DENIED')
        const readonlyCopy = await call('copy', { path: source, to: path.join(destination, kind + '-readonly'), expectedRevision: rev(source) }, root)
        assert.equal(readonlyCopy.status, 'completed', JSON.stringify(readonlyCopy)); assert.equal(acl(source), before)
      } finally { fs.chmodSync(source, 0o666) }
      assert.equal(fs.readdirSync(destination).some(name => /[.]dsh-ops-[0-9a-f-]{36}$/u.test(name)), false, 'no readonly staging link may leak')
    }
    const streamed = path.join(root, 'streamed'); fs.writeFileSync(streamed, 'keep'); fs.writeFileSync(streamed + ':private', 'secret')
    for (const tool of ['write_file', 'copy']) {
      failed(await call(tool, { path: streamed, expectedRevision: rev(streamed), ...(tool === 'copy' ? { to: path.join(destination, 'streamed') } : { content: 'bad' }) }, root), 'METADATA_UNSUPPORTED')
      assert.equal(fs.readFileSync(streamed, 'utf8'), 'keep'); assert.equal(fs.readFileSync(streamed + ':private', 'utf8'), 'secret')
    }
  })
})
await test('Windows failed overwrite unlinks restrictive staging through its owned DELETE handle', async () => {
  if (process.platform !== 'win32') return
  const ps = code => {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';" + code, 'utf16le').toString('base64')], { encoding: 'utf8', env: { ...process.env, PSModulePath: '' } })
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim()
  }
  const quote = value => value.replaceAll("'", "''")
  await withTempDir('file-staging-delete', async root => {
    const source = path.join(root, 'source'), probe = path.join(root, 'probe')
    fs.writeFileSync(source, 'ORIGINAL'); fs.writeFileSync(probe, 'probe')
    const originalAcl = ps(`(Get-Acl -LiteralPath '${quote(root)}').Sddl`)
    try {
      ps(`$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; foreach($p in @('${quote(source)}','${quote(probe)}')) { $a=Get-Acl -LiteralPath $p; $a.SetAccessRuleProtection($true,$true); $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'Delete','Deny')); Set-Acl -LiteralPath $p -AclObject $a }; $p='${quote(root)}'; $a=Get-Acl -LiteralPath $p; $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'DeleteSubdirectoriesAndFiles','Deny')); Set-Acl -LiteralPath $p -AclObject $a`)
      // This is not merely an ACE-text fixture: ordinary pathname deletion must fail
      // under the exact source/parent policy restored onto the staging inode. A hosted
      // runner running as the built-in Administrator (RID 500, SDDL alias `LA`) is not
      // stopped by an explicit deny ACE, and the publish this case needs would succeed
      // there too -- replacing an existing target requires DELETE on it, exactly what
      // the probe measures -- so restrictive staging cannot be reached on that host.
      const probeAcl = ps(`(Get-Acl -LiteralPath '${quote(probe)}').Sddl`)
      let probeError
      try { fs.unlinkSync(probe) } catch (error) { probeError = error }
      if (probeError === undefined) {
        console.log(`  staging DELETE fixture unavailable: this host deleted a probe whose own and parent DACL deny DELETE (${probeAcl}), so restrictive staging cannot be reached here`)
        return
      }
      assert.ok(['EPERM', 'EACCES'].includes(probeError.code), String(probeError))
      assert.equal(fs.readFileSync(probe, 'utf8'), 'probe')
      const before = ps(`(Get-Acl -LiteralPath '${quote(source)}').Sddl`)
      const result = await call('write_file', { path: source, expectedRevision: rev(source), content: 'SENSITIVE REPLACEMENT' }, root)
      failed(result, 'ACCESS_DENIED')
      assert.match(result.error.message, /Atomic replacement publish/u, 'fixture must reach rename after bytes and restrictive metadata were prepared')
      assert.equal(fs.readFileSync(source, 'utf8'), 'ORIGINAL')
      assert.equal(ps(`(Get-Acl -LiteralPath '${quote(source)}').Sddl`), before)
      assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('.source.dsh-ops-')), [], 'no unpublished bytes may remain')
    } finally {
      ps(`$p='${quote(root)}'; $a=Get-Acl -LiteralPath $p; $a.SetSecurityDescriptorSddlForm('${quote(originalAcl)}'); Set-Acl -LiteralPath $p -AclObject $a`)
    }
  })
})
await test('cross-device move rejects without copy/delete fallback when a second writable device is available', async () => {
  await withTempDir('file-device', async root => {
    const source = path.join(root, 'source'); fs.writeFileSync(source, 'keep')
    const candidates = process.platform === 'win32' ? [process.cwd()] : ['/dev/shm', process.cwd()]
    const other = candidates.find(dir => { try { fs.accessSync(dir, fs.constants.W_OK); return fs.statSync(dir).dev !== fs.statSync(root).dev } catch { return false } })
    if (!other) { console.log('  cross-device fixture unavailable: no second writable filesystem'); return }
    const destinationRoot = fs.mkdtempSync(path.join(other, '.tmp-file-device-'))
    try {
      const to = path.join(destinationRoot, 'dest'); failed(await call('move', { path: source, to, expectedRevision: rev(source) }, root), 'CROSS_DEVICE')
      assert.equal(fs.readFileSync(source, 'utf8'), 'keep'); assert.equal(fs.existsSync(to), false)
    } finally { fs.rmSync(destinationRoot, { recursive: true, force: true }) }
  })
})
report('file-operations')
