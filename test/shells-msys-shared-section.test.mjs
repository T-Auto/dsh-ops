/** A shared MSYS section failure reports as the runtime failure it is (#409). */
import path from 'node:path'
import { startSessionBash } from '../lib/shells/session-execution.js'
import { NIUBASH_PACKAGE_PATH } from '../lib/cli/niubash-payload.js'
import { syntheticNiubashTree } from './lib/niubash-distribution-fixture.mjs'
import { assert, report, skipSuite, test, withTempDir } from './lib/harness.mjs'

if (process.platform !== 'win32') skipSuite('shells-msys-shared-section', 'requires the Windows Niubash runtime branch')

await test('a CreateFileMapping shared-section failure is EXECUTOR_UNAVAILABLE, never a denial', async () => {
  await withTempDir('niu-section', async root => {
    const source = syntheticNiubashTree(path.join(root, 'package', NIUBASH_PACKAGE_PATH))
    const policy = { mode: 'workspace-write', workspaceRoot: root }
    const agent = { id: 'niu-section', session: { id: 'niu-section', header: { cwd: root } } }
    // msys-2.0.dll prints exactly "CreateFileMapping %W, %E.  Terminating." with %E as
    // "Win32 error %d": a restricted token cannot reopen a per-user section an unrestricted
    // MSYS process created first, because that object's DACL has no restricted-logon ACE (#409).
    const sectionFailure = 'bash: CreateFileMapping S-1-5-21-500-1001.1, Win32 error 5.  Terminating.'
    const ctx = {
      get(name) {
        if (name === 'sandboxPolicy') return { resolve: () => policy }
        if (name === 'sandbox') return { confine: async argv => ({ argv, enforcement: 'partial', denialSignatures: ['permission denied'] }) }
        if (name === 'subprocess') return {
          spawn() {
            const stream = text => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
            return { done: Promise.resolve({ exitCode: 126, signal: null }), collected: { stdout: stream(''), stderr: stream(sectionFailure) } }
          },
        }
        return undefined
      },
    }
    const execution = startSessionBash({ ctx, bash: { file: path.join(source, 'niu.exe'), source: 'bundled' }, active: () => true },
      { command: 'true', workdir: root }, { agent, signal: new AbortController().signal }, policy, policy, {}, {})
    const value = await execution.result()
    assert.match(value.stderr.text, /CreateFileMapping/, 'the simulated stderr reached the result')
    // The shared-section conflict belongs to the restricted-token runtime, exactly like the
    // signal-pipe failure, so the model must not read it as a user authorization denial.
    assert.match(value.error ?? '', /EXECUTOR_UNAVAILABLE/)
    assert.equal(value.sandbox.runnerFailed, true)
    assert.equal(value.sandbox.denied, false, 'a shared-section conflict is not a user authorization denial')
    assert.equal(value.exitCode, 126)
  })
})
report('shells-msys-shared-section')
