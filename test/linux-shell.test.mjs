/**
 * The shell component on a POSIX host: the machine's own bash, and nothing unrestricted.
 *
 * This is the POSIX rung of `dsh-ops/shell`. Windows keeps its pinned, digest-checked payload and
 * the `allowSystemShellFallback` gate around it; a Linux host has a distribution-maintained bash
 * whose ABI is tied to that distribution, so the plugin resolves that one instead of provisioning a
 * second copy (`lib/shells.js`, `POSIX_BASH_WELL_KNOWN`). The route was designed in WTStarMark's PR
 * #40 as its own `dsh-ops-linux` component; this suite covers the same capability merged into the
 * existing component, so what is asserted is the code that ships here.
 *
 * What this locks in:
 *
 * - On `linux`, the resolver answers from `config.bashPath` -> `PATH` -> the well-known locations,
 *   **without** `allowSystemShellFallback`; that flag is the Windows gate on reaching past a pinned
 *   payload and there is no pinned payload on POSIX.
 * - Windows behaviour is unchanged: same config, `platform: 'win32'`, still `disabled`.
 * - The POSIX candidates are POSIX paths (no drive letter, no backslash) even when the suite runs on
 *   another host, and PowerShell 7 has no POSIX rung here.
 * - `ops_bash` really runs on this host: the tool is published and a command's stdout comes back.
 * - A confined mode never falls back to unrestricted execution: an unusable confinement result is
 *   refused with `SANDBOX_UNAVAILABLE`, and read-only publishes no bash tool at all.
 *
 * Intentional omissions, both stated rather than papered over:
 *
 * - `dsh-ops provision-shells` provisioning the pinned payload is a Windows action, so this suite
 *   asserts the CLI *refuses* it here instead of exercising the download.
 * - The POSIX "no bash anywhere" branch cannot be reached on a host that has one: its candidates are
 *   real absolute paths, and `/bin/bash` exists on this machine, so no `PATH`/`bundleRoot` fixture can
 *   empty the ladder. The wording an operator would see is asserted directly against the exported
 *   `POSIX_BASH_REMEDY` constant the branch concatenates (code-read-only branch, not a faked run).
 *
 * @module dsh-ops/test/linux-shell
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { assert, report, skipSuite, test, withTempDir } from './lib/harness.mjs'
import { bootHost, publicToolNames, shutdown } from './lib/host.mjs'
import { applyComponent } from '../lib/index.js'
import { POSIX_BASH_REMEDY, POSIX_BASH_WELL_KNOWN, resolveShells } from '../lib/shells.js'
import { BASH_TOOL } from '../lib/policy.js'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'

const CLI = path.join(process.cwd(), 'bin', 'dsh-ops.mjs')

if (process.platform === 'win32') {
  skipSuite('linux-shell', "this suite's subject is the POSIX bash rung; it asserts Windows separately and runs on a POSIX host")
}

/** Mount one component into a host context, the way the bundle row does. */
const mountComponent = (ctx, name, config) => ctx.plugin({
  name: `fixture-${name}`,
  apply(inner) { return applyComponent(inner, { ...config }, name) },
})

/** A scoped agent whose session policy this suite controls. */
async function agentFor(ctx, id, mode, cwd) {
  const { createScope } = await import('@deepseek-ai/dsh-scope')
  const result = { id, session: { id, mode, header: { cwd } } }
  let scope
  await ctx.plugin({ inject: ['tools'], apply(inner) { scope = createScope(inner, result) } })
  result.ctx = scope.ctx
  await ctx.serial('agent/created', { agent: result, source: 'startup' })
  return result
}

const policyService = sessions => ({
  resolve({ session }) { return { mode: session.mode, workspaceRoot: session.header.cwd, sessionId: session.id } },
})

await test('linux resolves the host bash without the Windows fallback flag', () => {
  const env = { PATH: '/usr/bin:/bin' }
  const onPath = resolveShells({}, { platform: 'linux', arch: 'x64', env }).bash
  assert.equal(onPath.available, true, JSON.stringify(onPath))
  assert.equal(onPath.source, 'path')
  assert.match(onPath.detail, /host distribution's own bash/)
  // Empty PATH: the well-known rung answers, and it is a POSIX path rather than a host-formatted one.
  const wellKnown = resolveShells({}, { platform: 'linux', arch: 'x64', env: { PATH: '' } }).bash
  assert.equal(wellKnown.source, 'well-known', JSON.stringify(wellKnown))
  assert.ok(POSIX_BASH_WELL_KNOWN.includes(wellKnown.file) || wellKnown.file === '/opt/homebrew/bin/bash', JSON.stringify(wellKnown))
  // An explicit executable still wins over discovery, and a missing one is still an error.
  assert.equal(resolveShells({ bashPath: '/bin/bash' }, { platform: 'linux', arch: 'x64', env }).bash.source, 'config')
  const missing = resolveShells({ bashPath: '/opt/nope/bash' }, { platform: 'linux', arch: 'x64', env }).bash
  assert.equal(missing.available, false)
  assert.match(missing.detail, /does not exist/)
  // The one wording a POSIX operator must never see is the Windows provisioner's: it installs the
  // pinned Windows payload. The branch that prints it is unreachable here (see the suite header), so
  // the constant it prints is asserted directly.
  assert.match(POSIX_BASH_REMEDY, /distribution package manager/)
  assert.match(POSIX_BASH_REMEDY, /config\.bashPath/)
  assert.ok(!/provision-shells/.test(POSIX_BASH_REMEDY), `a POSIX host must not be sent to the Windows provisioner: ${POSIX_BASH_REMEDY}`)
  assert.equal(resolveShells({}, { platform: 'linux', arch: 'x64', env: { PATH: '/nonexistent-bin' } }).bash.source, 'well-known',
    'discovery falls through to the well-known locations rather than giving up after PATH')
})

await test('the POSIX rung is bash-only and does not change the Windows answer', () => {
  assert.ok(POSIX_BASH_WELL_KNOWN.includes('/bin/bash'))
  assert.ok(POSIX_BASH_WELL_KNOWN.includes('/opt/homebrew/bin/bash'))
  for (const candidate of POSIX_BASH_WELL_KNOWN) {
    assert.ok(candidate.startsWith('/'), `a POSIX candidate must be absolute: ${candidate}`)
    assert.ok(!candidate.includes('\\'), `a POSIX candidate must not carry a backslash: ${candidate}`)
  }
  // PowerShell 7 has no POSIX rung: the bundled overlay and the pwsh-sandbox row are Windows facts.
  const linux = resolveShells({}, { platform: 'linux', arch: 'x64', env: { PATH: '/usr/bin:/bin' } })
  assert.equal(linux.pwsh.available, false, JSON.stringify(linux.pwsh))
  // The Windows contract is untouched: no payload, flag off, still disabled and still pointed at the
  // pinned copy rather than at PATH.
  const windows = resolveShells({}, { platform: 'win32', arch: 'x64', env: { PATH: 'C:\\Windows\\System32' } }).bash
  assert.equal(windows.available, false)
  assert.equal(windows.source, 'disabled')
  assert.match(windows.detail, /allowSystemShellFallback is false/)
})

await test('the POSIX rung is decided by the platform alone, and an explicit path still wins', () => {
  const env = { PATH: '/usr/bin:/bin' }
  const options = { platform: 'linux', arch: 'x64', env }
  // The resolver no longer takes a caller override: the platform decides, so a stray `posix: false`
  // (once passed by the removed FastCtx job lane) cannot turn the shell component's rung off.
  assert.equal(resolveShells({}, options).bash.available, true)
  assert.equal(resolveShells({}, { ...options, posix: false }).bash.available, true)
  assert.equal(resolveShells({ bashPath: '/bin/bash' }, options).bash.source, 'config')
})

await test('the CLI refuses to provision shells on this host and says what to do instead', () => {
  const result = spawnSync(process.execPath, [CLI, 'provision-shells', '--bash'], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 })
  assert.equal(result.status, 1, `provision-shells must refuse here, got ${result.status}: ${result.stderr}`)
  assert.match(`${result.stderr}${result.stdout}`, /provisions shells on Windows only/)
  assert.match(`${result.stderr}${result.stdout}`, /config\.bashPath/)
})

await test('ops_bash runs a real command through the host bash', async () => {
  const { ctx } = await bootHost()
  try {
    if (!ctx.get('subprocess')) await ctx.plugin(Subprocess)
    await ctx.plugin(inner => inner.provide('sandboxPolicy', policyService()))
    await withTempDir('linux-shell-run', async workspace => {
      await mountComponent(ctx, 'shell', {})
      const agent = await agentFor(ctx, 'linux-shell-run', 'danger-full-access', workspace)
      // `ops_bash` is published per agent scope, not host-wide, so the deadline is on the scoped view.
      const deadline = Date.now() + 5000
      let definition = ctx.get('tools').get(BASH_TOOL, agent)
      while (!definition && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50))
        definition = ctx.get('tools').get(BASH_TOOL, agent)
      }
      assert.ok(definition, `ops_bash must be published to the session on Linux, got ${publicToolNames(ctx).join(', ')}`)
      const value = await definition.execute({ command: 'echo dsh-ops-linux-bash' }, { agent, signal: new AbortController().signal })
      assert.equal(value.sandbox?.mode, 'danger-full-access', JSON.stringify(value.sandbox))
      assert.match(String(value.stdout?.text ?? ''), /dsh-ops-linux-bash/, `the host bash must have run: ${JSON.stringify(value)}`)
      // The resolved executable is the machine's own bash, not a plugin-owned copy.
      const resolved = resolveShells({}).bash
      assert.equal(resolved.source, 'path', JSON.stringify(resolved))
      assert.equal(path.isAbsolute(resolved.file), true)
      assert.ok(fs.existsSync(resolved.file), `the resolved bash must exist: ${resolved.file}`)
    })
  } finally { await shutdown(ctx) }
})

await test('a confined mode is refused rather than run unrestricted', async () => {
  const { ctx } = await bootHost()
  try {
    if (!ctx.get('subprocess')) await ctx.plugin(Subprocess)
    const confines = []
    await ctx.plugin(inner => {
      inner.provide('sandboxPolicy', policyService())
      // A confinement provider that exists but cannot confine: the call must be refused, not run.
      inner.provide('sandbox', { async confine() { confines.push(1); return { argc: 0, argv: [], enforcement: 'none' } } })
    })
    await withTempDir('linux-shell-confined', async workspace => {
      await mountComponent(ctx, 'shell', {})
      const agent = await agentFor(ctx, 'linux-shell-confined', 'workspace-write', workspace)
      const deadline = Date.now() + 5000
      let definition = ctx.get('tools').get(BASH_TOOL, agent)
      while (!definition && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50))
        definition = ctx.get('tools').get(BASH_TOOL, agent)
      }
      assert.ok(definition, 'a confined session with a provider must still see ops_bash')
      const value = await definition.execute({ command: 'echo no' }, { agent, signal: new AbortController().signal })
      // The refusal arrives as an error envelope rather than a thrown exception — the plugin's
      // documented shape, and the same one Windows gets (#44 status stamping). What matters here is
      // that the host sandbox was consulted and that the command did not run.
      assert.match(String(value.error), /EXECUTOR_UNAVAILABLE|SANDBOX_UNAVAILABLE/, `an unusable confinement result must be refused: ${JSON.stringify(value)}`)
      assert.equal(confines.length, 1, 'the confined path must go through the host confinement provider')
      assert.ok(!String(value.stdout?.text ?? '').includes('no'), `no command may run under unusable confinement: ${JSON.stringify(value.stdout)}`)
    })
  } finally { await shutdown(ctx) }
})

await test('read-only publishes no bash tool at all', async () => {
  const { ctx } = await bootHost()
  try {
    if (!ctx.get('subprocess')) await ctx.plugin(Subprocess)
    await ctx.plugin(inner => inner.provide('sandboxPolicy', policyService()))
    await withTempDir('linux-shell-readonly', async workspace => {
      await mountComponent(ctx, 'shell', {})
      const agent = await agentFor(ctx, 'linux-shell-readonly', 'read-only', workspace)
      await new Promise(resolve => setTimeout(resolve, 200))
      assert.equal(ctx.get('tools').get(BASH_TOOL, agent), undefined, 'read-only must not expose a command tool')
    })
  } finally { await shutdown(ctx) }
})

await test('session bash resolves workdir before validating or spawning it (#180)', async () => {
  const { ctx } = await bootHost()
  const previousCwd = process.cwd()
  try {
    await ctx.plugin(Subprocess)
    await ctx.plugin(inner => inner.provide('sandboxPolicy', policyService()))
    await withTempDir('linux-shell-workdir', async root => {
      const workspace = path.join(root, 'session workspace')
      const helper = path.join(root, 'helper')
      const child = path.join(workspace, 'retest-dir')
      fs.mkdirSync(child, { recursive: true })
      // Both directories exist: success alone must not hide running in the wrong one.
      fs.mkdirSync(path.join(helper, 'retest-dir'), { recursive: true })
      process.chdir(helper)
      await mountComponent(ctx, 'shell', {})
      const agent = await agentFor(ctx, 'linux-shell-workdir', 'danger-full-access', workspace)
      let definition
      const deadline = Date.now() + 5000
      while (!(definition = ctx.get('tools').get(BASH_TOOL, agent)) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      assert.ok(definition, 'the session must publish ops_bash')
      const execute = args => definition.execute(args, { agent, signal: new AbortController().signal })
      for (const [workdir, expected] of [
        [undefined, workspace], ['', workspace], ['   ', workspace], ['.', workspace],
        ['retest-dir', child], ['./retest-dir', child], ['retest-dir/../retest-dir', child], [child, child],
      ]) {
        const value = await execute({ command: 'pwd -P', workdir })
        assert.equal(value.exitCode, 0, JSON.stringify(value))
        assert.equal(value.stdout.text.trim(), expected, `workdir=${JSON.stringify(workdir)}`)
      }
      const marker = path.join(helper, 'must-not-run')
      const file = path.join(workspace, 'not-a-directory')
      fs.writeFileSync(file, 'file')
      for (const workdir of ['missing', 'not-a-directory', path.join(workspace, 'absent')]) {
        await assert.rejects(() => execute({ command: 'touch must-not-run', workdir }), error => {
          assert.match(error.message, /invalid workdir: must be an existing directory/)
          assert.ok(error.message.includes(path.resolve(workspace, workdir)), error.message)
          assert.doesNotMatch(error.message, /bash executable|provision-shells/)
          return true
        })
      }
      assert.equal(fs.existsSync(marker), false)
      assert.equal(fs.existsSync(path.join(workspace, 'must-not-run')), false)
      // Moving the command directory must not move the authoritative workspace boundary.
      assert.equal(ctx.get('sandboxPolicy').resolve({ session: agent.session }).workspaceRoot, workspace)
    })
  } finally {
    process.chdir(previousCwd)
    await shutdown(ctx)
  }
})

report('linux-shell')
