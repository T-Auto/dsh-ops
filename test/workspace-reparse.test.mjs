import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assert, test, report, withTempDir, TEST_HOME } from './lib/harness.mjs'
import { preparationEnvironment } from '../lib/workspace-preparation.js'

/**
 * Issue #937: OneDrive tags a synced directory with a cloud reparse point, and
 * the ancestry walk refused every reparse point, so no workspace below OneDrive
 * could be prepared. Only cloud storage placeholders may now pass; a junction or
 * symlink still refuses before any ACL work.
 *
 * A cloud tag cannot be fabricated for a test — the Cloud Files filter rejects a
 * hand-written one — so the allow decision is exercised through the production
 * helper with the tags a real OneDrive reports, and the refusal through real
 * junctions that the shipped script walks.
 */
if (process.platform === 'win32') await windowsReparseChecks()
else console.log('  Windows reparse fixture unavailable: real junctions and PowerShell checks require Windows')

async function windowsReparseChecks() {

const helper = fileURLToPath(new URL('../bin/workspace-reparse.ps1', import.meta.url))
const preparation = fileURLToPath(new URL('../bin/prepare-workspace.ps1', import.meta.url))
const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
const quote = (text) => "'" + text.replaceAll("'", "''") + "'"
const tagLiteral = (tag) => `[uint32]::Parse('${tag}', [Globalization.NumberStyles]::HexNumber)`

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

/** The allow decision for one reparse tag, from the production helper. */
function allowed(tag) {
  return psValue(`$ErrorActionPreference='Stop'
. ${quote(helper)}
Test-DshOpsAllowedReparseTag -Tag (${tagLiteral(tag)})`) === 'True'
}

/** The first unaccounted path for synthetic ancestry entries, or '(none)'. */
function unaccounted(pairs) {
  const entries = pairs.map(([where, tag]) =>
    `[pscustomobject]@{ Path = ${quote(where)}; Tag = ${tag === null ? '$null' : tagLiteral(tag)} }`).join('\n')
  return psValue(`$ErrorActionPreference='Stop'
. ${quote(helper)}
$entries = @(
${entries}
)
$found = Find-DshOpsUnaccountedReparsePoint -Entries $entries
if ($null -eq $found) { '(none)' } else { $found.Path }`)
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

await test('cloud storage placeholders are allowed on the workspace ancestry (#937)', () => {
  // 0x9000001A is IO_REPARSE_TAG_CLOUD; 0x9000N01A are the per-provider variants.
  // The last two are the tags a real OneDrive tagged folders with on the reporting host.
  for (const tag of ['9000001A', '9000101A', '9000601A', '9000701A', '9000F01A']) {
    assert.equal(allowed(tag), true, `tag 0x${tag} must be allowed`)
    assert.equal(unaccounted([['C:\\Users\\example\\OneDrive', tag]]), '(none)')
  }
})

await test('junctions, symlinks and other reparse points stay refused (#937)', () => {
  for (const tag of ['A0000003', 'A000000C', '80000013', '9000001B']) {
    assert.equal(allowed(tag), false, `tag 0x${tag} must be refused`)
  }
  // Nearest first: the junction on the root's own path is reported, cloud above it is not.
  assert.equal(unaccounted([['C:\\ws', 'A0000003'], ['C:\\Users', null], ['C:\\', '9000001A']]), 'C:\\ws')
  assert.equal(unaccounted([['C:\\ws', null], ['C:\\link', 'A0000003'], ['C:\\', '9000001A']]), 'C:\\link')
})

await test('the shipped script refuses a junction root, names its tag and writes no receipt', async () => {
  await withTempDir('reparse-junction-root', async (dir) => {
    const target = path.join(dir, 'target')
    fs.mkdirSync(target)
    const link = path.join(dir, 'link')
    fs.symlinkSync(target, link, 'junction')
    const backups = path.join(TEST_HOME, 'reparse-junction-root-backups')
    const value = runScript(link, backups)
    assert.notEqual(value.status, 0)
    assert.match(value.stderr, /not a cloud storage placeholder/)
    assert.match(value.stderr, /0xA0000003/)
    assert.equal(receipts(backups), 0)
  })
})

await test('the shipped script refuses a junction above the workspace root', async () => {
  await withTempDir('reparse-junction-above', async (dir) => {
    const target = path.join(dir, 'target')
    fs.mkdirSync(path.join(target, 'ws'), { recursive: true })
    const link = path.join(dir, 'link')
    fs.symlinkSync(target, link, 'junction')
    const backups = path.join(TEST_HOME, 'reparse-junction-above-backups')
    const value = runScript(path.join(link, 'ws'), backups)
    assert.notEqual(value.status, 0)
    assert.match(value.stderr, /not a cloud storage placeholder/)
    assert.match(value.stderr, /0xA0000003/)
    assert.equal(receipts(backups), 0)
  })
})

}

report('workspace-reparse')
