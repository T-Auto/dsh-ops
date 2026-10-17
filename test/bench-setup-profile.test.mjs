/**
 * Setup A: the idempotent profile preparation.
 *
 * Every check runs against a temporary home and a temporary checkout — the real `~/.dsh`
 * is never read, let alone written — and every external command is a stand-in: the
 * `invoke` below records what dsh would have been asked to do, emulates profile creation
 * and plugin installs, and answers `--dump-config` out of the profile's own patch layer,
 * so the read-back really proves the pin landed in the file. Nothing spawns dsh, pnpm or
 * npm; the one real child process is `process.execPath` proving `spawnInvoker`'s contract.
 */

import fs from 'node:fs'
import path from 'node:path'
import { assert, report, test, withTempDir } from './lib/harness.mjs'
import {
  PLUGIN_NAME, approvalPolicyFor, dshHomeFor, ensureLlmOverlay, entryConfigValue, installSpec,
  installedPlugin, nextStepLines, parseArgs, permissionEntries, planEntryPatch, planPatchEntries,
  planProfilePatch, prepareProfiles, specVersion, spawnInvoker,
} from '../bench/setup/profile.mjs'
import { npmGlobalRoot, resolveDshEntry } from '../bench/lib/env.mjs'

const SHELL = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const STORE_PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
/** The shipped profile patch layer: comments plus the `[]` placeholder. */
const TEMPLATE_PATCH = '# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries.\n[]\n'
const EXAMPLE_TEMPLATE = '# bench LLM overlay template\nproviders:\n  bench-server:\n    baseURL: https://<your-server>/v1\n'

/** Read one profile's patch layer as the composed tree `dsh --dump-config` would print it. */
function dumpConfig(profileDir) {
  const file = path.join(profileDir, 'cordis.patch.yml')
  if (!fs.existsSync(file)) return ''
  const out = []
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const id = /^- id:\s*(\S+)\s*$/.exec(line)
    if (id) { out.push(`- id: ${id[1]}`, '  config:'); continue }
    const key = /^\s+([A-Za-z][\w-]*):\s+(\S.*?)\s*$/.exec(line)
    if (key && out.length > 0) out.push(`    ${key[1]}: ${key[2]}`)
  }
  return `${out.join('\n')}\n`
}

/** Every file under `dir`, relative, sorted — the proof that a dry run wrote nothing. */
function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(child).map((file) => path.join(entry.name, file)))
    else out.push(entry.name)
  }
  return out.sort()
}

/** Content, size and mtime of every file — an unchanged mtime proves nothing rewrote it. */
function snapshot(files) {
  return Object.fromEntries(files.map((file) => [file, {
    text: fs.readFileSync(file, 'utf8'),
    size: fs.statSync(file).size,
    mtimeMs: fs.statSync(file).mtimeMs,
  }]))
}

/**
 * A temporary bench home, a temporary checkout and an overlay template, plus the stand-in
 * `invoke`. `installed` seeds a pre-existing plugin copy (a real directory, so the origin
 * check stays silent); `failAdd` makes every `dsh plugin` call fail the way a missing pnpm
 * would.
 */
function fixture(dir, { version = '0.3.1', failAdd = false, installed = null } = {}) {
  const home = path.join(dir, 'home')
  const checkout = path.join(dir, 'checkout')
  const overlay = path.join(dir, 'llm.patch.yml')
  const example = path.join(dir, 'llm.patch.example.yml')
  fs.mkdirSync(checkout, { recursive: true })
  fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ name: PLUGIN_NAME, version }), 'utf8')
  fs.writeFileSync(example, EXAMPLE_TEMPLATE, 'utf8')
  const calls = []
  const logs = []
  const profileDir = (name) => path.join(home, 'profiles', name)
  const pluginDir = (name) => path.join(profileDir(name), 'node_modules', PLUGIN_NAME)
  const install = (name, spec) => {
    const resolved = /^dsh-ops@/.test(spec)
      ? spec.slice(`${PLUGIN_NAME}@`.length)
      : JSON.parse(fs.readFileSync(path.join(spec, 'package.json'), 'utf8')).version
    fs.mkdirSync(pluginDir(name), { recursive: true })
    fs.writeFileSync(path.join(pluginDir(name), 'package.json'), JSON.stringify({ name: PLUGIN_NAME, version: resolved }), 'utf8')
  }
  if (installed) install('bench-ops', `${PLUGIN_NAME}@${installed}`)
  const invoke = (args) => {
    calls.push([...args])
    const at = args.indexOf('--profile')
    // Profile creation names the new profile positionally, not with --profile.
    const created = args.indexOf('--from-default-profile')
    const profile = at === -1 ? args[created - 1] : args[at + 1]
    if (created !== -1) {
      fs.mkdirSync(profileDir(profile), { recursive: true })
      fs.writeFileSync(path.join(profileDir(profile), 'cordis.patch.yml'), TEMPLATE_PATCH, 'utf8')
      return { status: 0, stdout: dumpConfig(profileDir(profile)), stderr: '', errorCode: null }
    }
    if (args.includes('--dump-config')) return { status: 0, stdout: dumpConfig(profileDir(profile)), stderr: '', errorCode: null }
    if (args.includes('plugin')) {
      if (failAdd) return { status: 1, stdout: '', stderr: 'ERR_PNPM_PNPM_NOT_FOUND pnpm is not installed', errorCode: null }
      const spec = args[args.length - 1]
      if (args.includes('remove')) fs.rmSync(pluginDir(profile), { recursive: true, force: true })
      else install(profile, spec)
      return { status: 0, stdout: '', stderr: '', errorCode: null }
    }
    return { status: 0, stdout: '', stderr: '', errorCode: null }
  }
  const parse = (extra = []) => parseArgs(['--dsh-home', home, '--pin-shell', SHELL, ...extra])
  const context = (options, overrides = {}) => ({
    home,
    log: (line) => logs.push(line),
    invoke,
    prefix: [path.join(dir, 'dsh', 'lib', 'bin.js')],
    dryRun: options.dryRun,
    template: 'headless',
    repoRoot: checkout,
    overlay,
    overlayExample: example,
    ...overrides,
  })
  return {
    home, checkout, overlay, example, calls, logs, profileDir, pluginDir,
    baseFile: () => path.join(profileDir('bench-base'), 'cordis.patch.yml'),
    candFile: () => path.join(profileDir('bench-ops'), 'cordis.patch.yml'),
    parse,
    prepare(extra = [], overrides = {}) {
      const options = parse(extra)
      return prepareProfiles(options, context(options, overrides))
    },
  }
}

await test('preparation is idempotent: the second run repeats the verdict and rewrites nothing', async () => {
  await withTempDir('bench-setup-idem-', (dir) => {
    const fx = fixture(dir)
    const first = fx.prepare()
    assert.equal(first.ok, true, first.problems.join('; '))
    assert.deepEqual(first.outcomes, {
      overlay: 'created', baseProfile: 'created', candProfile: 'created',
      shellPin: 'pinned', permissions: 'pinned', plugin: 'installed',
    })
    assert.equal(installedPlugin(fx.home, 'bench-ops'), '0.3.1', 'the candidate carries the checkout version')

    // A rewrite inside the same millisecond would be invisible to an mtime comparison, so
    // the files are backdated first: only a real write moves the stamp forward.
    const past = new Date('2000-01-01T00:00:00Z')
    const files = [fx.baseFile(), fx.candFile(), fx.overlay]
    for (const file of files) fs.utimesSync(file, past, past)
    const before = snapshot(files)
    const callsBefore = fx.calls.length
    const second = fx.prepare()
    assert.equal(second.ok, true, second.problems.join('; '))
    assert.deepEqual(second.outcomes, {
      overlay: 'exists', baseProfile: 'exists', candProfile: 'exists',
      shellPin: 'noop', permissions: 'noop', plugin: 'present',
    })
    assert.deepEqual(snapshot(files), before, 'the second run left every byte and every timestamp alone')
    const secondCalls = fx.calls.slice(callsBefore)
    assert.equal(secondCalls.filter((call) => call.includes('plugin')).length, 0, 'no second install')
    assert.equal(secondCalls.filter((call) => call.includes('--from-default-profile')).length, 0, 'no second profile creation')
  })
})

await test('the baseline pins Windows PowerShell 5.1, both sides pin one mode, the candidate gets the checkout', async () => {
  await withTempDir('bench-setup-pins-', (dir) => {
    const fx = fixture(dir)
    const result = fx.prepare()
    assert.equal(result.ok, true, result.problems.join('; '))

    const base = fs.readFileSync(fx.baseFile(), 'utf8')
    assert.match(base, /^- id: pwsh-sandbox$/m, 'the baseline patch layer names the entry')
    assert.ok(base.includes(`    pwshPath: ${SHELL}`), 'and pins the in-box 5.1 path under config')
    assert.ok(!base.includes(STORE_PWSH), 'the Store pwsh on PATH is never what gets pinned')
    assert.ok(!base.includes('[]'), 'the template placeholder is gone')
    assert.ok(base.startsWith('# Your patch layer'), 'the template comments survive the edit')

    const cand = fs.readFileSync(fx.candFile(), 'utf8')
    assert.ok(!cand.includes('pwshPath'), 'the shell pin belongs to the baseline alone: the candidate re-injects its own at runtime')
    for (const [who, file] of [['baseline', fx.baseFile()], ['candidate', fx.candFile()]]) {
      const text = fs.readFileSync(file, 'utf8')
      assert.match(text, /- id: sandbox-policy\n  config:\n    mode: danger-full-access/, `${who} mode`)
      assert.match(text, /- id: approval\n  config:\n    policy: never/, `${who} approval preset`)
    }

    const add = fx.calls.find((call) => call.includes('add'))
    assert.ok(add, 'the candidate install ran')
    assert.deepEqual(add.slice(add.indexOf('plugin')), ['plugin', '--profile', 'bench-ops', 'add', fx.checkout])
    assert.ok(!fx.calls.flat().some((arg) => /\.(cmd|ps1|bat)$/i.test(arg)), 'no shim is ever spawned')
    assert.ok(fx.logs.join('\n').includes(fx.checkout), 'the log names what the candidate installs')
  })
})

await test('a foreign permission mode is refused, named, and left untouched — --force overwrites it', async () => {
  await withTempDir('bench-setup-conflict-', (dir) => {
    const fx = fixture(dir)
    fs.mkdirSync(fx.profileDir('bench-ops'), { recursive: true })
    const foreign = '- id: sandbox-policy\n  name: x\n  config:\n    mode: workspace-write\n'
    fs.writeFileSync(fx.candFile(), foreign, 'utf8')

    const refused = fx.prepare()
    assert.equal(refused.ok, false, 'a mode this module did not write is not silently replaced')
    assert.equal(refused.outcomes.permissions, 'conflict')
    assert.ok(refused.problems.some((line) => /permission mode/.test(line) && /--force/.test(line)), refused.problems.join('; '))
    assert.equal(fs.readFileSync(fx.candFile(), 'utf8'), foreign, 'the conflicting layer is byte-for-byte untouched')
    const narration = fx.logs.join('\n')
    assert.ok(narration.includes('mode: workspace-write'), 'the refusal names the value it found')
    assert.match(narration, /- id: sandbox-policy\n\s+config:\n\s+mode: danger-full-access/, 'and prints the block to paste by hand')

    const forced = fx.prepare(['--force'])
    assert.equal(forced.outcomes.permissions, 'pinned')
    const patched = fs.readFileSync(fx.candFile(), 'utf8')
    assert.match(patched, /- id: sandbox-policy\n  name: x\n  config:\n    mode: danger-full-access/, 'the foreign entry keeps its other keys')
    assert.match(patched, /- id: approval\n  config:\n    policy: never/)
    assert.equal(patched.split('mode:').length - 1, 1, 'the key is replaced, not duplicated')
  })
})

await test('--dry-run prints the plan, runs nothing and writes nothing', async () => {
  await withTempDir('bench-setup-dry-', (dir) => {
    const fx = fixture(dir)
    const result = fx.prepare(['--dry-run'])
    assert.equal(result.ok, true, result.problems.join('; '))
    assert.deepEqual(result.outcomes, {
      overlay: 'created', baseProfile: 'created', candProfile: 'created',
      shellPin: 'pinned', permissions: 'pinned', plugin: 'installed',
    })
    assert.deepEqual(fx.calls, [], 'no dsh command was run at all')
    assert.equal(fs.existsSync(fx.home), false, 'not even the profile home was created')
    assert.equal(fs.existsSync(fx.overlay), false, 'the overlay is planned, not copied')
    assert.deepEqual(walk(dir), ['checkout/package.json', 'llm.patch.example.yml'], 'nothing else appeared')
    const narration = fx.logs.join('\n')
    assert.ok(narration.includes('would run'), narration)
    assert.ok(narration.includes('would copy'), 'the overlay copy is narrated as a plan')
    assert.ok(narration.includes('[dry-run]'), 'the read-back is explicitly skipped')
  })
})

await test('the overlay is seeded only when it is missing, and an existing one is never overwritten', async () => {
  await withTempDir('bench-overlay-', (dir) => {
    const example = path.join(dir, 'llm.patch.example.yml')
    const overlay = path.join(dir, 'llm.patch.yml')
    fs.writeFileSync(example, EXAMPLE_TEMPLATE, 'utf8')
    const lines = []
    const log = (line) => lines.push(line)

    // No template, no copy: a half-prepared overlay is worse than a named absence.
    assert.equal(ensureLlmOverlay({ overlay, example: path.join(dir, 'gone.yml'), log }), 'missing-example')
    assert.equal(fs.existsSync(overlay), false, 'nothing is invented without a template')

    assert.equal(ensureLlmOverlay({ overlay, example, log }), 'created')
    assert.equal(fs.readFileSync(overlay, 'utf8'), EXAMPLE_TEMPLATE, 'the copy is the template, verbatim')

    // The operator fills the copy in; the next setup run must not put the placeholders back.
    const filled = 'providers:\n  bench-server:\n    baseURL: https://bench.example/v1\n'
    fs.writeFileSync(overlay, filled, 'utf8')
    assert.equal(ensureLlmOverlay({ overlay, example, log }), 'exists')
    assert.equal(fs.readFileSync(overlay, 'utf8'), filled, 'an existing overlay is the operator\'s file')

    // A plan names the copy and writes nothing.
    fs.unlinkSync(overlay)
    assert.equal(ensureLlmOverlay({ overlay, example, dryRun: true, log }), 'created')
    assert.equal(fs.existsSync(overlay), false, '--dry-run never copies')
    assert.match(lines.join('\n'), /already exists/, 'the existing file is reported, not silently accepted')
  })
})

await test('a sweep run keeps a filled-in overlay and warns when the template itself is missing', async () => {
  await withTempDir('bench-overlay-run-', (dir) => {
    const fx = fixture(dir)
    const filled = 'providers:\n  bench-server:\n    baseURL: https://bench.example/v1\n'
    fs.writeFileSync(fx.overlay, filled, 'utf8')
    assert.equal(fx.prepare().outcomes.overlay, 'exists')
    assert.equal(fs.readFileSync(fx.overlay, 'utf8'), filled)

    const bare = fixture(path.join(dir, 'bare'))
    fs.unlinkSync(bare.example)
    const result = bare.prepare()
    assert.equal(result.outcomes.overlay, 'missing-example')
    assert.ok(result.warnings.some((line) => line.includes('llm.patch.example.yml')), result.warnings.join('; '))
    assert.equal(fs.existsSync(bare.overlay), false, 'a missing template creates nothing')
  })
})

await test('install failures and stale copies name the plugin, the version and the spec', async () => {
  await withTempDir('bench-plugin-fail-', (dir) => {
    const fx = fixture(dir, { failAdd: true })
    const result = fx.prepare()
    assert.equal(result.ok, false)
    assert.equal(result.outcomes.plugin, 'failed')
    const problem = result.problems.find((line) => line.includes(PLUGIN_NAME))
    assert.ok(problem, `a failure has to name the plugin: ${result.problems.join('; ')}`)
    assert.match(problem, /dsh-ops@0\.3\.1/, 'the version it wanted is named')
    assert.ok(problem.includes(fx.checkout), 'the spec it tried is named')
    assert.match(fx.logs.join('\n'), /could not install dsh-ops@0\.3\.1/, 'the narration names it too')
    assert.match(fx.logs.join('\n'), /pnpm/, 'and points at the usual cause')
  })
  await withTempDir('bench-plugin-stale-', (dir) => {
    const fx = fixture(dir, { installed: '0.2.0' })
    const result = fx.prepare()
    assert.equal(result.outcomes.plugin, 'stale')
    const problem = result.problems.find((line) => line.includes('--reinstall'))
    assert.ok(problem, result.problems.join('; '))
    assert.match(problem, /dsh-ops@0\.2\.0/, 'the old copy is named')
    assert.match(problem, /dsh-ops@0\.3\.1/, 'and so is what this checkout would install')
    assert.equal(fs.readFileSync(path.join(fx.pluginDir('bench-ops'), 'package.json'), 'utf8').includes('0.2.0'), true, 'the stale copy is not silently replaced')
  })
})

await test('the pure planner is idempotent, appends beside foreign entries, and refuses unsafe shapes', () => {
  const plan = planProfilePatch(TEMPLATE_PATCH, SHELL)
  assert.equal(plan.action, 'write')
  assert.match(plan.text, /^- id: pwsh-sandbox\r?$/m)
  assert.ok(plan.text.includes(`    pwshPath: ${SHELL}`))
  assert.ok(!plan.text.includes('[]'))
  assert.ok(plan.text.endsWith('\n'))

  assert.equal(planProfilePatch(plan.text, SHELL).action, 'noop', 'the same value is not rewritten')
  const conflict = planProfilePatch(plan.text, STORE_PWSH)
  assert.equal(conflict.action, 'conflict')
  assert.match(conflict.note, /--force/)
  const forced = planProfilePatch(plan.text, STORE_PWSH, { force: true })
  assert.equal(forced.text.split('pwshPath:').length - 1, 1, 'exactly one pwshPath line')

  const withOther = '- id: llm-pi-ai\n  config:\n    providers: {}\n'
  const appended = planProfilePatch(withOther, SHELL)
  assert.ok(appended.text.includes('- id: llm-pi-ai'), 'a foreign entry is untouched')
  assert.ok(appended.text.includes('- id: pwsh-sandbox'))
  const entryOnly = '- id: pwsh-sandbox\n  config:\n    timeoutMs: 60000\n'
  assert.ok(planProfilePatch(entryOnly, SHELL).text.includes('timeoutMs: 60000'), 'existing config keys stay')

  assert.equal(planProfilePatch('id: pwsh-sandbox\n', SHELL).action, 'manual', 'a mapping is not a patch list')
  assert.equal(planProfilePatch('- id: pwsh-sandbox\n  config: { timeoutMs: 60000 }\n', SHELL).action, 'manual', 'an inline config is left alone')
  assert.equal(planProfilePatch('tabs:\n\t- id: x\n', SHELL).action, 'manual')
  assert.equal(planEntryPatch('- id: sandbox-policy\n  config: { mode: read-only }\n', permissionEntries('danger-full-access')[0]).action, 'manual')
})

await test('the permission pin carries the preset dsh-base derives, and refuses a foreign mode', () => {
  assert.deepEqual(permissionEntries('danger-full-access'), [
    { id: 'sandbox-policy', config: { mode: 'danger-full-access' } },
    { id: 'approval', config: { policy: 'never' } },
  ], 'full access carries the approval policy dsh-base derives')
  assert.deepEqual(permissionEntries('workspace-write')[1].config, { policy: 'ask' })
  assert.equal(approvalPolicyFor('read-only'), 'ask')

  const planned = planPatchEntries(TEMPLATE_PATCH, permissionEntries('danger-full-access'))
  assert.match(planned.text, /^- id: sandbox-policy\r?$/m)
  assert.match(planned.text, /^- id: approval\r?$/m)
  assert.ok(planned.text.includes('    mode: danger-full-access'))
  assert.ok(planned.text.includes('    policy: never'))
  assert.equal(planPatchEntries(planned.text, permissionEntries('danger-full-access')).action, 'noop')

  const withShell = `- id: pwsh-sandbox\n  config:\n    pwshPath: ${SHELL}\n`
  const both = planPatchEntries(withShell, permissionEntries('workspace-write'))
  assert.ok(both.text.includes(`pwshPath: ${SHELL}`), 'the shell pin survives')
  assert.match(both.text, /- id: sandbox-policy\n  config:\n    mode: workspace-write/)
  assert.match(both.text, /- id: approval\n  config:\n    policy: ask/)

  const existing = '- id: sandbox-policy\n  name: x\n  config:\n    mode: read-only\n'
  assert.equal(planPatchEntries(existing, permissionEntries('danger-full-access')).action, 'conflict')
})

await test('the composed-tree reader is scoped to one entry', () => {
  const dump = [
    '- id: telemetry', '  config:', '    mode: !!js process.env.DSH_TELEMETRY_MODE', '- id: sandbox-policy', '  config:',
    '    mode: danger-full-access', '    workspaceRoot: !!js process.cwd()', '- id: approval', '  config:', '    policy: never', '',
  ].join('\n')
  assert.equal(entryConfigValue(dump, 'sandbox-policy', 'mode'), 'danger-full-access')
  assert.equal(entryConfigValue(dump, 'approval', 'policy'), 'never')
  assert.equal(entryConfigValue(dump, 'telemetry', 'mode'), '!!js process.env.DSH_TELEMETRY_MODE')
  assert.equal(entryConfigValue(dump, 'sandbox-policy', 'approval'), null, 'a key of another entry does not leak in')
  assert.equal(entryConfigValue(dump, 'nope', 'mode'), null)
  assert.equal(entryConfigValue('', 'sandbox-policy', 'mode'), null)
})

await test('argument handling fails closed on typos and defaults to this checkout', () => {
  assert.equal(parseArgs([]).plugin, 'local', 'the working tree is the default spec, so no publish is needed to measure it')
  assert.equal(parseArgs([]).permissionMode, 'danger-full-access', 'both profiles default to full access')
  assert.equal(parseArgs(['--permission-mode', 'workspace-write']).permissionMode, 'workspace-write')
  assert.equal(parseArgs(['--no-permission-mode']).permissionMode, 'none')
  assert.equal(parseArgs(['--no-pin']).pinShell, null)
  assert.equal(parseArgs(['--no-plugin']).plugin, 'none')
  assert.equal(parseArgs(['--plugin', 'dsh-ops@0.2.1']).plugin, 'dsh-ops@0.2.1')
  assert.equal(parseArgs(['--dsh-home', 'D:/bench/home']).dshHome, 'D:/bench/home')
  assert.throws(() => parseArgs(['--permission-mode', 'yolo']), /--permission-mode/)
  assert.throws(() => parseArgs(['--pin']), /unknown option/)
  assert.throws(() => parseArgs(['--base-profile', 'headless']), /shipped template/)
  assert.throws(() => parseArgs(['--base-profile', 'x', '--cand-profile', 'x']), /must differ/)
  assert.throws(() => parseArgs(['--plugin=']), /needs a value/)
  // Setup B adds its own flags through the same parser instead of editing this module.
  const merged = parseArgs(['--no-build-check'], { boolean: { '--no-build-check': ['noBuildCheck', true] } })
  assert.equal(merged.noBuildCheck, true)
  assert.equal(merged.plugin, 'local')

  assert.equal(specVersion('local'), JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
  assert.equal(specVersion('dsh-ops@0.3.1-rc.2'), '0.3.1-rc.2')
  assert.equal(specVersion('dsh-ops@latest'), null, 'a dist tag pins nothing to compare against')
  assert.equal(specVersion('./some/checkout.tgz'), null)
  assert.deepEqual(installSpec(parseArgs([]), '/tmp/checkout'), {
    local: true, spec: '/tmp/checkout', version: null, label: PLUGIN_NAME, what: 'the local checkout /tmp/checkout',
  })
})

await test('dshHomeFor resolves an isolated home from --dsh-home, DSH_HOME or the user home', () => {
  assert.equal(dshHomeFor(parseArgs(['--dsh-home', 'relative/home'])), path.resolve('relative/home'))
  assert.equal(dshHomeFor(parseArgs([]), { env: { DSH_HOME: '/tmp/isolated' }, home: '/home/dev' }), path.resolve('/tmp/isolated'))
  assert.equal(dshHomeFor(parseArgs([]), { env: {}, home: '/home/dev' }), path.resolve('/home/dev/.dsh'))
})

await test('the next-step lines name the sweep entry point, and the profiles when they are renamed', () => {
  const defaults = nextStepLines({ baseProfile: 'bench-base', candProfile: 'bench-ops' })
  assert.ok(defaults.every((line) => line.includes('node bench/cli.mjs ab')), defaults.join('\n'))
  assert.ok(!defaults.join('\n').includes('--base'), 'the default pair needs no flags')
  const renamed = nextStepLines({ baseProfile: 'alt-base', candProfile: 'alt-ops' })
  assert.ok(renamed[0].includes('--base alt-base --cand alt-ops'), renamed[0])
})

await test('spawnInvoker keeps argv verbatim, captures the exit code and never uses a shell', () => {
  const invoke = spawnInvoker({ command: process.execPath, env: { ...process.env }, timeoutMs: 30_000 })
  const echoed = invoke(['-e', 'process.stdout.write(process.argv.slice(1).join("|"))', '--', 'a b', 'c'])
  assert.equal(echoed.status, 0)
  assert.equal(echoed.stdout, 'a b|c', 'a quoted argument arrives as one argument, not re-split by a shell')
  const failed = invoke(['-e', 'process.stderr.write("boom"); process.exit(3)'])
  assert.equal(failed.status, 3)
  assert.equal(failed.stderr, 'boom')
  assert.equal(failed.errorCode, null)
})

await test('resolveDshEntry falls back to the global npm root, and says so when it cannot', async () => {
  await withTempDir('bench-npm-root-', (dir) => {
    const root = path.join(dir, 'npm-root')
    const bin = path.join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    fs.writeFileSync(bin, '// dsh\n')
    const emptyPath = path.join(dir, 'no-binaries')
    fs.mkdirSync(emptyPath)
    const env = { PATH: emptyPath }
    const asked = []
    const runNpm = (command, args) => {
      asked.push([command, ...args])
      return { status: 0, stdout: `${root}\n`, stderr: '', errorCode: null }
    }

    const entry = resolveDshEntry(null, { env, platform: 'linux', runNpm })
    assert.equal(entry.file, bin, 'the global root npm reports is the fallback that finds it')
    assert.deepEqual(asked, [['npm', 'root', '-g']])
    assert.ok(entry.notes.some((note) => note.includes(`npm root -g ${root}`)), entry.notes.join('; '))

    // An npm that cannot answer is not an error of its own: the lookup reports the miss.
    assert.throws(() => resolveDshEntry(null, { env, platform: 'linux', runNpm: () => null }), /npm root -g/)
    assert.throws(() => resolveDshEntry(null, { env, platform: 'linux', runNpm: () => ({ status: 1, stdout: '', stderr: 'no', errorCode: null }) }), /could not find the dsh launcher/)
    // A root that does not actually hold dsh is not used either.
    const elsewhere = path.join(dir, 'elsewhere')
    fs.mkdirSync(elsewhere)
    assert.throws(() => resolveDshEntry(null, { env, platform: 'linux', runNpm: () => ({ status: 0, stdout: elsewhere, stderr: '', errorCode: null }) }), /could not find the dsh launcher/)
    // An explicit --dsh still wins without ever asking npm.
    assert.equal(resolveDshEntry(bin, { env, platform: 'linux', runNpm: () => { throw new Error('npm must not be asked') } }).file, bin)

    assert.equal(npmGlobalRoot({ run: () => ({ status: 0, stdout: '  /opt/npm  \n', stderr: '', errorCode: null }) }), '/opt/npm')
    assert.equal(npmGlobalRoot({ run: () => ({ status: 0, stdout: '   \n', stderr: '', errorCode: null }) }), null, 'blank output is no answer')
    assert.equal(npmGlobalRoot({ run: () => null }), null)
  })
})

report('bench-setup-profile')
