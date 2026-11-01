import path from 'node:path'
import { assert, test, report } from './lib/harness.mjs'
import { fakeSubprocess } from './lib/shells-fixtures.mjs'
import { startBashExecution } from '../lib/shells/execution.js'
import { hostForeground, renderHostBash } from '../lib/shells/host-contract.js'

async function electron(body) {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron')
  Object.defineProperty(process.versions, 'electron', { value: '44.0.0', configurable: true })
  try { await body() } finally {
    if (descriptor) Object.defineProperty(process.versions, 'electron', descriptor)
    else delete process.versions.electron
  }
}
const spec = { command: 'echo RUNNER_MUST_RUN', timeoutMs: 10_000, graceMs: 100, includeDiagnostics: false }

await test('an Electron self-runner is refused before a zero-exit GUI process can masquerade as Bash', async () => {
  await electron(async () => {
    const subprocess = fakeSubprocess({ exitCode: 0 })
    const execution = startBashExecution({ file: path.resolve('bash.exe'), source: 'bundled', subprocess: subprocess.service,
      prepareArgv: async argv => [process.execPath, path.resolve('dsh-sandbox-windows-acl/runner.js'), ...argv] }, spec)
    subprocess.settle()
    const value = hostForeground(await execution.result(), execution.started ? 'unknown' : 'none')
    assert.equal(subprocess.specs.length, 0, 'the unadapted Electron application must never be spawned')
    assert.equal(value.status, 'failed')
    assert.equal(value.failure.code, 'EXECUTOR_UNAVAILABLE')
    assert.equal(value.failure.effectState, 'none')
    assert.equal(value.exitCode, null)
    assert.match(renderHostBash(value), /Electron.*runner/i)
    assert.doesNotMatch(renderHostBash(value), /exit code: 0/)
  })
})

await test('a host-selected external runner retains its argv and empty successful output', async () => {
  await electron(async () => {
    const subprocess = fakeSubprocess({ exitCode: 0 })
    const prepared = [path.resolve('host-node.exe'), path.resolve('runner.js'), 'bash.exe', '-c', 'true']
    const execution = startBashExecution({ file: path.resolve('bash.exe'), source: 'bundled', subprocess: subprocess.service,
      prepareArgv: async () => prepared }, spec)
    subprocess.settle()
    const value = hostForeground(await execution.result())
    assert.deepEqual(subprocess.specs[0].argv, prepared)
    assert.equal(value.status, 'completed')
    assert.equal(value.exitCode, 0)
    assert.equal(value.stdout.text, '')
  })
})

await test('an explicitly prepared Electron Node runner is preserved without injecting environment', async () => {
  await electron(async () => {
    const subprocess = fakeSubprocess({ exitCode: 0 })
    const prepared = [process.execPath, path.resolve('runner.js'), 'bash.exe', '-c', 'true']
    const execution = startBashExecution({ file: path.resolve('bash.exe'), source: 'bundled', subprocess: subprocess.service,
      env: { ELECTRON_RUN_AS_NODE: '1' }, prepareArgv: async () => prepared }, spec)
    subprocess.settle()
    const value = hostForeground(await execution.result())
    assert.deepEqual(subprocess.specs[0].argv, prepared)
    assert.equal(subprocess.specs[0].env.ELECTRON_RUN_AS_NODE, '1')
    assert.equal(value.status, 'completed')
  })
})

report('shells-electron-runner')
