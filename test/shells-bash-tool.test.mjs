/**
 * Publishing the `ops_bash` tool: which compositions register it, what the
 * definition looks like to the real registry's schema gate, and what happens
 * when a rung is missing.
 *
 * The registry and subprocess services are recording fakes (see
 * `test/lib/shells-fixtures.mjs`), so these checks pin the publication contract
 * without spawning anything.
 */

import path from 'node:path'
import {
  BASH_TOOL_NAME,
  DEFAULT_BASH_TIMEOUT_MS,
  bashToolDefinition,
  publishShellTools,
  resolveShells,
} from '../lib/shells.js'
import { assert, TEST_HOME, report, test, withTempDir } from './lib/harness.mjs'
import { config, fakeRegistry, fakeSubprocess, makeExecutable } from './lib/shells-fixtures.mjs'

await test('a missing bash publishes nothing and warns instead of failing', async () => {
  await withTempDir('shells-nobash', async (dir) => {
    const warnings = []
    const { ctx, live, registrations } = fakeRegistry()
    ctx.logger = { warn: (message) => warnings.push(message) }
    const publish = config({ allowSystemShellFallback: false })
    // Windows defaults to the complete frozen Niubash tree, not a Git Bash package.
    const shells = resolveShells(publish, {
      bundleRoot: path.join(dir, 'plugin'),
      env: { DSH_HOME: TEST_HOME, PATH: '' },
      platform: 'win32',
      arch: 'x64',
    })
    const dispose = publishShellTools(ctx, publish, shells)

    assert.equal(shells.bash.available, false)
    assert.equal(live.size, 0)
    assert.equal(registrations.length, 0)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /bash is unavailable/)
    assert.ok(warnings[0].includes('Pinned complete Niubash v1.5.0 is missing or unsupported.'), warnings[0])
    assert.ok(warnings[0].includes('Run dsh-ops provision-shells --bash to restore it, or configure an explicit absolute bashPath.'), warnings[0])
    assert.ok(warnings[0].includes('No automatic Git Bash or system shell fallback.'), warnings[0])
    assert.equal(typeof dispose, 'function')
    dispose()
    dispose()
    assert.equal(live.size, 0)
  })
})

await test('publishBashTool:false publishes nothing even when a bash was resolved', async () => {
  await withTempDir('shells-off', async (dir) => {
    const bash = makeExecutable(path.join(dir, 'bash'))
    const { ctx, registrations } = fakeRegistry()
    const publish = config({ bashPath: bash, publishBashTool: false })
    const shells = resolveShells(publish, { bundleRoot: dir, env: { DSH_HOME: TEST_HOME, PATH: '' }, platform: process.platform })
    publishShellTools(ctx, publish, shells)
    assert.equal(registrations.length, 0)
  })
})

await test('no subprocess service means no ops_bash, with a warning', async () => {
  await withTempDir('shells-nosubprocess', async (dir) => {
    // A resolved bash is not enough: without `ctx.subprocess` the tool could be
    // registered and then fail on every call, which would let the ladder
    // advertise rung two for a tool that cannot run.
    const bash = makeExecutable(path.join(dir, 'bash'))
    const warnings = []
    const { ctx, live, registrations } = fakeRegistry({ subprocess: undefined })
    ctx.logger = { warn: (message) => warnings.push(message) }
    const publish = config({ bashPath: bash })
    const shells = resolveShells(publish, { bundleRoot: dir, env: { DSH_HOME: TEST_HOME, PATH: '' }, platform: process.platform })
    assert.equal(shells.bash.available, true, 'the probe still resolves the bash')

    const dispose = publishShellTools(ctx, publish, shells)
    assert.equal(registrations.length, 0)
    assert.equal(live.size, 0)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /no subprocess service/)
    assert.match(warnings[0], /ops_bash is not published/)
    dispose()
  })
})

await test('an available bash registers ops_bash, and the disposer removes it', async () => {
  await withTempDir('shells-register', async (dir) => {
    const bash = makeExecutable(path.join(dir, 'bash'))
    const { service } = fakeSubprocess()
    const { ctx, live, registrations } = fakeRegistry({ subprocess: service })
    const publish = config({ bashPath: bash })
    const shells = resolveShells(publish, { bundleRoot: dir, env: { DSH_HOME: TEST_HOME, PATH: '' }, platform: process.platform })

    const dispose = publishShellTools(ctx, publish, shells)
    assert.equal(registrations.length, 1)
    assert.deepEqual([...live.keys()], [BASH_TOOL_NAME])
    assert.equal(registrations[0].name, BASH_TOOL_NAME)
    assert.ok(registrations[0].parameters.properties.script_path)
    assert.equal(typeof registrations[0].execute, 'function')
    assert.equal(typeof registrations[0].output.render, 'function')

    const text = registrations[0].output.render(
      { command: 'echo hi' },
      {
        exitCode: 0,
        timedOut: false,
        timeoutMs: DEFAULT_BASH_TIMEOUT_MS,
        stdout: { text: 'hi\n', truncated: false },
        stderr: { text: '', truncated: false },
      },
    )
    assert.equal(text[0].text, 'hi\n')

    dispose()
    assert.equal(live.size, 0)
  })
})

await test('the ops_bash definition passes the real registry\'s schema gate', async () => {
  // The fake registry used above does not validate anything, which is exactly
  // how a type-array schema (`['integer', 'null']`) once shipped and then made
  // the real registry refuse the registration with
  // "type arrays are not supported"
  // (packages/core/tools/src/json-schema.ts:302-307). This check runs the
  // harness's own validator, so the definition cannot drift back.
  const { assertSupportedJsonSchema } = await import('@deepseek-ai/dsh-tools')
  await withTempDir('shells-schema', async (dir) => {
    const bash = makeExecutable(path.join(dir, 'bash'))
    const { service } = fakeSubprocess()
    const definition = bashToolDefinition({ file: bash, source: 'config', subprocess: service })

    assert.equal(typeof assertSupportedJsonSchema, 'function')
    assert.doesNotThrow(() => assertSupportedJsonSchema(definition.output.schema))
  })
})

await test('no part of the ops_bash definition declares a type array', async () => {
  // An equivalent structural check that does not depend on the host package,
  // walking `output` AND `parameters`, so the same mistake cannot reappear in
  // the argument schema either.
  await withTempDir('shells-schema-walk', async (dir) => {
    const bash = makeExecutable(path.join(dir, 'bash'))
    const { service } = fakeSubprocess()
    const definition = bashToolDefinition({ file: bash, source: 'config', subprocess: service })

    /** @type {string[]} */
    const offenders = []
    /**
     * @param {unknown} node - the schema node to walk.
     * @param {string} where - its path, for the failure message.
     * @returns {void}
     */
    const walk = (node, where) => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) {
        node.forEach((entry, index) => walk(entry, `${where}[${index}]`))
        return
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === 'type' && Array.isArray(value)) offenders.push(`${where}.type`)
        else walk(value, `${where}.${key}`)
      }
    }
    walk(definition.output.schema, 'output.schema')
    walk(definition.parameters, 'parameters')
    assert.deepEqual(offenders, [])
  })
})

report('shells-bash-tool')
