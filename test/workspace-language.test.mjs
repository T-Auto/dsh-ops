import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { classifyPreparationFailure, preparationEnvironment, runPreparation } from '../lib/workspace-preparation.js'

await test('ConstrainedLanguage failures name the language restriction without suggesting a bypass', async () => {
  for (const output of ['DSH_OPS_CONSTRAINED_LANGUAGE: workspace preparation requires FullLanguage.',
    'MethodInvocationNotSupportedInConstrainedLanguage', 'CannotCreateTypeConstrainedLanguage']) {
    const message = classifyPreparationFailure(output, { root: 'C:\\workspace' })
    assert.match(message, /ConstrainedLanguage/)
    assert.match(message, /no ACL preparation was completed/)
    assert.doesNotMatch(message, /danger-full-access|ExecutionPolicy Bypass|disable.*policy/i)
  }
  await assert.rejects(runPreparation('C:\\workspace', { executable: process.execPath,
    args: ['-e', 'process.stderr.write("DSH_OPS_CONSTRAINED_LANGUAGE: blocked"); process.exit(1)'] }),
  /DSH workspace preparation failed: PowerShell ConstrainedLanguage/)
})

if (process.platform === 'win32') await test('the real preparation script refuses CLM before identity lookup or ACL side effects', async () => {
  await withTempDir('prepare-clm', async root => {
    const script = fileURLToPath(new URL('../bin/prepare-workspace.ps1', import.meta.url))
    const backups = path.join(root, 'backups')
    const quote = text => "'" + text.replaceAll("'", "''") + "'"
    const command = "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'; & "
      + quote(script) + ' -Workspace ' + quote(root) + ' -BackupDir ' + quote(backups)
    const value = spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
      { encoding: 'utf8', env: preparationEnvironment(), windowsHide: true, timeout: 15_000 })
    assert.equal(value.status, 1, JSON.stringify(value))
    assert.match(value.stderr, /DSH_OPS_CONSTRAINED_LANGUAGE/)
    assert.doesNotMatch(value.stderr, /MethodInvocationNotSupportedInConstrainedLanguage|CannotDefineNewType/)
    assert.equal(fs.existsSync(backups), false)
  })
})

report('workspace-language')
