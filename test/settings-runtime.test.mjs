/** Runtime controls cross the real host gateway; installers are never invoked by this suite. */
import fs from 'node:fs'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Registry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { RuntimeActions } from '../lib/settings/runtime-actions.js'
import { RUNTIME_DESCRIPTORS } from '../lib/settings/runtime-contract.js'
import { runtimeProcessRunner, mountRuntimeSettings } from '../lib/settings/runtime-host.js'
import { assert, test, report, TEST_HOME } from './lib/harness.mjs'
import { ownerPeer } from './lib/peer.mjs'
const active = () => new AbortController().signal
const fixture = label => { const home = path.join(TEST_HOME, label); fs.mkdirSync(home, { recursive: true }); return { DSH_HOME: home } }
const success = async () => ({ started: true, exitCode: 0, signal: null })
function managed(env, version, owned = true) {
  const directory = path.join(env.DSH_HOME, 'dsh-ops/shells/bash', version)
  fs.mkdirSync(path.join(directory, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(directory, 'bin/bash.exe'), 'fixture')
  if (owned) fs.writeFileSync(path.join(directory, '.provisioned.json'), JSON.stringify({ schemaVersion: 1, name: 'bash', version, sha256: 'a'.repeat(64) }))
  return directory
}
function options(label, extra = {}) { return { env: fixture(label), platform: 'win32', arch: 'x64', run: success, ...extra } }

await test('runtime previews never start a process and unknown/unavailable actions stay refused', async () => {
  let calls = 0
  const service = new RuntimeActions(options('previews', { run: async () => { calls++; return success() } }))
  const plan = service.plan('install-bash')
  assert.equal(plan.available, true)
  assert.match(plan.details.join(' '), /SHA-256/)
  assert.equal(calls, 0)
  assert.equal(service.plan('remove-bash').available, false)
  assert.throws(() => service.plan('command'), /Expected one of/)
  assert.throws(() => service.select('system'), /Expected one of/)
  const unsupported = new RuntimeActions(options('posix', { platform: 'linux' }))
  assert.equal(unsupported.plan('install-bash').available, false)
  assert.equal(unsupported.plan('upgrade-pwsh').available, false)
  assert.equal((await service.execute('unknown', active())).effectState, 'none')
  assert.equal(calls, 0)
})
await test('a reviewed install uses the fixed absolute CLI and a one-use plan', async () => {
  const calls = []
  const service = new RuntimeActions(options('fixed-install', { run: async (argv, signal) => { calls.push({ argv, signal }); return success() } }))
  const plan = service.plan('install-bash')
  const result = await service.execute(plan.id, active())
  assert.equal(result.status, 'completed')
  assert.equal(result.effectState, 'applied')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].argv[0], process.execPath)
  assert.ok(path.isAbsolute(calls[0].argv[1]))
  assert.deepEqual(calls[0].argv.slice(2), ['bash-runtime', 'install'])
  assert.equal((await service.execute(plan.id, active())).status, 'stale')
  assert.equal(calls.length, 1)
})
await test('changed inventory and expired previews cannot install or remove anything', async () => {
  let now = 10, calls = 0
  const opts = options('stale-plan', { now: () => now, run: async () => { calls++; return success() } })
  const service = new RuntimeActions(opts)
  const install = service.plan('install-bash')
  const custom = managed(opts.env, 'custom', false)
  assert.equal((await service.execute(install.id, active())).status, 'stale')
  assert.equal(service.plan('install-bash').available, false)
  assert.match(service.plan('install-bash').reason, /Unowned/)
  const old = managed(opts.env, '1.0.0')
  const removal = service.plan('remove-bash')
  now += 600_001
  assert.equal((await service.execute(removal.id, active())).status, 'stale')
  assert.ok(fs.existsSync(old)); assert.ok(fs.existsSync(custom)); assert.equal(calls, 0)
})
await test('reviewed removal deletes only managed receipt-owned directories', async () => {
  const opts = options('remove-reviewed'), service = new RuntimeActions(opts)
  const owned = managed(opts.env, '1.0.0'), unowned = managed(opts.env, 'user-copy', false)
  const plan = service.plan('remove-bash')
  assert.ok(plan.details.some(line => line.includes(owned)))
  assert.ok(plan.details.some(line => line.includes('Keep unowned directory')))
  assert.ok(fs.existsSync(owned))
  const result = await service.execute(plan.id, active())
  assert.equal(result.status, 'completed')
  assert.equal(fs.existsSync(owned), false)
  assert.ok(fs.existsSync(path.join(unowned, 'bin/bash.exe')))
})
await test('pre-cancel does not spawn; component disposal cancels and awaits running work', async () => {
  let started = 0, settled = false
  const service = new RuntimeActions(options('cancel', { run: async (_argv, signal) => {
    started++
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    settled = true
    return { started: true, exitCode: null, signal: 'aborted' }
  } }))
  const controller = new AbortController(); controller.abort()
  assert.equal((await service.execute(service.plan('install-bash').id, controller.signal)).status, 'cancelled')
  assert.equal(started, 0)
  const pending = service.execute(service.plan('install-bash').id, active())
  assert.equal(started, 1)
  assert.equal((await service.execute(service.plan('install-bash').id, active())).status, 'busy')
  await service.dispose()
  assert.equal(settled, true)
  const result = await pending
  assert.equal(result.status, 'cancelled'); assert.equal(result.effectState, 'unknown')
})
await test('PowerShell upgrade uses the standard fixed WinGet plan and preserves failure facts', async () => {
  const opts = options('pwsh'), binary = path.join(opts.env.DSH_HOME, 'Microsoft/WindowsApps/winget.exe')
  fs.mkdirSync(path.dirname(binary), { recursive: true }); fs.writeFileSync(binary, 'not executed')
  opts.env.LOCALAPPDATA = opts.env.DSH_HOME
  let argv
  opts.run = async value => { argv = value; return { started: true, exitCode: -1978335189, signal: null } }
  const service = new RuntimeActions(opts), plan = service.plan('upgrade-pwsh')
  assert.match(plan.details.join(' '), /Restart DSH/)
  assert.match(plan.details.join(' '), /pwshPath/)
  const result = await service.execute(plan.id, active())
  assert.deepEqual(argv, [binary, 'install', '--id', 'Microsoft.PowerShell', '--exact', '--source', 'winget', '--installer-type', 'wix'])
  assert.equal(result.status, 'no-update'); assert.equal(result.effectState, 'none')
})
await test('real gateway validates exact named inputs before action and withdraws the scoped definitions', async () => {
  const ctx = new Context(); ctx.logger.level = 0
  let calls = 0
  try {
    // rc.5 loads the gateway only once `remoteAccess` is present: the Host's own
    // policy hook is what admits or refuses every non-owner Remote call. These
    // fixture calls are owner-level, so the hook always allows.
    ctx.provide('remoteAccess', { decide: () => ({ kind: 'allow' }) })
    await ctx.plugin(Registry); await ctx.plugin(Gateway, {})
    const service = new RuntimeActions(options('gateway', { run: async () => { calls++; return success() } }))
    const fiber = await ctx.plugin({ inject: ['typert'], apply(inner) {
      inner.provide('opsSettings', service)
      inner.typert.register({ package: 'dsh-ops', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: RUNTIME_DESCRIPTORS })
      inner.effect(() => () => service.dispose())
    } })
    // rc.5 requires every `invoke` to name the Peer it speaks for; this fixture
    // is the Host itself, so the Peer is an owner with no live client stream.
    const peer = ownerPeer(ctx, active())
    const invoke = (method, args) => ctx.typertGateway.invoke({ namespace: 'opsSettings', method, args, peer })
    await assert.rejects(invoke('plan', { action: 'command' }), /failed boundary validation/)
    await assert.rejects(invoke('plan', { action: 'install-bash', command: 'arbitrary' }), /unexpected/)
    await assert.rejects(invoke('execute', { id: 'not-a-plan' }), /failed boundary validation/)
    const plan = await invoke('plan', { action: 'install-bash' })
    assert.equal(calls, 0)
    assert.equal((await invoke('execute', { id: plan.id })).status, 'completed')
    assert.equal(calls, 1)
    await fiber.dispose()
    await assert.rejects(invoke('snapshot', {}), /withdrawn/)
  } finally { await ctx.fiber.dispose() }
})
await test('actual host subprocess runs an absolute child and scrubs ambient DSH values', async () => {
  const ctx = new Context(); ctx.logger.level = 0
  try {
    await ctx.plugin(Subprocess, {})
    const env = fixture('real-subprocess'), runner = runtimeProcessRunner(ctx.subprocess, env)
    const script = path.join(env.DSH_HOME, 'child.cjs'), output = path.join(env.DSH_HOME, 'child.json')
    fs.writeFileSync(script, `require('node:fs').writeFileSync(process.argv[2], JSON.stringify({home:process.env.DSH_HOME, secret:process.env.DSH_OPS_SETTINGS_TEST_SECRET}));`)
    const before = process.env.DSH_OPS_SETTINGS_TEST_SECRET
    process.env.DSH_OPS_SETTINGS_TEST_SECRET = 'must-not-forward'
    try {
      const result = await runner([process.execPath, script, output], active())
      assert.equal(result.exitCode, 0)
      assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), { home: env.DSH_HOME })
      assert.match((await runner(['relative.exe'], active())).error, /absolute executable/)
    } finally { if (before === undefined) delete process.env.DSH_OPS_SETTINGS_TEST_SECRET; else process.env.DSH_OPS_SETTINGS_TEST_SECRET = before }
  } finally { await ctx.fiber.dispose() }
})
await test('the shell settings seam waits for host services and owns its teardown', async () => {
  const ctx = new Context(); ctx.logger.level = 0
  try {
    const mounted = await ctx.plugin({ apply: mountRuntimeSettings })
    assert.equal(ctx.get('opsSettings'), undefined)
    await ctx.plugin(Registry); await ctx.plugin(Subprocess, {}); await ctx.plugin(Gateway, {})
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(ctx.get('opsSettings'))
    assert.ok(ctx.typert.local.get('opsSettings/plan'))
    await mounted.dispose()
    assert.equal(ctx.get('opsSettings'), undefined)
    assert.equal(ctx.typert.local.get('opsSettings/plan'), undefined)
  } finally { await ctx.fiber.dispose() }
})
await test('managed selection returns an absolute setting and reports restricted-mode incompatibility', () => {
  const opts = options('select-managed'), service = new RuntimeActions(opts)
  const directory = managed(opts.env, '2.56.0.2')
  const selected = service.select('managed')
  assert.equal(selected.bashPath, path.join(directory, 'bin/bash.exe'))
  assert.ok(path.isAbsolute(selected.bashPath))
  assert.match(selected.restriction, /verified|restricted|restricted-mode|MSYS|compatib/i)
  assert.deepEqual(service.snapshot().managed.map(entry => entry.version), ['2.56.0.2'])
})
await test('installer failures never report applied effects without successful startup', async () => {
  for (const [label, facts, effect] of [
    ['missing', { started: false, exitCode: 0, signal: null, error: 'could not spawn' }, 'none'],
    ['partial', { started: true, exitCode: 2, signal: null }, 'unknown'],
  ]) {
    const service = new RuntimeActions(options(label, { run: async () => facts }))
    const result = await service.execute(service.plan('install-bash').id, active())
    assert.equal(result.status, 'failed')
    assert.equal(result.effectState, effect)
  }
})
report('settings-runtime')
