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
const nodeMode = env => Object.entries(env).filter(([key]) => key.toUpperCase() === 'ELECTRON_RUN_AS_NODE')

await test('an Electron self-runner gets Node mode instead of relaunching the Desktop application', async () => {
  await electron(async () => {
    const subprocess = fakeSubprocess({ exitCode: 0, stdout: 'RUNNER_MUST_RUN\n' })
    const prepared = [process.execPath, path.resolve('dsh-sandbox-windows-acl/runner.js'), 'bash.exe', '-c', spec.command]
    const execution = startBashExecution({ file: path.resolve('bash.exe'), source: 'bundled', subprocess: subprocess.service,
      prepareArgv: async () => prepared }, spec)
    subprocess.settle()
    const value = hostForeground(await execution.result())
    // The argv the sandbox built runs unchanged; only the environment gains Node mode.
    assert.equal(subprocess.specs.length, 1, 'the adapted self-runner must be spawned')
    assert.deepEqual(subprocess.specs[0].argv, prepared)
    assert.equal(subprocess.specs[0].env.ELECTRON_RUN_AS_NODE, '1')
    // Adaptation adds one variable; it must not replace the environment the caller prepared.
    assert.equal(subprocess.specs[0].env.TERM, 'dumb')
    assert.equal(subprocess.specs[0].env.NO_COLOR, '1')
    assert.equal(value.status, 'completed')
    assert.equal(value.exitCode, 0)
    assert.equal(value.stdout.text, 'RUNNER_MUST_RUN\n')
    assert.doesNotMatch(renderHostBash(value), /EXECUTOR_UNAVAILABLE/)
  })
})

await test('a host-selected external runner retains its argv and gains no Node mode', async () => {
  await electron(async () => {
    const subprocess = fakeSubprocess({ exitCode: 0 })
    const prepared = [path.resolve('host-node.exe'), path.resolve('runner.js'), 'bash.exe', '-c', 'true']
    const execution = startBashExecution({ file: path.resolve('bash.exe'), source: 'bundled', subprocess: subprocess.service,
      prepareArgv: async () => prepared }, spec)
    subprocess.settle()
    const value = hostForeground(await execution.result())
    assert.deepEqual(subprocess.specs[0].argv, prepared)
    assert.deepEqual(nodeMode(subprocess.specs[0].env), [], 'a real Node runner needs no adaptation')
    assert.equal(value.status, 'completed')
    assert.equal(value.exitCode, 0)
    assert.equal(value.stdout.text, '')
  })
})

await test('an explicitly prepared Electron Node runner is preserved without a second spelling', async () => {
  await electron(async () => {
    const subprocess = fakeSubprocess({ exitCode: 0 })
    const prepared = [process.execPath, path.resolve('runner.js'), 'bash.exe', '-c', 'true']
    const execution = startBashExecution({ file: path.resolve('bash.exe'), source: 'bundled', subprocess: subprocess.service,
      env: { ELECTRON_RUN_AS_NODE: '1' }, prepareArgv: async () => prepared }, spec)
    subprocess.settle()
    const value = hostForeground(await execution.result())
    assert.deepEqual(subprocess.specs[0].argv, prepared)
    assert.deepEqual(nodeMode(subprocess.specs[0].env), [['ELECTRON_RUN_AS_NODE', '1']])
    assert.equal(value.status, 'completed')
  })
})

await test('a non-Electron host that resolves its own executable is left exactly as it was', async () => {
  const subprocess = fakeSubprocess({ exitCode: 0 })
  const prepared = [process.execPath, path.resolve('runner.js'), 'bash.exe', '-c', 'true']
  const execution = startBashExecution({ file: path.resolve('bash.exe'), source: 'bundled', subprocess: subprocess.service,
    prepareArgv: async () => prepared }, spec)
  subprocess.settle()
  const value = hostForeground(await execution.result())
  assert.deepEqual(nodeMode(subprocess.specs[0].env), [], 'a CLI host must not be told to enter Electron Node mode')
  assert.equal(value.status, 'completed')
})

await test('a contradicting inherited Node-mode value is replaced rather than duplicated', async () => {
  await electron(async () => {
    const subprocess = fakeSubprocess({ exitCode: 0 })
    const prepared = [process.execPath, path.resolve('runner.js'), 'bash.exe', '-c', 'true']
    const execution = startBashExecution({ file: path.resolve('bash.exe'), source: 'bundled', subprocess: subprocess.service,
      env: { ELECTRON_RUN_AS_NODE: '0' }, prepareArgv: async () => prepared }, spec)
    subprocess.settle()
    const value = hostForeground(await execution.result())
    assert.deepEqual(nodeMode(subprocess.specs[0].env), [['ELECTRON_RUN_AS_NODE', '1']])
    assert.equal(value.status, 'completed')
  })
})

// Windows resolves both the executable path and the environment name case-insensitively; the guard inherits
// that. The inherited value here is spelled in lower case AND contradicts ("0"), so the case-folded match has
// to be the thing that fires: it must recognise the existing spelling, replace it, and leave exactly one.
if (process.platform === 'win32') await test('case-folded executable and environment spellings are recognised once', async () => {
  await electron(async () => {
    const subprocess = fakeSubprocess({ exitCode: 0 })
    const prepared = [process.execPath.toUpperCase(), path.resolve('runner.js'), 'bash.exe', '-c', 'true']
    const execution = startBashExecution({ file: path.resolve('bash.exe'), source: 'bundled', subprocess: subprocess.service,
      env: { electron_run_as_node: '0' }, prepareArgv: async () => prepared }, spec)
    subprocess.settle()
    const value = hostForeground(await execution.result())
    assert.deepEqual(subprocess.specs[0].argv, prepared)
    assert.deepEqual(nodeMode(subprocess.specs[0].env), [['ELECTRON_RUN_AS_NODE', '1']])
    assert.equal(value.status, 'completed')
  })
})

await test('a direct call with no prepared argv spawns untouched', async () => {
  await electron(async () => {
    const subprocess = fakeSubprocess({ exitCode: 0 })
    const execution = startBashExecution({ file: path.resolve('bash.exe'), source: 'bundled', subprocess: subprocess.service }, spec)
    subprocess.settle()
    const value = hostForeground(await execution.result())
    // No prepareArgv means no sandbox wrapper, so there is nothing to adapt.
    assert.deepEqual(nodeMode(subprocess.specs[0].env), [], 'a direct call must not have Node mode injected')
    assert.equal(value.status, 'completed')
  })
})

report('shells-electron-runner')
