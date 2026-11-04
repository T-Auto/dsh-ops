import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assert, test, report, skipSuite, withTempDir, TEST_HOME, canonical } from './lib/harness.mjs'
import { preparationEnvironment } from '../lib/workspace-preparation.js'

/**
 * The Windows workspace prerequisite is decided before any ACL is written, and
 * issue #651 showed the owner comparison ran first: a folder owned by another
 * account (a common Administrators-owned workspace) was refused even when the
 * caller already held WRITE_OWNER. These checks pin the decision order and the
 * real script's dispatch without needing an elevated shell.
 */
if (process.platform !== 'win32') skipSuite('workspace-acl', 'Windows workspace ACL preparation is Windows-only')

const helper = fileURLToPath(new URL('../bin/workspace-acl.ps1', import.meta.url))
const preparation = fileURLToPath(new URL('../bin/prepare-workspace.ps1', import.meta.url))
const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
const quote = (text) => "'" + text.replaceAll("'", "''") + "'"

/** Run PowerShell 5.1 the way production does: scrubbed environment, bypassed policy. */
function ps(code) {
  const value = spawnSync(powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')],
    { encoding: 'utf8', env: preparationEnvironment(), windowsHide: true, timeout: 30_000 })
  return value
}

function psValue(code) {
  const value = ps(code)
  assert.equal(value.status, 0, value.stderr)
  return value.stdout.trim()
}

const userSid = psValue('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value')

/** The decision for one synthetic DACL, read from the production helper. */
function decision(sddl) {
  return psValue(`$ErrorActionPreference='Stop'
. ${quote(helper)}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=[Security.Principal.WindowsPrincipal]::new($identity)
$acl=[Security.AccessControl.DirectorySecurity]::new()
$acl.SetSecurityDescriptorSddlForm(${quote(sddl)})
(Get-DshOpsWorkspaceDecision -Acl $acl -Identity $identity -Principal $principal).State`)
}

function decisionReason(sddl) {
  return psValue(`$ErrorActionPreference='Stop'
. ${quote(helper)}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=[Security.Principal.WindowsPrincipal]::new($identity)
$acl=[Security.AccessControl.DirectorySecurity]::new()
$acl.SetSecurityDescriptorSddlForm(${quote(sddl)})
(Get-DshOpsWorkspaceDecision -Acl $acl -Identity $identity -Principal $principal).Reason`)
}

/** Run the shipped bootstrap exactly as production launches it. */
function runScript(root, backups) {
  return spawnSync(powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', preparation, '-Workspace', root, '-BackupDir', backups],
    { encoding: 'utf8', env: preparationEnvironment(), windowsHide: true, timeout: 30_000 })
}

function receipts(backups) {
  return fs.existsSync(backups) ? fs.readdirSync(backups).length : 0
}

await test('a folder owned by another account is ready when its DACL already grants WRITE_OWNER (#651)', () => {
  // The reported shape: BUILTIN\Administrators owns the workspace, the caller
  // holds an explicit WRITE_OWNER entry. Nothing must be written.
  assert.equal(decision(`O:BAG:SYD:(A;;0x80000;;;${userSid})`), 'ready')
})

await test('a folder owned by another account without WRITE_OWNER is refused as an owner mismatch (#651)', () => {
  const sddl = 'O:BAG:SYD:(A;;FR;;;WD)'
  assert.equal(decision(sddl), 'foreign-owner')
  const reason = decisionReason(sddl)
  assert.match(reason, /not owned by the current user/)
  assert.match(reason, /does not already grant WRITE_OWNER/)
  assert.match(reason, /danger-full-access/)
})

await test('an owned folder without WRITE_OWNER still takes the preparation path', () => {
  assert.equal(decision(`O:${userSid}G:SYD:(A;;FR;;;WD)`), 'needs-preparation')
})

await test('an explicit denial wins over an allow entry and over a foreign owner', () => {
  assert.equal(decision(`O:${userSid}G:SYD:(D;;0x80000;;;${userSid})(A;;FA;;;${userSid})`), 'denied')
  assert.equal(decision(`O:BAG:SYD:(D;;0x80000;;;${userSid})(A;;FA;;;BA)`), 'denied')
})

await test('the shipped script takes the ready path without writing a backup receipt', () => {
  // No ownWindowsFixture on purpose: an elevated runner keeps the foreign owner
  // this issue is about, while a non-elevated host gets a caller-owned root. The
  // platform temp ACL grants the signed-in user full control, so WRITE_OWNER is
  // effective in both cases; only the elevated run also discriminates the
  // owner-first order end to end, which the decision checks above always do.
  const root = canonical(fs.mkdtempSync(path.join(TEST_HOME, 'prepare-ready-')))
  const backups = path.join(TEST_HOME, 'prepare-ready-backups')
  try {
    const value = runScript(root, backups)
    assert.equal(value.status, 0, value.stderr)
    assert.equal(value.stdout.trim(), 'ready')
    assert.equal(receipts(backups), 0, 'the ready path writes no receipt')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

await test('the shipped script dispatches an explicit denial before touching the ACL', async () => {
  await withTempDir('prepare-denied', async (root) => {
    const backups = path.join(TEST_HOME, 'prepare-denied-backups')
    psValue(`$p=${quote(root)}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl=[Security.AccessControl.DirectorySecurity]::new()
$acl.SetSecurityDescriptorSddlForm("O:$sid" + "G:SY" + "D:(D;;0x80000;;;$sid)(A;;FA;;;$sid)")
Set-Acl -LiteralPath $p -AclObject $acl`)
    const before = psValue(`(Get-Acl -LiteralPath ${quote(root)}).GetSecurityDescriptorSddlForm('Access')`)
    const value = runScript(root, backups)
    assert.notEqual(value.status, 0)
    assert.match(value.stderr, /Explicit effective denial of WRITE_OWNER/)
    assert.equal(receipts(backups), 0)
    assert.equal(psValue(`(Get-Acl -LiteralPath ${quote(root)}).GetSecurityDescriptorSddlForm('Access')`), before)
  })
})

report('workspace-acl')
