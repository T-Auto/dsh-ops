import { assert, test, report } from './lib/harness.mjs'
import { fakeSubprocess } from './lib/shells-fixtures.mjs'
import { startBashExecution } from '../lib/shells/execution.js'
import { hostForeground, renderHostBash } from '../lib/shells/host-contract.js'

const spec = { command: 'echo STARTUP_SENTINEL', timeoutMs: 10_000, graceMs: 100, includeDiagnostics: false }

if (process.platform === 'win32') await test('Windows DLL initialization status is named without inventing no-effect execution', async () => {
  for (const exitCode of [0xC0000142, -1073741502]) {
    const subprocess = fakeSubprocess({ exitCode })
    const execution = startBashExecution({ file: 'bash.exe', source: 'bundled', subprocess: subprocess.service }, spec)
    subprocess.settle()
    const value = hostForeground(await execution.result(), execution.started ? 'unknown' : 'none')
    assert.equal(value.status, 'failed')
    assert.equal(value.exitCode, exitCode)
    assert.equal(value.failure.code, 'STATUS_DLL_INIT_FAILED')
    assert.equal(value.failure.effectState, 'unknown')
    assert.equal(value.failure.retry, 'never')
    assert.match(value.failure.message, /host runner|child process/)
    assert.match(renderHostBash(value), /STATUS_DLL_INIT_FAILED/)
  }
})
else console.log('  skip Windows NTSTATUS semantics')

await test('an ordinary failed command keeps its actionable exit-code contract', async () => {
  const subprocess = fakeSubprocess({ exitCode: 49 })
  const execution = startBashExecution({ file: 'bash.exe', source: 'bundled', subprocess: subprocess.service }, spec)
  subprocess.settle()
  const value = hostForeground(await execution.result())
  assert.equal(value.failure.code, 'EXIT_CODE')
  assert.equal(value.failure.retry, 'after-input-change')
  assert.equal(value.exitCode, 49)
})

report('shells-windows-startup')
