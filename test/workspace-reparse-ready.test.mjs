import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assert, test, report, withTempDir, TEST_HOME } from './lib/harness.mjs'
import { preparationEnvironment } from '../lib/workspace-preparation.js'

/**
 * Issue #744: a OneDrive folder carries IO_REPARSE_TAG_CLOUD, so the workspace
 * bootstrap's reparse-point walk refused it before the DACL decision could
 * say the folder was already ready, and every workspace-write tool failed.
 * The reparse check belongs to the preparation branch alone — the only path
 * that writes — and there it must let the cloud-files family through (they are
 * ordinary directory entries to the ACL layer) and fail every other tag closed
 * with the tag named. Cloud tags cannot be synthesized without the cloud
 * filter API, so the family rule is pinned on the pure decision function and
 * the walk itself is pinned with a junction, which is a real mount-point tag.
 */
if (process.platform === 'win32') await windowsReparseChecks()
else console.log('  Windows reparse fixture unavailable: real DACL and PowerShell checks require Windows')

async function windowsReparseChecks() {

const helper = fileURLToPath(new URL('../bin/workspace-acl.ps1', import.meta.url))
const preparation = fileURLToPath(new URL('../bin/prepare-workspace.ps1', import.meta.url))
const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
const quote = (text) => "'" + text.replaceAll("'", "''") + "'"

/** Run PowerShell 5.1 the way production does: scrubbed environment, bypassed policy. */
function ps(code) {
  return spawnSync(powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')],
    { encoding: 'utf8', env: preparationEnvironment(), windowsHide: true, timeout: 30_000 })
}

function psValue(code) {
  const value = ps(code)
  assert.equal(value.status, 0, value.stderr)
  return value.stdout.trim()
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

/** A junction under the temporary home: a real mount point (tag 0xA0000003). */
function junctionFixture(base) {
  const target = path.join(base, 'target')
  fs.mkdirSync(target)
  const root = path.join(base, 'root')
  const made = spawnSync('cmd.exe', ['/c', 'mklink', '/J', root, target], { encoding: 'utf8' })
  assert.equal(made.status, 0, made.stderr)
  return root
}

await test('reparse tag classification lets the cloud-files family through and fails every other tag closed', () => {
  const state = (tag) => psValue(`$ErrorActionPreference='Stop'
. ${quote(helper)}
(Get-DshOpsReparseTagDecision -Tag ${tag}).State`)
  // Decimal literals on purpose: Windows PowerShell 5.1 folds hex literals in
  // the 0x90000000-0xFFFFFFFF band into a negative Int32, which cannot convert
  // to the function's [uint32] parameter. 2415919130 is IO_REPARSE_TAG_CLOUD,
  // 2415923226 CLOUD_ROOT, 2415927322 CLOUD_ON_DEMAND: the proven cloud-files
  // family has the exact shape 0x9000?01A, and only that family is allowed —
  // because a placeholder keeps a real directory entry behind the point, so an
  // ACL write targets a real object. 2415980570 (0x9000F01A) shares that family
  // shape under the mask.
  assert.equal(state(2415919130), 'cloud')
  assert.equal(state(2415923226), 'cloud')
  assert.equal(state(2415927322), 'cloud')
  assert.equal(state(2415980570), 'cloud')
  // A high nibble of 9 alone is NOT enough (#744 review): 2684354559 is
  // 0x9FFFFFFF and 2415963085 is 0x9000ABCD, whose low 16 bits are not the
  // ?01A family shape. Unproven tags must fail closed before a DACL write.
  assert.equal(state(2684354559), 'unsupported')
  assert.equal(state(2415963085), 'unsupported')
  // 0xA0000003 is a mount point and 0xA000000C a symlink; unknown tags like
  // 0x8000001B redirect or transform the view and must fail closed when
  // preparation is about to write the DACL.
  assert.equal(state(2684354563), 'unsupported')
  assert.equal(state(2684354572), 'unsupported')
  assert.equal(state(2147483675), 'unsupported')
})

await test('a junction workspace with an effective WRITE_OWNER takes the ready path without a reparse refusal (#744)', async () => {
  await withTempDir('prepare-reparse-ready', async (base) => {
    const root = junctionFixture(base)
    const backups = path.join(TEST_HOME, 'prepare-reparse-ready-backups')
    const value = runScript(root, backups)
    assert.equal(value.status, 0, value.stderr)
    assert.equal(value.stdout.trim(), 'ready')
    assert.equal(receipts(backups), 0, 'the ready path writes no receipt')
  })
})

await test('a junction workspace that still needs the ACE fails closed and names its reparse tag (#744)', async () => {
  await withTempDir('prepare-reparse-need', async (base) => {
    const root = junctionFixture(base)
    const backups = path.join(TEST_HOME, 'prepare-reparse-need-backups')
    // Get-Acl reads the junction object's own security descriptor: it opens the
    // reparse point itself, which is why icacls — which follows the point — could
    // not prepare this fixture. Set-Acl uses the same handle, so one call both
    // takes ownership for the caller and installs a protected DACL that grants
    // Modify but never WRITE_OWNER. The decision must then be needs-preparation:
    // the one branch that writes, and therefore the branch allowed to read tags.
    const sid = psValue('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value')
    const prepared = psValue(`$ErrorActionPreference='Stop'
$sid = New-Object Security.Principal.SecurityIdentifier(${quote(sid)})
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($sid)
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::Modify, 'None', 'None', 'Allow')))
Set-Acl -LiteralPath ${quote(root)} -AclObject $acl
'ok'`)
    assert.equal(prepared, 'ok')
    const state = psValue(`$ErrorActionPreference='Stop'
. ${quote(helper)}
$acl=Get-Acl -LiteralPath ${quote(root)}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=[Security.Principal.WindowsPrincipal]::new($identity)
(Get-DshOpsWorkspaceDecision -Acl $acl -Identity $identity -Principal $principal).State`)
    assert.equal(state, 'needs-preparation')
    const value = runScript(root, backups)
    assert.notEqual(value.status, 0, JSON.stringify(value.stdout))
    // The refusal must name the actual tag, so the operator can tell a cloud
    // placeholder from a mount point instead of a blanket reparse rejection.
    assert.match(value.stderr, /reparse point/)
    assert.match(value.stderr, /0xA0000003/)
    assert.equal(receipts(backups), 0, 'a refused preparation writes no receipt')
  })
})

}

report('workspace-reparse-ready')
