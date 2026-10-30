/** PR128 increments only: Windows replace refusals and deterministic sidecar contention.
 * Exact DACL/owner/timestamp preservation is covered by file-metadata/file-operations.
 * No racing writers, settling sleeps, swallowed child failures or operation retries.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { assert, report, skipSuite, test, withTempDir } from './lib/harness.mjs'
import { callTool, envelopeOf, requireWorker } from './lib/boundary.mjs'

if (process.platform !== 'win32') skipSuite('windows-security', 'Windows READONLY, FileShare and byte-range lock semantics')
requireWorker('windows-security')
const quote = text => text.replaceAll("'", "''")
const powershell = code => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';" + code, 'utf16le').toString('base64')], { encoding: 'utf8', env: { ...process.env, PSModulePath: '' } })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
const sddlOf = target => powershell(`(Get-Acl -LiteralPath '${quote(target)}').Sddl`)
const attributesOf = target => powershell(`(Get-Item -LiteralPath '${quote(target)}').Attributes.ToString()`)
const call = async (tool, args, root) => envelopeOf(await callTool(tool, args, { root }), assert)
const replace = (target, root) => call('replace', { path: target, pattern: 'TOKEN', replacement: 'DONE' }, root)
const refused = (body, code) => {
  assert.equal(body.status, 'error', JSON.stringify(body))
  assert.equal(body.error.code, code, JSON.stringify(body))
  assert.equal(body.error.effectState, 'none')
  assert.ok(['preflight', 'execute'].includes(body.error.phase), JSON.stringify(body))
  assert.equal(body.error.retryable, false)
  assert.ok(body.error.nextAction.length > 0)
}
const clean = (root, expected) => assert.deepEqual(fs.readdirSync(root).sort(), [...expected].sort(), 'no staging or sidecar debris')

/** A real child owns the handle until stdin releases it. READY is emitted only after
 * acquisition; close is awaited before fixture cleanup. Any stderr/exit failure fails.
 */
async function withHolder(script, body) {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(
    "$ErrorActionPreference='Stop';" + script + "; [Console]::Out.WriteLine('READY'); [Console]::Out.Flush(); try { [Console]::ReadLine() | Out-Null } finally { $h.Dispose() }", 'utf16le').toString('base64')],
  { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PSModulePath: '' } })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
  const closed = new Promise(resolve => child.once('close', resolve))
  let timer
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('holder acquisition deadline: ' + stderr)), 10000)
      child.once('error', reject)
      child.once('close', code => reject(new Error('holder exited before READY: ' + code + ' ' + stderr)))
      child.stdout.on('data', () => { if (stdout.includes('READY\r\n') || stdout.includes('READY\n')) resolve() })
    })
    clearTimeout(timer)
    await body()
  } finally {
    clearTimeout(timer)
    child.stdin.end('release\n')
    const deadline = setTimeout(() => child.kill(), 10000)
    const code = await closed
    clearTimeout(deadline)
    assert.equal(code, 0, 'holder must release normally: ' + stderr)
    assert.equal(stderr, '')
  }
}

await test('W1d: READONLY replace refuses without changing content or leaving artifacts', async () => {
  await withTempDir('w1d-readonly', async root => {
    const target = path.join(root, 'target.txt'); fs.writeFileSync(target, 'TOKEN\n')
    fs.chmodSync(target, 0o444)
    const beforeSddl = sddlOf(target), beforeAttributes = attributesOf(target)
    assert.match(beforeAttributes, /ReadOnly/u)
    try {
      refused(await replace(target, root), 'ACCESS_DENIED')
      assert.equal(sddlOf(target), beforeSddl)
      assert.equal(attributesOf(target), beforeAttributes)
      assert.equal(fs.readFileSync(target, 'utf8'), 'TOKEN\n')
      clean(root, ['target.txt'])
    } finally { fs.chmodSync(target, 0o666) }
  })
})

await test('W1e: FileShare.None replace refuses with structured failure and no artifacts', async () => {
  await withTempDir('w1e-sharing', async root => {
    const target = path.join(root, 'target.txt'); fs.writeFileSync(target, 'TOKEN\n')
    await withHolder(
      "$h=[IO.File]::Open('" + quote(target) + "',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)",
      async () => {
        refused(await replace(target, root), 'IO_ERROR')
        clean(root, ['target.txt'])
      })
    assert.equal(fs.readFileSync(target, 'utf8'), 'TOKEN\n')
    clean(root, ['target.txt'])
  })
})

await test('W1e: readable target without delete sharing refuses at publication and removes staging', async () => {
  await withTempDir('w1e-publish', async root => {
    const target = path.join(root, 'target.txt'); fs.writeFileSync(target, 'TOKEN\n')
    const before = sddlOf(target)
    await withHolder(
      "$h=[IO.File]::Open('" + quote(target) + "',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)",
      async () => {
        assert.equal(fs.readFileSync(target, 'utf8'), 'TOKEN\n')
        const blocked = await replace(target, root)
        refused(blocked, 'ACCESS_DENIED')
        assert.match(blocked.error.message, /Atomic replacement publish/u)
        assert.equal(fs.readFileSync(target, 'utf8'), 'TOKEN\n')
        assert.equal(sddlOf(target), before)
        clean(root, ['target.txt'])
      })
    assert.equal(fs.readFileSync(target, 'utf8'), 'TOKEN\n')
    assert.equal(sddlOf(target), before)
    clean(root, ['target.txt'])
  })
})

await test('W1g/h: held sidecar deterministically refuses writer but not target/directory readers', async () => {
  await withTempDir('w1gh-lock', async root => {
    const name = 'target.txt', target = path.join(root, name)
    fs.writeFileSync(target, 'TOKEN\n')
    const sidecar = '.dsh-ops-update-' + createHash('sha256').update(name).digest('hex') + '.lock'
    fs.writeFileSync(path.join(root, sidecar), '')
    await withHolder(
      "$h=[IO.File]::Open('" + quote(path.join(root, sidecar)) + "',[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete); $h.Lock(0,1)",
      async () => {
        refused(await replace(target, root), 'REVISION_CONFLICT')
        const read = await call('inspect_local_file', { path: target }, root)
        assert.equal(read.status, 'completed', JSON.stringify(read))
        assert.equal(read.items[0].text, 'TOKEN')
        assert.equal(fs.readFileSync(target, 'utf8'), 'TOKEN\n')
        clean(root, [name, sidecar])
      })
    const done = await replace(target, root)
    assert.equal(done.status, 'completed', JSON.stringify(done)); assert.equal(done.changed, 1)
    assert.equal(fs.readFileSync(target, 'utf8'), 'DONE\n')
    clean(root, [name])
  })
})
report('windows-security')
