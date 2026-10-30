/** Data-only shell bundle defaults and platform environment contracts. */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseDocument } from 'yaml'
import { resolveConfig } from '../lib/config.js'
import { MODE_CONFIG_KEYS, resolveModeConfig } from '../lib/modes/config.js'
import { COMPONENTS, componentEnabled, componentEntry } from '../lib/components/defaults.js'
import { BASH_TOOL_NAME, ENV_OVERRIDES, shellEnvOverrides, resolveShells } from '../lib/shells.js'
import { assert, PACKAGE_ROOT, TEST_HOME, report, test, withTempDir } from './lib/harness.mjs'
import { config, makeExecutable } from './lib/shells-fixtures.mjs'
const PATCH_TEXT = fs.readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')
const patchEntries = () => parseDocument(PATCH_TEXT).toJS()

await test('the manifest declares the plugin\'s own shell tools as their own namespace', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'dsh-plugin.json'), 'utf8'))
  const namespaces = manifest.contributes['x-tool-namespaces']
  // Unconditional: the manifest describes the capability, not this deployment's
  // switch state, so `bash` is declared even while a profile ships no bash.
  // Index 1, directly after the native file namespace (the FastCtx namespace is gone).
  assert.deepEqual(namespaces[1], {
    serverName: 'dsh-ops',
    transport: 'in-process',
    source: "the plugin's bash layer via host subprocess",
    publicPrefix: 'ops_',
    tools: ['bash'],
    shellPermission: 'Mode row enabled with the matching preset AND publishBashTool AND authoritative per-session DSH policy; restricted modes require host confinement',
  })
  // The declared name is the name the tool actually registers under.
  assert.equal(BASH_TOOL_NAME, `${namespaces[1].publicPrefix}${namespaces[1].tools[0]}`)
})

await test('the bundle patch declares the single row, with no persistent pwsh override', () => {
  const entries = patchEntries()
  assert.equal(entries.length, 1)
  assert.deepEqual(entries[0].insert.map(row => row.id), ['dsh-ops'])
  assert.deepEqual(entries[0].insert.map(row => row.name), ['dsh-ops'])
  const config = entries[0].insert[0].config
  for (const key of ['bash', 'hidePwsh', 'hideOfficialTools', 'dynamicTools']) assert.equal(config.global[key], true, key)
  for (const section of ['minimal', 'standard', 'ptc', 'cordis', 'discovery']) assert.equal(config[section].enabled, true, section)
  for (const section of ['panel', 'tui']) assert.equal(config[section].enabled, false, section)
})

await test('every shipped preset section states the documented shell defaults through its validator', () => {
  const config = patchEntries()[0].insert[0].config
  for (const mode of ['minimal', 'standard', 'ptc', 'cordis']) {
    const section = config[mode]
    for (const key of Object.keys(section)) assert.ok(['enabled', ...MODE_CONFIG_KEYS].includes(key), `${mode}.${key} is accepted or the enable switch`)
    const { enabled, ...rest } = section
    const resolved = resolveModeConfig(rest)
    assert.equal(enabled, true, mode)
    assert.equal(resolved.bashPath, undefined, mode)
    assert.equal(resolved.publishBashTool, true, mode)
    assert.equal(resolved.allowSystemShellFallback, false, mode)
  }
})

await test('system discovery is opt-in on Windows and is the rung on a POSIX host', async () => {
  await withTempDir('shells-default-confined', dir => {
    // Both spellings exist, so the case asserts the same facts on either host.
    const system = makeExecutable(path.join(dir, 'bin', 'bash'))
    const systemExe = makeExecutable(path.join(dir, 'bin', 'bash.exe'))
    const programFiles = path.join(dir, 'Program Files')
    const wellKnown = makeExecutable(path.join(programFiles, 'Git', 'bin', 'bash.exe'))
    const base = { bundleRoot: path.join(dir, 'plugin'), env: { DSH_HOME: TEST_HOME, PATH: path.join(dir, 'bin'), ProgramFiles: programFiles } }
    const host = process.platform
    // Windows: with no pinned payload and the flag off, PATH and the well-known install are both
    // visible and both deliberately not taken — `allowSystemShellFallback` is the gate on reaching
    // past the pinned copy, and there is none.
    for (const raw of [resolveConfig({}), {}, undefined]) {
      const result = resolveShells(raw, { ...base, platform: 'win32', arch: 'x64' }).bash
      assert.equal(result.available, false, JSON.stringify(result))
      assert.equal(result.source, 'disabled')
      assert.equal(result.file, undefined)
    }
    // Windows with the flag ON: PATH answers first, and the well-known install answers when PATH
    // does not — the same two rungs the POSIX host uses, reached through the gate instead.
    const winFallback = resolveShells(config({ allowSystemShellFallback: true }), { ...base, platform: 'win32', arch: 'x64' }).bash
    assert.equal(winFallback.source, 'path')
    assert.equal(winFallback.file, systemExe)
    const winWellKnown = resolveShells(config({ allowSystemShellFallback: true }), {
      ...base, platform: 'win32', arch: 'x64', env: { ...base.env, PATH: '/nonexistent-bin' },
    }).bash
    assert.equal(winWellKnown.source, 'well-known', JSON.stringify(winWellKnown))
    assert.equal(winWellKnown.file, wellKnown)
    // POSIX: the machine's own bash IS the rung, so the same config resolves it with no flag — and
    // `config.bashPath` still outranks discovery.
    const linux = resolveShells(config({}), { ...base, platform: 'linux', arch: 'x64' }).bash
    assert.equal(linux.available, true, JSON.stringify(linux))
    assert.equal(linux.source, 'path')
    assert.equal(linux.file, system)
    if (process.platform !== 'win32') {
      const posixWellKnown = resolveShells(config({}), { ...base, platform: 'linux', arch: 'x64', env: { ...base.env, PATH: '/nonexistent-bin' } }).bash
      assert.equal(posixWellKnown.source, 'well-known', JSON.stringify(posixWellKnown))
    }
    assert.equal(resolveShells(config({ bashPath: system }), { ...base, platform: host, arch: process.arch }).bash.source, 'config')
  })
})

await test('an inherited LC_ALL cannot un-pin the message locale, and encoding survives it', () => {
  // Reported by @Haoming9527 in review of #81: POSIX resolves LC_ALL before LC_MESSAGES, so on a host
  // that sets LC_ALL (`zh_CN.UTF-8` desktops commonly set nothing else) the English pin below was
  // silently ineffective, and a localized libc stopped matching the host's English
  // `denialSignatures`. Measured on this host before the fix: `LC_MESSAGES="zh_CN.UTF-8"`.
  const pinned = shellEnvOverrides({ LC_ALL: 'zh_CN.UTF-8' }, {})
  assert.equal(pinned.LC_MESSAGES, 'C')
  assert.equal(pinned.LC_ALL, '', 'an empty value is "unset" to the C library, so the pin holds')
  assert.equal(pinned.LC_CTYPE, 'zh_CN.UTF-8', "the variable's encoding intent must survive")
  // A host that stated its own ctype keeps it: only the language is pinned, never the codeset.
  assert.equal(Object.hasOwn(shellEnvOverrides({ LC_ALL: 'zh_CN.UTF-8', LC_CTYPE: 'en_US.UTF-8' }, {}), 'LC_CTYPE'), false)
  // No ambient override to neutralize: the plain shape is unchanged, byte for byte.
  assert.deepEqual(shellEnvOverrides({ LANG: 'zh_CN.UTF-8' }, {}), { ...ENV_OVERRIDES })
  // A caller's own LC_ALL is neutralized the same way, so the seam cannot un-pin it either.
  assert.equal(shellEnvOverrides({}, { LC_ALL: 'zh_CN.UTF-8' }).LC_ALL, '')
  assert.equal(shellEnvOverrides({}, { LC_ALL: 'zh_CN.UTF-8' }).LC_CTYPE, 'zh_CN.UTF-8')
  if (process.platform === 'win32') return
  // Effective locale, read back from the C library rather than from the environment: `locale` prints
  // what libc resolved, and `wc -m` counts characters, which `LC_ALL=C` would break (6 for `中文`).
  const utfLocale = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8'
  const probe = spawnSync('/bin/sh', ['-c', 'locale 2>/dev/null | grep "^LC_MESSAGES="; printf "中文" | wc -m'], {
    env: { ...process.env, ...shellEnvOverrides({ LC_ALL: utfLocale }, {}), LC_CTYPE: utfLocale }, encoding: 'utf8',
  })
  assert.equal(probe.status, 0, probe.stderr)
  assert.match(probe.stdout, /LC_MESSAGES="?C"?/, `the effective message locale must be C: ${probe.stdout}`)
  assert.equal(probe.stdout.trim().split('\n').pop().trim(), '2', `UTF-8 input must still count per character: ${probe.stdout}`)
})

report('shells-patch')
