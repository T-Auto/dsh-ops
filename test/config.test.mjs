/**
 * Configuration: defaults applied, and every rejected value named.
 *
 * The plugin exports no Schemastery schema, so this suite is the whole
 * validation contract: a deployment that misspells a key or types a string
 * where a number belongs must see its own key in the failure.
 */

import { ConfigError, DEFAULT_DENIED_HOST_TOOLS, DEFAULT_SERVER_NAME, DEFAULT_TOOL_CALL_TIMEOUT_MS, FILE_TOOL_ROOTS, resolveConfig } from '../lib/config.js'
import { assert, report, test } from './lib/harness.mjs'

await test('an absent config resolves to the documented defaults', () => {
  for (const raw of [undefined, null, {}]) {
    const config = resolveConfig(raw)
    assert.equal(config.serverName, DEFAULT_SERVER_NAME)
    assert.equal(config.enableShellTools, true)
    assert.equal(config.toolCallTimeoutMs, DEFAULT_TOOL_CALL_TIMEOUT_MS)
    assert.equal(config.required, false)
    assert.equal(config.shellPolicy, 'advise')
    // Where an omitted file-tool `path` resolves from. The default is the
    // calling session's working directory: FastCtx's own default is the process
    // it happens to run in, which is not the session the model is working in.
    assert.equal(config.fileToolRoot, 'session')
    assert.deepEqual(config.deniedHostTools, DEFAULT_DENIED_HOST_TOOLS)
    assert.equal(config.promptPolicy, true)
    assert.equal(config.extraGuidance, '')
    assert.equal(config.binaryPath, undefined)
    // The bash rung's own knobs. There is deliberately no `pwshPath` and no
    // override switch: the bundle patch is evaluated before this row is
    // mounted, so such a key could never reach the host's `pwsh-sandbox` row.
    assert.equal(config.bashPath, undefined)
    assert.equal(config.publishBashTool, true)
    assert.equal(config.allowSystemShellFallback, false)
  }
})

await test('an explicit config overrides every default', () => {
  const config = resolveConfig({
    binaryPath: 'C:\\tools\\fastctx.exe',
    serverName: 'ops-tools',
    enableShellTools: false,
    toolCallTimeoutMs: 1_000,
    required: true,
    shellPolicy: 'deny-host-shell',
    fileToolRoot: 'process',
    deniedHostTools: ['pwsh'],
    promptPolicy: false,
    extraGuidance: 'Never touch the vendored tree.',
    bashPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
    publishBashTool: false,
    allowSystemShellFallback: true,
  })
  assert.equal(config.binaryPath, 'C:\\tools\\fastctx.exe')
  assert.equal(config.serverName, 'ops-tools')
  assert.equal(config.enableShellTools, false)
  assert.equal(config.toolCallTimeoutMs, 1_000)
  assert.equal(config.required, true)
  assert.equal(config.shellPolicy, 'deny-host-shell')
  assert.equal(config.fileToolRoot, 'process')
  assert.deepEqual(config.deniedHostTools, ['pwsh'])
  assert.equal(config.promptPolicy, false)
  assert.equal(config.extraGuidance, 'Never touch the vendored tree.')
  assert.equal(config.bashPath, 'C:\\Program Files\\Git\\bin\\bash.exe')
  assert.equal(config.publishBashTool, false)
  assert.equal(config.allowSystemShellFallback, true)
})

await test('the dropped shell keys stay unknown keys, so a stale config fails loud', () => {
  // These two were advertised for a while and had no effect on the host's pwsh
  // row; a deployment that still sets one must hear about it rather than run a
  // ladder that claims an L3 the host row never runs.
  for (const raw of [{ pwshPath: 'C:\\pwsh.exe' }, { overridePwshExecutor: true }]) {
    const key = Object.keys(raw)[0]
    assert.throws(
      () => resolveConfig(raw),
      (error) => error instanceof ConfigError && error.message.includes(key),
      `expected ${JSON.stringify(raw)} to be rejected naming ${key}`,
    )
  }
})

await test('an unknown key fails loud and names the key', () => {
  assert.throws(
    () => resolveConfig({ disablePowerShell: true }),
    (error) => error instanceof ConfigError && /disablePowerShell/.test(error.message),
  )
})

await test('a wrong-typed value is rejected with its own key', () => {
  for (const [raw, key] of [
    [{ serverName: 7 }, 'serverName'],
    [{ serverName: 'has space' }, 'serverName'],
    [{ binaryPath: '' }, 'binaryPath'],
    [{ enableShellTools: 'yes' }, 'enableShellTools'],
    [{ toolCallTimeoutMs: 0 }, 'toolCallTimeoutMs'],
    [{ toolCallTimeoutMs: -5 }, 'toolCallTimeoutMs'],
    [{ toolCallTimeoutMs: Number.POSITIVE_INFINITY }, 'toolCallTimeoutMs'],
    [{ shellPolicy: 'forbid' }, 'shellPolicy'],
    [{ fileToolRoot: 'cwd' }, 'fileToolRoot'],
    [{ fileToolRoot: 7 }, 'fileToolRoot'],
    [{ fileToolRoot: '' }, 'fileToolRoot'],
    [{ deniedHostTools: 'pwsh' }, 'deniedHostTools'],
    [{ deniedHostTools: [''] }, 'deniedHostTools'],
    [{ extraGuidance: 42 }, 'extraGuidance'],
    [{ bashPath: '' }, 'bashPath'],
    [{ bashPath: 7 }, 'bashPath'],
    [{ publishBashTool: 'yes' }, 'publishBashTool'],
    [{ allowSystemShellFallback: 'no' }, 'allowSystemShellFallback'],
  ]) {
    assert.throws(
      () => resolveConfig(raw),
      (error) => error instanceof ConfigError && error.message.includes(key),
      `expected ${JSON.stringify(raw)} to be rejected naming ${key}`,
    )
  }
})

await test('an unsupported fileToolRoot lists the roots it does accept', () => {
  // The operator reading this failure has to learn the two legal roots from the
  // error itself: the key is new, so "one of ..." is the whole documentation a
  // deployment row gets at the moment it is wrong.
  assert.throws(
    () => resolveConfig({ fileToolRoot: 'cwd' }),
    (error) => error instanceof ConfigError
      && FILE_TOOL_ROOTS.every(root => error.message.includes(JSON.stringify(root))),
    'expected the failure to list every accepted fileToolRoot',
  )
})

await test('a non-object config is rejected', () => {
  for (const raw of ['fastctx', 7, true, []]) {
    assert.throws(() => resolveConfig(raw), ConfigError)
  }
})

report('config')
