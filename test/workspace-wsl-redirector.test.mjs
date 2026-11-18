import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assert, test, report, TEST_HOME } from './lib/harness.mjs'
import { preparationEnvironment } from '../lib/workspace-preparation.js'

/**
 * Issue #669: \\wsl.localhost and \\wsl$ are the WSL 9P redirector, and the
 * filesystem behind it exposes no NTFS security descriptor at all. The
 * bootstrap's Get-Acl therefore threw on every WSL workspace and all of
 * run_code died. The fix is a prefix decision, not a catch that swallows ACL
 * errors: those two Microsoft-fixed prefixes answer ready (authority there
 * is the distribution's own uid/gid mapping), and every other path keeps its
 * existing behaviour, where a real Get-Acl failure still fails closed.
 */
if (process.platform === 'win32') await windowsWslChecks()
else console.log('  Windows WSL redirector fixture unavailable: real DACL and PowerShell checks require Windows')

async function windowsWslChecks() {

const helper = fileURLToPath(new URL('../bin/workspace-acl.ps1', import.meta.url))
const preparation = fileURLToPath(new URL('../bin/prepare-workspace.ps1', import.meta.url))
const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
const wsl = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe')
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

/** The first installed distribution whose UNC root answers Get-Item, or nothing. */
function firstLiveDistro() {
  const listed = spawnSync(wsl, ['-l', '-q'], { timeout: 20_000 })
  if (listed.status !== 0 || !listed.stdout || listed.stdout.length === 0) return undefined
  // wsl.exe prints UTF-16LE regardless of the console code page.
  const names = listed.stdout.toString('utf16le').split(/[\r\n]+/)
    .map(line => line.replace(/\u0000/g, '').trim()).filter(line => line.length > 0)
  for (const name of names) {
    const probe = ps(`try { $null = Get-Item -LiteralPath ${quote('\\\\wsl.localhost\\' + name + '\\tmp')} -Force -ErrorAction Stop; 'ok' } catch { 'no' }`)
    if (probe.status === 0 && probe.stdout.trim() === 'ok') return name
  }
  return undefined
}

await test('NTFS state classification separates the two WSL redirector prefixes from everything else', () => {
  const state = (value) => psValue(`$ErrorActionPreference='Stop'
. ${quote(helper)}
(Get-DshOpsWorkspaceNtfsState -Path ${quote(value)})`)
  // Microsoft-fixed redirector spellings, case-insensitive, incl. the \\?\UNC form.
  assert.equal(state('\\\\wsl.localhost\\Ubuntu\\home\\pc'), 'wsl-redirector')
  assert.equal(state('\\\\wsl$\\Ubuntu\\tmp'), 'wsl-redirector')
  assert.equal(state('\\\\?\\UNC\\wsl.localhost\\Ubuntu\\tmp'), 'wsl-redirector')
  assert.equal(state('\\\\WSL.LOCALHOST\\Ubuntu\\tmp'), 'wsl-redirector')
  // Everything else is NTFS business as usual: a real ACL error there must
  // still fail closed, not be absorbed into a redirector allowance.
  assert.equal(state('D:\\normal\\path'), 'ntfs')
  assert.equal(state('\\\\server\\share\\file'), 'ntfs')
  assert.equal(state('\\\\wsl.localhost2\\a'), 'ntfs')
  assert.equal(state('\\\\wslx\\Ubuntu\\a'), 'ntfs')
  assert.equal(state('wsl'), 'ntfs')
})

await test('a redirector-spelled workspace answers ready without touching Get-Item or Get-Acl (#669)', () => {
  // The distribution does not exist: the prefix decision must complete before
  // any existence probe, exactly like a live 9P root whose Get-Acl cannot work.
  const root = '\\\\wsl.localhost\\nonexistent-distro\\workspace'
  const backups = path.join(TEST_HOME, 'prepare-wsl-redirector-backups')
  const value = runScript(root, backups)
  assert.equal(value.status, 0, value.stderr)
  assert.equal(value.stdout.trim(), 'ready')
})

await test('a live WSL UNC workspace answers ready instead of dying inside Get-Acl (#669)', () => {
  const distro = firstLiveDistro()
  if (!distro) {
    console.log('    (no installed WSL distribution answered; the live 9P end-to-end case did not run)')
    return
  }
  const root = `\\\\wsl.localhost\\${distro}\\tmp`
  const backups = path.join(TEST_HOME, 'prepare-wsl-redirector-live-backups')
  const value = runScript(root, backups)
  assert.equal(value.status, 0, value.stderr)
  assert.equal(value.stdout.trim(), 'ready')
})

}

report('workspace-wsl-redirector')
