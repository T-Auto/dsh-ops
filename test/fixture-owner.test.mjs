import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fixtureOwnerSid } from './lib/fixture-owner.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'

const traditional = 'S-1-5-21-100-200-300-1001'
const entra = 'S-1-12-1-100-200-300-400'
const probe = (sid = traditional, name = 'DOMAIN\\fixture') => ({
  status: 0, signal: null, stdout: `"${name}","${sid}"\r\n`, stderr: '',
})

await test('traditional and Entra user SIDs are returned intact', () => {
  for (const sid of [traditional, entra]) assert.equal(fixtureOwnerSid(probe(sid)), sid)
})
await test('only the SID column identifies the owner, even with misleading CSV names', () => {
  for (const name of ['S-1-5-18', 'DOMAIN\\with,comma', 'DOMAIN\\escaped""quote', 'AzureAD\\用户']) {
    assert.equal(fixtureOwnerSid(probe(entra, name)), entra)
  }
  assert.equal(fixtureOwnerSid(probe('invalid', traditional)), undefined)
})
await test('one quoted record accepts LF, CRLF or no line terminator', () => {
  for (const ending of ['', '\n', '\r\n']) {
    const value = probe()
    value.stdout = value.stdout.trimEnd() + ending
    assert.equal(fixtureOwnerSid(value), traditional)
  }
})
await test('failed, interrupted and unspawned commands never supply an owner', () => {
  for (const extra of [{ status: 1 }, { status: null }, { signal: 'SIGTERM' }, { error: new Error('spawn failed') }, { stderr: 'ERROR: command failed' }]) {
    assert.equal(fixtureOwnerSid({ ...probe(), ...extra }), undefined)
  }
  assert.equal(fixtureOwnerSid(undefined), undefined)
})
await test('malformed CSV, extra records, headers and diagnostics are rejected', () => {
  const row = probe().stdout
  for (const stdout of ['', row + row, '"User Name","SID"\r\n' + row, '\n' + row, row + '\n',
    row.trimEnd() + ',"extra"', `fixture,"${traditional}"`, `"","${traditional}"`,
    `"bad"quote","${traditional}"`, `ERROR: ${traditional}`, `"fixture","${traditional}`, `"fixture\0","${traditional}"`]) {
    assert.equal(fixtureOwnerSid({ ...probe(), stdout }), undefined, JSON.stringify(stdout))
  }
  assert.equal(fixtureOwnerSid({ ...probe(), stdout: Buffer.from(row) }), undefined)
})
await test('complete SID syntax and numeric bounds are validated', () => {
  for (const sid of ['S-1-0-0', 'S-1-281474976710655-4294967295', 'S-1-0xffffffffffff-0', 'S-1-5' + '-1'.repeat(15)]) {
    assert.equal(fixtureOwnerSid(probe(sid)), sid)
  }
  for (const sid of ['S-1-5', 'S-2-5-18', 'S-1-5-18-', 'S-1-5-18junk', 'prefixS-1-5-18',
    'S-1-5--18', 'S-1-5-+18', 'S-1-5-1.5', 'S-1-5-4294967296', 'S-1-281474976710656-1',
    'S-1-0x1000000000000-1', 'S-1-5' + '-1'.repeat(16), ' S-1-5-18', 'S-1-5-18 ']) {
    assert.equal(fixtureOwnerSid(probe(sid)), undefined, sid)
  }
})

if (process.platform === 'win32') {
  await test('a fresh temporary fixture gets the actual current user as owner', () => withTempDir('fixture-owner', directory => {
    const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
    const identity = spawnSync(path.join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' })
    const sid = fixtureOwnerSid(identity)
    assert.ok(sid, 'successful whoami must identify the user')
    const owner = spawnSync(path.join(system32, 'WindowsPowerShell/v1.0/powershell.exe'), [
      '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; [System.IO.Directory]::GetAccessControl($env:DSH_OPS_FIXTURE_OWNER_PATH).GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
    ], { encoding: 'utf8', env: { ...process.env, DSH_OPS_FIXTURE_OWNER_PATH: directory } })
    assert.equal(owner.status, 0, 'temporary fixture ACL must be readable')
    assert.equal(owner.stdout.trim() === sid, true, 'temporary fixture owner must equal current SID')
    fs.writeFileSync(path.join(directory, 'fixture.txt'), 'fixture')
    assert.equal(fs.readFileSync(path.join(directory, 'fixture.txt'), 'utf8'), 'fixture')
  }))
} else {
  console.log('Windows fixture ownership unavailable: requires Windows whoami/icacls; pure parser checks still run')
}
report('fixture-owner')
