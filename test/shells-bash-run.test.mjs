/**
 * The command `ops_bash` actually runs: the spawn spec it hands
 * `ctx.subprocess`, the argument guard, the workdir and `script_path`
 * validation, and the remedy each missing-executable source gets.
 *
 * `fakeSubprocess` (see `test/lib/shells-fixtures.mjs`) records the spec and
 * settles it on demand, so every case asserts what would have been executed
 * rather than executing it.
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  BASH_ARGUMENTS,
  DEFAULT_BASH_TIMEOUT_MS,
  shellEnvOverrides,
  MAX_BASH_TIMEOUT_MS,
  bashToolDefinition,
  bashToolDescription,
  resolveShells,
  withBashStatus,
} from '../lib/shells.js'
import { sessionWorkdir } from '../lib/session-shells.js'
import { assert, TEST_HOME, report, test, withTempDir } from './lib/harness.mjs'
import { config, fakeSubprocess, makeExecutable } from './lib/shells-fixtures.mjs'

await test('ops_bash runs the resolved bash as `bash -c <command>` through ctx.subprocess', async () => {
  await withTempDir('shells-exec', async (dir) => {
    const bash = makeExecutable(path.join(dir, 'plugin-bash'))
    const { service, specs, settle } = fakeSubprocess({ exitCode: 3, stdout: 'out\n', stderr: 'err\n' })
    const publish = config({ bashPath: bash })
    const shells = resolveShells(publish, { bundleRoot: dir, env: { DSH_HOME: TEST_HOME, PATH: '' }, platform: process.platform })
    const definition = bashToolDefinition({ file: shells.bash.file, source: shells.bash.source, subprocess: service })

    const controller = new AbortController()
    const spec = { cwd: dir }
    const running = definition.execute(
      { command: 'echo $BASH_VERSION', workdir: spec.cwd, timeoutMs: 5_000, graceMs: 250 },
      { signal: controller.signal },
    )
    settle()
    const value = await running

    assert.equal(specs.length, 1)
    const [spawned] = specs
    assert.deepEqual(spawned.argv, [bash, '-c', 'echo $BASH_VERSION'])
    assert.equal(spawned.cwd, dir)
    assert.equal(spawned.graceMs, 250)
    assert.equal(spawned.signal.aborted, false)
    // The spawn env is the overrides as they must reach a child given THIS host environment: a
    // host that sets `LC_ALL` gets it neutralized (see the locale case below).
    assert.deepEqual(spawned.env, shellEnvOverrides(process.env))
    assert.deepEqual(spawned.stdio.stdin, { data: '' })
    assert.equal(typeof spawned.stdio.stdout.maxBytes, 'number')
    assert.equal(typeof spawned.stdio.stderr.maxBytes, 'number')
    assert.equal(spawned.stdio.stdout.spill.maxBytes, spawned.stdio.stderr.spill.maxBytes)

    // A normal exit reports its code and OMITS `signal`: the canonical value
    // never carries a null, because the output schema declares single types.
    assert.deepEqual(value, {
      exitCode: 3,
      status: 'failed',
      timedOut: false,
      timeoutMs: 5_000,
      stdout: { text: 'out\n', truncated: false },
      stderr: { text: 'err\n', truncated: false },
    })
    assert.equal(Object.hasOwn(value, 'signal'), false)
    const rendered = definition.output.render({}, value)
    assert.equal(rendered[0].text, 'out\n[stderr]\nerr\n\n[exit code: 3]')
  })
})

await test('ops_bash diagnostics are opt-in and cancellation before spawn has no effect', async () => {
  const { service, specs, settle } = fakeSubprocess({ stdout: 'out\n' })
  const definition = bashToolDefinition({ file: process.execPath, source: 'config', subprocess: service })
  const running = definition.execute({ command: 'true', includeDiagnostics: true }, {})
  settle()
  const value = await running
  assert.equal(value.stdout.bytes, 4)
  assert.equal(value.stdout.bytesTotal, 4)
  assert.equal(value.stdout.lines, 1)
  assert.equal(value.diagnostics.executor.kind, 'subprocess')
  assert.ok(value.diagnostics.durationMs >= 0)
  const controller = new AbortController()
  controller.abort(new Error('cancel fixture'))
  const cancelled = await definition.execute({ command: 'true' }, { signal: controller.signal })
  assert.equal(cancelled.status, 'failed')
  assert.equal(cancelled.cancelled, true)
  assert.equal(Object.hasOwn(cancelled, 'diagnostics'), false)
  assert.equal(specs.length, 1)
  await assert.rejects(() => definition.execute({ command: 'true', includeDiagnostics: 'yes' }, {}), /includeDiagnostics/)
})

await test('ops_bash reports a signal death with a signal and no exit code', async () => {
  await withTempDir('shells-signal', async (dir) => {
    const bash = makeExecutable(path.join(dir, 'bash'))
    const { service, settle } = fakeSubprocess({ exitCode: null, signal: 'SIGTERM', stdout: '', stderr: '' })
    const definition = bashToolDefinition({ file: bash, source: 'config', subprocess: service })
    const running = definition.execute({ command: 'sleep 99' }, { signal: new AbortController().signal })
    settle()
    const value = await running

    assert.deepEqual(value, {
      signal: 'SIGTERM',
      status: 'failed',
      timedOut: false,
      timeoutMs: DEFAULT_BASH_TIMEOUT_MS,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
    })
    assert.equal(Object.hasOwn(value, 'exitCode'), false)
    assert.equal(definition.output.render({}, value)[0].text, '(no output)\n[signal: SIGTERM]')
  })
})

await test('ops_bash results carry status: completed only for a clean zero exit (#44)', async () => {
  await withTempDir('shells-status', async (dir) => {
    const bash = makeExecutable(path.join(dir, 'bash'))
    const run = async (outcome, args = { command: 'true' }) => {
      const { service, settle } = fakeSubprocess(outcome)
      const running = bashToolDefinition({ file: bash, source: 'config', subprocess: service }).execute(args, { signal: new AbortController().signal })
      settle()
      return running
    }
    assert.equal((await run({ exitCode: 0, stdout: 'ok' })).status, 'completed')
    assert.equal((await run({ exitCode: 1 })).status, 'failed')
    assert.equal((await run({ exitCode: null, signal: 'SIGKILL' })).status, 'failed')
    const broken = { spawn() { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) } }
    const spawnError = await bashToolDefinition({ file: bash, source: 'config', subprocess: broken }).execute({ command: 'true' }, {})
    assert.equal(spawnError.status, 'failed')
    assert.match(spawnError.error, /ENOENT/)
    // Stamping after a wrapper adds error/permission always yields failed.
    assert.equal(withBashStatus({ exitCode: 0, timedOut: false, error: 'EXECUTOR_UNAVAILABLE' }).status, 'failed')
    assert.equal(withBashStatus({ exitCode: 0, timedOut: false, permission: {} }).status, 'failed')
    assert.equal(withBashStatus({ exitCode: 0, timedOut: true }).status, 'failed')
    // Argument errors still throw, so the host reports them as a failed tool call.
    await assert.rejects(() => run({ exitCode: 0 }, { command: 'true', bogus: 1 }), /unknown key "bogus"/)
  })
})

await test('ops_bash forwards the terminal overrides and no credential-shaped name of its own', async () => {
  await withTempDir('shells-env', async (dir) => {
    const bash = makeExecutable(path.join(dir, 'bash'))
    const { service, specs, settle } = fakeSubprocess()
    const definition = bashToolDefinition({ file: bash, source: 'config', subprocess: service })
    const running = definition.execute({ command: 'true' }, { signal: new AbortController().signal })
    settle()
    await running

    const env = specs[0].env
    assert.deepEqual(env, shellEnvOverrides(process.env))
    assert.equal(env.NO_COLOR, '1')
    assert.equal(env.TERM, 'dumb')
    assert.equal(env.PAGER, 'cat')
    assert.equal(env.GIT_PAGER, 'cat')
    // Message catalogs are pinned so the host's English `denialSignatures` still
    // match a localized libc; `LC_ALL=C` would break UTF-8 I/O instead.
    assert.equal(env.LC_MESSAGES, 'C')
    for (const name of Object.keys(env)) {
      assert.equal(/KEY|PASSWORD|SECRET|TOKEN/i.test(name), false, `${name} looks like a credential`)
      assert.equal(name.toUpperCase().startsWith('DSH_'), false, `${name} is a harness fact`)
    }
  })
})

await test('ops_bash executes a script_path without embedding its contents in argv', async () => {
  await withTempDir('shells-script-path', async (dir) => {
    const bash = makeExecutable(path.join(dir, 'bash'))
    const script = path.join(dir, 'long-script.sh')
    makeExecutable(script)
    const { service, specs, settle } = fakeSubprocess()
    const definition = bashToolDefinition({ file: bash, source: 'config', subprocess: service })
    const running = definition.execute({ script_path: script, workdir: dir }, { signal: new AbortController().signal })
    settle()
    await running

    assert.deepEqual(specs[0].argv, [bash, script])
    assert.equal(specs[0].cwd, dir)
    assert.deepEqual(specs[0].stdio.stdin, { data: '' })
  })
})

await test('ops_bash rejects a missing or non-directory workdir before spawning', async () => {
  await withTempDir('shells-workdir', async (dir) => {
    const bash = makeExecutable(path.join(dir, 'bash'))
    const file = path.join(dir, 'a-file')
    fs.writeFileSync(file, 'placeholder')
    // The service records any spawn: a rejected workdir must never reach it,
    // or the failure would come back as the misleading missing-payload ENOENT.
    const { service, specs } = fakeSubprocess()
    const definition = bashToolDefinition({ file: bash, source: 'bundled', subprocess: service })
    const exec = { signal: new AbortController().signal }
    const missing = path.join(dir, 'definitely-missing')

    await assert.rejects(
      () => definition.execute({ command: 'echo hi', workdir: missing }, exec),
      { message: `invalid workdir: must be an existing directory, got ${missing}` })
    await assert.rejects(
      () => definition.execute({ command: 'echo hi', workdir: file }, exec),
      { message: `invalid workdir: must be an existing directory, got ${file}` })
    assert.equal(specs.length, 0)
  })
})

await test('ops_bash rejects an empty workdir string instead of spawning it', async () => {
  const { service, specs } = fakeSubprocess()
  const definition = bashToolDefinition({ file: 'bash', source: 'config', subprocess: service })
  const exec = { signal: new AbortController().signal }
  // Placeholder strings are the session layer's job (sessionWorkdir resolves
  // them to the session directory); a string that reaches the executor is a
  // chosen path, and "" names no directory.
  for (const workdir of ['', '   ']) {
    await assert.rejects(
      () => definition.execute({ command: 'echo hi', workdir }, exec),
      /invalid workdir: must be an existing directory/)
  }
  assert.equal(specs.length, 0)
})

await test('sessionWorkdir resolves placeholders to the session directory', async () => {
  const session = { header: { cwd: 'C:\\session\\cwd' } }
  assert.equal(sessionWorkdir({}, session), 'C:\\session\\cwd')
  assert.equal(sessionWorkdir({ workdir: undefined }, session), 'C:\\session\\cwd')
  assert.equal(sessionWorkdir({ workdir: null }, session), 'C:\\session\\cwd')
  assert.equal(sessionWorkdir({ workdir: '' }, session), 'C:\\session\\cwd')
  assert.equal(sessionWorkdir({ workdir: '   ' }, session), 'C:\\session\\cwd')
  assert.equal(sessionWorkdir({ workdir: 'D:\\chosen' }, session), 'D:\\chosen')
  // A relative path is anchored at the session workspace -- the spaces here are
  // filename bytes, not padding -- and a non-string is not silently coerced to
  // the default; the executor rejects it. The full resolution matrix, including
  // the Windows drive rules, lives in test/shells-guards.test.mjs.
  assert.equal(sessionWorkdir({ workdir: '  D:\\chosen  ' }, session), 'C:\\session\\cwd\\  D:\\chosen  ')
  assert.equal(sessionWorkdir({ workdir: 5 }, session), 5)
})

await test('ops_bash turns a missing executable into the remedy its source deserves', async () => {
  const spawnError = Object.assign(new Error('spawn missing bash'), { code: 'ENOENT' })
  const service = { spawn() { throw spawnError } }
  /**
   * Run one ENOENT spawn through a tool bound to `source`.
   * @param {string} source - the rung the executable came from.
   * @returns {Promise<{value: object, definition: object}>} the settled result.
   */
  const runFor = async (source) => {
    const definition = bashToolDefinition({ file: 'C:\\missing\\bash.exe', source, subprocess: service })
    const value = await definition.execute({ command: 'echo hi' }, { signal: new AbortController().signal })
    return { value, definition }
  }
  const head = 'bash executable is unavailable (ENOENT): C:\\missing\\bash.exe. '

  // AC-3: each source is told what would actually restore that copy. The old
  // single line sent all of them to "repair the profile installation", which is
  // the wrong move for a configured path and for a system bash.
  const bundled = await runFor('bundled')
  assert.equal(bundled.value.error, `${head}The bundled bash left the profile after it was resolved; restore the profile's dependencies, or run \`dsh-ops provision-shells --bash\` to fetch the pinned copy from upstream releases instead.`)
  assert.equal(bundled.value.timedOut, false)
  assert.deepEqual(bundled.value.stdout, { text: '', truncated: false })
  assert.deepEqual(bundled.value.stderr, { text: '', truncated: false })
  assert.match(bundled.definition.output.render({}, bundled.value)[0].text, /The bundled bash left the profile after it was resolved/)

  const provisioned = await runFor('provisioned')
  assert.equal(provisioned.value.error, `${head}The provisioned copy under this DSH_HOME is gone; run \`dsh-ops provision-shells --bash\` again to reinstall the pinned upstream copy.`)

  const config = await runFor('config')
  assert.equal(config.value.error, `${head}The configured bashPath no longer exists; point bashPath at a real executable, or clear it and run \`dsh-ops provision-shells --bash\`.`)

  const errors = [bundled.value.error, provisioned.value.error, config.value.error]
  assert.equal(new Set(errors).size, 3, 'one wording per source')
  for (const error of errors) {
    assert.equal(/repair the profile installation/u.test(error), false, error)
  }

  // The two system sources share the one remedy that cannot be a registry
  // fetch, and a source this table has never seen still gets a usable line
  // rather than nothing (D8).
  const system = 'The system bash this deployment fell back to is gone; reinstall it, or run `dsh-ops provision-shells --bash` for a copy the registry cannot take away.'
  for (const source of ['path', 'well-known']) {
    assert.equal((await runFor(source)).value.error, `${head}${system}`, `${source}: the system bash remedy`)
  }
  assert.equal(
    (await runFor('a-source-added-later')).value.error,
    `${head}run \`dsh-ops provision-shells --bash\` to install the pinned upstream copy.`,
    'an unmapped source still gets the generic remedy',
  )
})

await test('ops_bash requires exactly one command input', async () => {
  await withTempDir('shells-inputs', async (dir) => {
    const bash = makeExecutable(path.join(dir, 'bash'))
    const { service, specs } = fakeSubprocess()
    const definition = bashToolDefinition({ file: bash, source: 'config', subprocess: service })
    const exec = { signal: new AbortController().signal }

    await assert.rejects(() => definition.execute({}, exec), /exactly one of command or script_path/)
    await assert.rejects(() => definition.execute({ command: 'echo ok', script_path: 'x.sh' }, exec), /exactly one of command or script_path/)
    await assert.rejects(() => definition.execute({ script_path: '   ' }, exec), /invalid script_path/)
    assert.equal(specs.length, 0)
  })
})

await test('ops_bash accepts empty optional input placeholders without discarding real inputs', async () => {
  for (const placeholder of ['', '   ', null, undefined]) {
    for (const script of [false, true]) {
      const { service, specs, settle } = fakeSubprocess({ stdout: 'ok\n' })
      settle()
      const definition = bashToolDefinition({ file: 'bash', source: 'config', subprocess: service })
      const args = script ? { command: placeholder, script_path: 'test.sh' }
        : { command: 'echo ok', script_path: placeholder }
      const value = await definition.execute(args)
      assert.equal(value.error, undefined)
      assert.deepEqual(specs[0].argv, script ? ['bash', 'test.sh'] : ['bash', '-c', 'echo ok'])
    }
  }
  const { service, specs, settle } = fakeSubprocess()
  settle()
  const definition = bashToolDefinition({ file: 'bash', source: 'config', subprocess: service })
  for (const args of [
    { command: 'echo ok', script_path: '/dev/null' },
    { command: 'echo ok', script_path: 123 },
    { command: false, script_path: 'test.sh' },
    { command: '', script_path: '' },
    { command: null, script_path: null },
  ]) await assert.rejects(() => definition.execute(args), /invalid/)
  assert.equal(specs.length, 0)
})

await test('ops_bash rejects a missing command and a bad timeout before spawning', async () => {
  await withTempDir('shells-args', async (dir) => {
    const bash = makeExecutable(path.join(dir, 'bash'))
    const { service, specs } = fakeSubprocess()
    const definition = bashToolDefinition({ file: bash, source: 'config', subprocess: service })
    const exec = { signal: new AbortController().signal }

    await assert.rejects(() => definition.execute({}, exec), /exactly one of command or script_path/)
    await assert.rejects(() => definition.execute({ command: '   ' }, exec), /invalid command/)
    await assert.rejects(() => definition.execute({ command: 'ls', timeoutMs: 0 }, exec), /invalid timeoutMs/)
    await assert.rejects(
      () => definition.execute({ command: 'ls', timeoutMs: MAX_BASH_TIMEOUT_MS + 1 }, exec),
      /no greater than/,
    )
    await assert.rejects(() => definition.execute({ command: 'ls', graceMs: -1 }, exec), /invalid graceMs/)
    assert.equal(specs.length, 0)
  })
})

await test('ops_bash refuses an argument its schema does not declare', async () => {
  // The host validates a `defineTool` body's arguments before it runs, but
  // `ctx.tools.register` — the path this plugin uses to avoid an
  // `@deepseek-ai/*` value import — validates only `output.schema`. Arguments
  // therefore reach `execute` verbatim, and reading known fields with `args?.x`
  // drops an undeclared key silently. `run_in_background` is the case that
  // hurts: the host's own bash/pwsh tools accept it, so a model that expects a
  // job id gets a foreground call that occupies the whole `timeoutMs`.
  await withTempDir('shells-unknown-args', async (dir) => {
    const bash = makeExecutable(path.join(dir, 'bash'))
    const { service, specs, settle } = fakeSubprocess()
    // Settle up front: if the guard were missing, the call would otherwise hang
    // on this fake forever and the suite would die of an unsettled await instead
    // of reporting which assertion failed.
    settle()
    const definition = bashToolDefinition({ file: bash, source: 'config', subprocess: service })
    const exec = { signal: new AbortController().signal }

    await assert.rejects(
      () => definition.execute({ command: 'node server.js', run_in_background: true }, exec),
      /unknown key "run_in_background"/,
    )
    // The refusal names what IS accepted, so a retry does not need a second guess.
    await assert.rejects(
      () => definition.execute({ command: 'ls', run_in_background: true }, exec),
      new RegExp(BASH_ARGUMENTS.join(', ')),
    )
    // Several unknown keys are reported together, in argument order.
    await assert.rejects(
      () => definition.execute({ command: 'ls', bogus: 1, other: 2 }, exec),
      /unknown keys "bogus", "other"/,
    )
    // Host-style per-call escalation is named as unsupported, with the real next step (#42).
    await assert.rejects(
      () => definition.execute({ command: 'ls', sandbox_permissions: 'danger-full-access', justification: 'x' }, exec),
      /unknown keys "sandbox_permissions", "justification".*no per-call sandbox escalation; ask the user to change the session permission mode/,
    )
    await assert.rejects(
      () => definition.execute({ command: 'ls', bogus: 1 }, exec),
      (error) => !/sandbox escalation/.test(error.message),
    )
    // A non-object body is refused for the same reason, not coerced.
    await assert.rejects(() => definition.execute([], exec), /expected an object/)
    // Nothing reached the subprocess service: the guard runs before the spawn.
    assert.equal(specs.length, 0)

    // Every declared argument still passes, and each reaches the spawn spec.
    const { service: ok, specs: okSpecs, settle: settleOk } = fakeSubprocess({ stdout: 'ok\n' })
    const passing = bashToolDefinition({ file: bash, source: 'config', subprocess: ok })
    const running = passing.execute(
      { command: 'echo hi', workdir: dir, timeoutMs: 5_000, graceMs: 250 },
      { signal: new AbortController().signal },
    )
    settleOk()
    await running
    assert.equal(okSpecs.length, 1)
    assert.equal(okSpecs[0].cwd, dir)
    assert.equal(okSpecs[0].graceMs, 250)
  })
})

await test('the ops_bash argument guard and its schema cannot drift apart', async () => {
  // `BASH_ARGUMENTS` is what `execute` enforces; `parameters.properties` is what
  // the model is told. A name in one but not the other would either refuse a
  // documented argument or silently accept an undeclared one.
  await withTempDir('shells-args-drift', async (dir) => {
    const bash = makeExecutable(path.join(dir, 'bash'))
    const { service } = fakeSubprocess()
    const definition = bashToolDefinition({ file: bash, source: 'config', subprocess: service })

    assert.deepEqual(Object.keys(definition.parameters.properties), [...BASH_ARGUMENTS])
    assert.equal(definition.parameters.additionalProperties, false)
    // Neither input is `required`: exactly one of command/script_path must be
    // present, which a JSON Schema `required` list cannot express. The guard
    // deliberately does not add a required-check the schema does not state.
    assert.equal(Object.hasOwn(definition.parameters, 'required'), false)
  })
})

await test('the ops_bash description says the tool has no background mode', async () => {
  // The prompt is the reliable correction channel: a model that has learned
  // "shell tools can run in the background" from the host's pwsh tool must be
  // told otherwise where it will read it.
  const description = bashToolDescription()
  assert.match(description, /Foreground only/)
  assert.match(description, /no run_in_background/)
  assert.match(description, /pwsh/)
})

// A definition whose subprocess service is missing cannot exist in a real
// deployment: `publishShellTools` refuses to register one (see
// test/shells-bash-tool.test.mjs), so there is deliberately no "the tool throws
// when the service is gone" case to pin — the registration gate is the contract.

report('shells-bash-run')
