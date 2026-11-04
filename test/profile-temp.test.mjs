import fs from 'node:fs'
import path from 'node:path'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { profileCommand } from '../lib/profile-install.js'
import { ensureSessionTemp, sessionTempDir } from '../lib/session-temp.js'

const capture = body => {
  const messages = [], previous = console.log
  console.log = value => messages.push(String(value))
  try { return { status: body(), messages } } finally { console.log = previous }
}
async function profileFixture(body) {
  await withTempDir('profile-delegate', async root => {
    const previous = { home: process.env.DSH_HOME, cli: process.env.DSH_OPS_DSH_CLI, spec: process.env.DSH_OPS_INSTALL_SPEC, exit: process.env.PROFILE_TEST_EXIT }
    process.env.DSH_HOME = root; delete process.env.DSH_OPS_DSH_CLI; delete process.env.DSH_OPS_INSTALL_SPEC
    const directory = path.join(root, 'profiles', 'dsh-tui'), receipt = path.join(root, 'invoked.json')
    fs.mkdirSync(directory, { recursive: true })
    const manifest = path.join(directory, 'package.json')
    fs.writeFileSync(manifest, JSON.stringify({ dependencies: { 'dsh-ops': '^0.3.1' }, dsh: { profile: { bundles: ['dsh-ops'] } } }))
    const cli = path.join(directory, 'node_modules', '@deepseek-ai', 'dsh'); fs.mkdirSync(cli, { recursive: true })
    fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', type: 'module', bin: { dsh: './cli.mjs' } }))
    const entry = path.join(cli, 'cli.mjs')
    fs.writeFileSync(entry, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify(process.argv.slice(2)));process.exit(Number(process.env.PROFILE_TEST_EXIT ?? 0))`)
    try { await body({ root, manifest, receipt, entry }) } finally {
      for (const [key, value] of [['DSH_HOME', previous.home], ['DSH_OPS_DSH_CLI', previous.cli], ['DSH_OPS_INSTALL_SPEC', previous.spec], ['PROFILE_TEST_EXIT', previous.exit]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value
      }
    }
  })
}
function withEnv(values, body) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    return body()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }
}
function launcher(file, entry) {
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, process.platform === 'win32'
    ? `@"${process.execPath}" "${entry}" %*\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(entry)} "$@"\n`)
  fs.chmodSync(file, 0o755)
  return file
}
const launcherName = process.platform === 'win32' ? 'profile-fixture.cmd' : 'profile-fixture'
function refusal(operation, options) {
  let error
  try { capture(() => profileCommand(operation, options)) } catch (caught) { error = caught }
  assert.ok(error instanceof Error, 'an unusable CLI must be refused before invocation')
  return error.message
}
await test('profile status and dry-run preserve the tui alias and never execute the official CLI', async () => {
  await profileFixture(({ receipt }) => {
    const status = capture(() => profileCommand('status', { profile: 'tui' }))
    assert.equal(status.status, 0)
    const value = JSON.parse(status.messages[0]); assert.equal(value.profile, 'dsh-tui'); assert.equal(value.enabled, true); assert.equal(value.dependency, '^0.3.1')
    assert.equal(capture(() => profileCommand('install', { profile: 'tui', dryRun: true })).status, 0)
    assert.equal(fs.existsSync(receipt), false)
    assert.throws(() => profileCommand('install', { profile: '../outside' }), /Explicit --profile/)
  })
})
await test('profile mutations delegate exact arguments and propagate official CLI failure without local rollback logic', async () => {
  await profileFixture(({ receipt, manifest }) => {
    const before = fs.readFileSync(manifest, 'utf8'); process.env.DSH_OPS_INSTALL_SPEC = 'dsh-ops@0.4.0-test'
    assert.equal(capture(() => profileCommand('install', { profile: 'tui' })).status, 0)
    assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')), ['plugin', '--profile', 'dsh-tui', 'add', 'dsh-ops@0.4.0-test'])
    process.env.PROFILE_TEST_EXIT = '17'
    assert.equal(capture(() => profileCommand('uninstall', { profile: 'dsh-tui' })).status, 17)
    assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')), ['plugin', '--profile', 'dsh-tui', 'remove', 'dsh-ops'])
    assert.equal(fs.readFileSync(manifest, 'utf8'), before)
  })
})
await test('dry-run and execution reject the same missing CLI paths and directories', async () => {
  await profileFixture(({ root, receipt }) => {
    for (const dshCli of [path.join(root, 'missing', launcherName), root]) {
      for (const operation of ['install', 'uninstall']) {
        const preview = refusal(operation, { profile: 'tui', dshCli, dryRun: true })
        assert.match(preview, /CLI/)
        assert.equal(refusal(operation, { profile: 'tui', dshCli }), preview)
      }
    }
    assert.equal(fs.existsSync(receipt), false)
  })
})
await test('missing bare CLI names are refused against PATH, including environment overrides', async () => {
  await profileFixture(({ root, receipt }) => withEnv({ PATH: root, DSH_OPS_DSH_CLI: 'dsh-ops-missing-cli' }, () => {
    const preview = refusal('install', { profile: 'tui', dryRun: true })
    assert.match(preview, /CLI.*dsh-ops-missing-cli/)
    assert.equal(refusal('install', { profile: 'tui' }), preview)
    assert.equal(fs.existsSync(receipt), false)
  }))
})
await test('absolute and relative script launchers with spaces survive preflight without dry-run execution', async () => {
  await profileFixture(({ root, entry, receipt }) => {
    const file = launcher(path.join(root, 'CLI with spaces', launcherName), entry)
    for (const dshCli of [file, path.relative(process.cwd(), file)]) {
      assert.equal(capture(() => profileCommand('install', { profile: 'tui', dshCli, dryRun: true })).status, 0)
      assert.equal(fs.existsSync(receipt), false)
      assert.equal(capture(() => profileCommand('uninstall', { profile: 'tui', dshCli })).status, 0)
      assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')), ['plugin', '--profile', 'dsh-tui', 'remove', 'dsh-ops'])
      fs.unlinkSync(receipt)
    }
  })
})
await test('bare CLI lookup preserves PATH launchers and never probes them by executing', async () => {
  await profileFixture(({ root, entry, receipt }) => {
    const directory = path.join(root, 'PATH with spaces')
    launcher(path.join(directory, launcherName), entry)
    withEnv({ PATH: directory, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, () => {
      assert.equal(capture(() => profileCommand('install', { profile: 'tui', dshCli: 'profile-fixture', dryRun: true })).status, 0)
      assert.equal(fs.existsSync(receipt), false)
      assert.equal(capture(() => profileCommand('uninstall', { profile: 'tui', dshCli: 'profile-fixture' })).status, 0)
      assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')), ['plugin', '--profile', 'dsh-tui', 'remove', 'dsh-ops'])
    })
  })
})
await test('an inferred Node CLI entry must remain a readable file, not an executable', async () => {
  await profileFixture(({ entry, receipt }) => {
    fs.chmodSync(entry, 0o644)
    assert.equal(capture(() => profileCommand('install', { profile: 'tui', dryRun: true })).status, 0)
    assert.equal(fs.existsSync(receipt), false)
    fs.unlinkSync(entry)
    const missing = refusal('install', { profile: 'tui', dryRun: true })
    assert.match(missing, /CLI.*cli\.mjs/)
    assert.equal(refusal('install', { profile: 'tui' }), missing)
    fs.mkdirSync(entry)
    const directory = refusal('uninstall', { profile: 'tui', dryRun: true })
    assert.match(directory, /CLI.*cli\.mjs/)
    assert.equal(refusal('uninstall', { profile: 'tui' }), directory)
    assert.equal(fs.existsSync(receipt), false)
  })
})
if (process.platform !== 'win32') await test('POSIX preflight rejects non-executables but follows usable launcher symlinks', async () => {
  await profileFixture(({ root, entry, receipt }) => {
    const file = launcher(path.join(root, launcherName), entry)
    fs.chmodSync(file, 0o644)
    const preview = refusal('install', { profile: 'tui', dshCli: file, dryRun: true })
    assert.match(preview, /CLI/)
    assert.equal(refusal('install', { profile: 'tui', dshCli: file }), preview)
    fs.chmodSync(file, 0o755)
    const link = path.join(root, 'linked-cli')
    fs.symlinkSync(file, link)
    assert.equal(capture(() => profileCommand('install', { profile: 'tui', dshCli: link, dryRun: true })).status, 0)
    assert.equal(fs.existsSync(receipt), false)
    assert.equal(capture(() => profileCommand('uninstall', { profile: 'tui', dshCli: link })).status, 0)
    assert.ok(fs.existsSync(receipt))
  })
})
else console.log('  POSIX CLI fixture unavailable: executable mode checks require POSIX')
if (process.platform === 'win32') await test('Windows cmd path checks apply before dry-run and PATHEXT keeps batch launchers', async () => {
  await profileFixture(({ root, entry, receipt }) => {
    const unsafe = launcher(path.join(root, 'unsafe&cli.cmd'), entry)
    const preview = refusal('install', { profile: 'tui', dshCli: unsafe, dryRun: true })
    assert.match(preview, /Unsafe CLI path/)
    assert.equal(refusal('install', { profile: 'tui', dshCli: unsafe }), preview)
    const directory = path.join(root, 'batch bin')
    launcher(path.join(directory, 'profile-fixture.BAT'), entry)
    const extensionless = path.join(directory, 'profile-fixture')
    fs.writeFileSync(extensionless, '#!/bin/sh\nnot a Windows launcher\n')
    withEnv({ PATH: `"${directory}"`, PATHEXT: '.BAT;.CMD;.EXE' }, () => {
      // npm-style bin directories can contain a POSIX shim beside their Windows wrapper.
      for (const dshCli of ['profile-fixture', extensionless]) {
        assert.equal(capture(() => profileCommand('install', { profile: 'tui', dshCli, dryRun: true })).status, 0)
        assert.equal(fs.existsSync(receipt), false)
        assert.equal(capture(() => profileCommand('uninstall', { profile: 'tui', dshCli })).status, 0)
        assert.ok(fs.existsSync(receipt))
        fs.unlinkSync(receipt)
      }
    })
  })
})
else console.log('  Windows CLI fixture unavailable: cmd.exe and PATHEXT execution require Windows')
await test('malformed profile manifest data fails before CLI invocation', async () => {
  await profileFixture(({ manifest, receipt }) => {
    fs.writeFileSync(manifest, 'null')
    assert.throws(() => profileCommand('status', { profile: 'tui' }), /Invalid package manifest/)
    fs.writeFileSync(manifest, JSON.stringify({ dsh: { profile: { bundles: 12 } } }))
    assert.throws(() => profileCommand('status', { profile: 'tui' }), /Invalid profile bundles/)
    assert.equal(fs.existsSync(receipt), false)
  })
})
await test('session temp identity is stable, isolated, idempotent and refuses file or link targets', async () => {
  await withTempDir('session-temp-types', async root => {
    const first = sessionTempDir('session-a', root), second = sessionTempDir('session-b', root)
    assert.equal(first, sessionTempDir('session-a', root)); assert.notEqual(first, second)
    assert.deepEqual(ensureSessionTemp(first), { ok: true }); assert.deepEqual(ensureSessionTemp(first), { ok: true })
    fs.writeFileSync(second, 'KEEP'); const failed = ensureSessionTemp(second)
    assert.equal(failed.ok, false); assert.match(failed.message, /could not create/); assert.equal(fs.readFileSync(second, 'utf8'), 'KEEP')
    const alias = path.join(root, 'alias'); fs.symlinkSync(first, alias, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(ensureSessionTemp(alias).ok, false)
    if (process.platform !== 'win32') assert.equal(fs.statSync(first).mode & 0o777, 0o700)
  })
})
await test('a launcher path carrying a caret is refused, while a caret in the spec is not', async () => {
  // The two guards differ by exactly one character: `preflightCli` refuses `^` in a launcher path,
  // `quoteCliArg` keeps it for install specs, where it is a version range. Pinning both sides is
  // what makes that difference deliberate rather than a drift.
  await profileFixture(({ root, entry, receipt }) => {
    const caretPath = launcher(path.join(root, 'CLI with ^ caret', launcherName), entry)
    process.env.DSH_OPS_INSTALL_SPEC = 'dsh-ops@^1.0.0'
    if (process.platform === 'win32') {
      assert.throws(() => capture(() => profileCommand('install', { profile: 'tui', dshCli: caretPath })),
        /Unsafe CLI path/, 'a launcher path with ^ must be refused before anything runs')
      assert.equal(fs.existsSync(receipt), false)
    } else {
      assert.equal(capture(() => profileCommand('install', { profile: 'tui', dshCli: caretPath })).status, 0)
    }
    const plain = launcher(path.join(root, 'CLI plain', launcherName), entry)
    assert.equal(capture(() => profileCommand('install', { profile: 'tui', dshCli: plain })).status, 0)
    assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')), ['plugin', '--profile', 'dsh-tui', 'add', 'dsh-ops@^1.0.0'],
      'the same caret stays literal in the spec')
  })
})
await test('the launcher receives an install spec verbatim, and the cmd line refuses what it cannot carry', async () => {
  // A `.cmd` launcher is reached through `cmd /d /s /c` with `windowsVerbatimArguments`, so the
  // spec is a command-line fragment unless it is quoted. These four are legal npm specs whose
  // characters (`^ ~ # +` and a space) must survive unchanged.
  await profileFixture(({ root, entry, receipt }) => {
    const file = launcher(path.join(root, 'CLI with spaces', launcherName), entry)
    for (const spec of ['dsh-ops@^1.0.0', 'dsh-ops@~1.2', 'git+https://example.com/x#semver:^1.0.0', 'pkg name@1.0']) {
      process.env.DSH_OPS_INSTALL_SPEC = spec
      fs.rmSync(receipt, { force: true })
      assert.equal(capture(() => profileCommand('install', { profile: 'tui', dshCli: file })).status, 0)
      assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')), ['plugin', '--profile', 'dsh-tui', 'add', spec],
        'the launcher must receive ' + JSON.stringify(spec) + ' as one argument')
    }
    // `&`, `|`, `<` and `>` separate again inside the launcher's own `%*` expansion, and `%`
    // expands even inside quotes: none of them can be carried by this line.
    for (const spec of ['dsh-ops@1.0.8 & echo INJECTED', 'a|b', 'pkg@%PATH%', 'a"b', 'a<b', 'a>b', 'a!b']) {
      process.env.DSH_OPS_INSTALL_SPEC = spec
      fs.rmSync(receipt, { force: true })
      if (process.platform === 'win32') {
        // The preview refuses the same input as the run: a dry-run that reports success for a
        // spec the real invocation rejects is worse than no preview at all.
        assert.throws(() => capture(() => profileCommand('install', { profile: 'tui', dshCli: file, dryRun: true })),
          /cannot receive an argument/, 'a preview must refuse ' + JSON.stringify(spec))
        assert.throws(() => capture(() => profileCommand('install', { profile: 'tui', dshCli: file })),
          /cannot receive an argument/, 'the cmd line must refuse ' + JSON.stringify(spec))
      } else {
        assert.equal(capture(() => profileCommand('install', { profile: 'tui', dshCli: file })).status, 0)
      }
      assert.equal(fs.existsSync(receipt), false, 'nothing may run for ' + JSON.stringify(spec))
    }
  })
})
report('profile-temp')
