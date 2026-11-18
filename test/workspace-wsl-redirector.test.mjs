import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assert, test, report, wait, TEST_HOME } from './lib/harness.mjs'
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

// The live 9P end-to-end case is an explicit opt-in: it needs a real installed
// distribution, so it registers only when DSH_OPS_TEST_WSL_DISTRO names one. It
// is reported as not run otherwise — an unavailable distribution never counts
// as a passing check, and the default suite keeps its honest coverage below.
// Registration order and the probe are host facts, not preferences: touching a
// nonexistent \\wsl.localhost distribution leaves the P9NP redirector unable to
// answer even valid paths for under two seconds (measured on this host), so
// this case registers before the negative one, probes at registration time so
// a check never silently passes as an empty body, and retries once within that
// window. A still-failing probe is reported as not run and not counted.
const liveDistro = process.env.DSH_OPS_TEST_WSL_DISTRO
let liveProvider = 'not-answering'
if (liveDistro) {
  for (const attempt of [0, 1]) {
    const probe = ps(`try { \$null = Get-Item -LiteralPath ${quote(`\\\\wsl.localhost\\${liveDistro}\\tmp`)} -Force -ErrorAction Stop; 'ok' } catch { 'no' }`)
    if (probe.status === 0 && probe.stdout.trim() === 'ok') { liveProvider = 'answering'; break }
    if (attempt === 0) await wait(2500)
  }
}
if (liveDistro && liveProvider === 'answering') {
  await test(`the live WSL UNC workspace ${liveDistro} answers ready instead of dying inside Get-Acl (#669)`, () => {
    const root = `\\\\wsl.localhost\\${liveDistro}\\tmp`
    const backups = path.join(TEST_HOME, 'prepare-wsl-redirector-live-backups')
    const value = runScript(root, backups)
    assert.equal(value.status, 0, value.stderr)
    assert.equal(value.stdout.trim(), 'ready')
  })
} else if (liveDistro) {
  console.log('  (live 9P end-to-end not run: the redirector is not answering right now; not counted as passed)')
} else {
  console.log('  (live 9P end-to-end not run: set DSH_OPS_TEST_WSL_DISTRO=<distro> to include it; not counted as passed)')
}

await test('a redirector-spelled workspace that does not exist fails instead of answering ready (#669)', () => {
  // The prefix allowance must not widen into skipping existence: a 9P-spelled
  // path that does not resolve still has to fail the same way any other
  // missing workspace does, after the Get-Item/container validation.
  const root = '\\\\wsl.localhost\\nonexistent-distro\\workspace'
  const backups = path.join(TEST_HOME, 'prepare-wsl-redirector-backups')
  const value = runScript(root, backups)
  assert.notEqual(value.status, 0, 'a missing 9P workspace must not be answered ready')
  assert.ok(!value.stdout.includes('ready'))
  assert.equal(fs.existsSync(backups) ? fs.readdirSync(backups).length : 0, 0)
})

}

report('workspace-wsl-redirector')
