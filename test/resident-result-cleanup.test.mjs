/** Real public host teardown, including fire-and-forget Session notifications. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import * as Bundle from '../lib/index.js'
import { integration, residentKernel } from '../lib/integration/index.js'
import { workerEnvelope } from '../lib/execution/protocol.js'
import { resultStorage } from '../lib/kernel/result-storage.js'
import { listPendingCleanup, setCleanupRegistryDir } from '../lib/kernel/result-cleanup-registry.js'
import { expireResultSession, retryDeferredResultCleanup, withResultSession } from '../lib/kernel/result-lifecycle.js'
import { createResidentTaskJobs } from './lib/resident-task-jobs.mjs'
import { assert, test, report, waitFor, withTempDir } from './lib/harness.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'

requireWorker('resident-result-cleanup')
const quiet = {
  ...Object.fromEntries(['minimal', 'standard', 'ptc', 'ops-ptc', 'cordis', 'discovery',
    'download-guard', 'resultCache', 'panel', 'tui', 'disk'].map(name => [name, { enabled: false }])),
  global: { bash: false, hidePwsh: false, hideOfficialTools: false, forceDefaultOpsPtc: false },
  other: { pwsh7Link: false },
}
const options = { profile: 'native', binaryPath: WORKER, required: true, shell: false,
  residentNames: ['inspect_local_file'], discovery: false, promptPolicy: false }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

async function fixture(root, standalone) {
  setCleanupRegistryDir(path.join(root, 'registry'))
  const host = await createResidentTaskJobs({ cwd: root, initialAgents: 0 }), starts = [], purges = []
  const { ctx } = host
  class Observed extends Subprocess {
    spawn(spec) { const handle = super.spawn(spec); starts.push({ argv: [...spec.argv], handle }); return handle }
  }
  await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: root })
  await ctx.plugin(Observed); await ctx.plugin(Sandbox)
  const errors = []
  for (const [service, name] of [['sandboxPolicy', 'resolve'], ['sandbox', 'confine']]) {
    const value = ctx.get(service), original = value[name].bind(value)
    value[name] = (...args) => {
      try {
        const result = original(...args)
        return result?.catch ? result.catch(error => { errors.push(String(error.stack)); throw error }) : result
      } catch (error) { errors.push(String(error.stack)); throw error }
    }
  }
  let provider, first, second
  if (standalone) {
    provider = await ctx.plugin(residentKernel({ binaryPath: WORKER }))
    first = await ctx.plugin(integration({ preset: 'cleanup-a', ...options }))
    second = await ctx.plugin(integration({ preset: 'cleanup-b', ...options }))
  } else provider = await ctx.plugin(Bundle, { ...quiet, presets: { 'cleanup-a': options, 'cleanup-b': options } })
  const client = ctx.get('opsKernel'), original = client.purgeResults.bind(client), entered = deferred(), gate = deferred()
  let held = false
  client.purgeResults = async (...args) => {
    entered.resolve()
    if (held) await gate.promise
    const value = await original(...args)
    purges.push({ value, cacheEmpty: fs.readdirSync(path.join(args[2].root,
      `s-${createHash('sha256').update(args[1]).digest('hex')}`)).every(name => !name.endsWith('.json')) })
    return value
  }
  async function create(preset) {
    const handle = await host.createAgent({ meta: { cwd: root, agentPreset: preset } })
    await waitFor(() => ctx.get('tools').get('ops_inspect_local_file', handle.agent), { what: 'public file tool' })
    return handle
  }
  async function read(handle) {
    const result = await host.execute('ops_inspect_local_file', { path: 'large.txt' }, { agent: handle.agent })
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.ok(result.value.data.reference, JSON.stringify(result.value).slice(0, 1500))
    const session = handle.agent.session, policy = ctx.get('sandboxPolicy').resolve({ session })
    const storage = await resultStorage(ctx, session, handle.agent, WORKER, 'inspect_local_file', policy, [], false)
    const cache = path.join(storage.root, `s-${createHash('sha256').update(session.id).digest('hex')}`)
    assert.ok(fs.readdirSync(cache).some(name => name.endsWith('.json')))
    return cache
  }
  return { ...host, starts, purges, provider, first, second, client, create, read, entered, gate, errors,
    hold() { held = true }, release() { gate.resolve() } }
}

for (const standalone of [false, true]) await test(`${standalone ? 'shared standalone provider' : 'package root'} joins real session purges before stopping its only worker`, () => withTempDir('resident-purge', async root => {
  fs.writeFileSync(path.join(root, 'large.txt'), 'x'.repeat(180000))
  fs.writeFileSync(path.join(root, 'durable.txt'), 'keep')
  const host = await fixture(root, standalone)
  let closing
  try {
    const one = await host.create('cleanup-a'), two = await host.create('cleanup-b')
    await host.read(one); await host.read(two)
    if (standalone) {
      await host.first.dispose()
      assert.equal(host.client.available, true)
      await host.read(two)
    }
    assert.equal(host.starts.length, 1, 'all public file calls share one kernel')
    assert.deepEqual(host.starts[0].argv, [WORKER, '--serve'])
    host.hold()
    // Agent disposal triggers actual SessionStore's non-awaited session/disposed event.
    const notification = one.dispose()
    await host.entered.promise
    let finished = false
    closing = (standalone ? host.provider.dispose() : host.ctx.fiber.dispose()).then(() => { finished = true })
    await waitFor(() => !host.client.available, { what: 'ordinary kernel admission closes' })
    await assert.rejects(host.client.invoke(workerEnvelope('ptc', { root, scope: 'late', tool: 'stat', args: { path: 'large.txt' } }, 1000)), /unavailable/)
    await assert.rejects(withResultSession(host.ctx, { id: 'late' }, undefined,
      async () => assert.fail('closing result owner accepted new work')), /closing/)
    assert.equal(finished, false, 'provider disposal must join the pending purge')
    assert.equal(host.purges.length, 0)
    host.release(); await Promise.all([notification, closing])
    assert.equal(host.purges.length, 2, `both exact Session owners are purged once: ${JSON.stringify({ errors: host.errors, pending: listPendingCleanup().filter(value => value.workspaceRoot === root) })}`)
    assert.ok(host.purges.every(item => item.value.value.status === 'completed' && item.cacheEmpty))
    assert.equal(host.starts.length, 1, 'teardown must not launch a one-shot purge worker')
    assert.equal(host.client.available, false)
    assert.equal(await host.starts[0].handle.waitForExit(), true)
    assert.equal(fs.readFileSync(path.join(root, 'durable.txt'), 'utf8'), 'keep')
  } finally { host.release(); await closing; await host.dispose(); setCleanupRegistryDir(undefined) }
}))

await test('resident purge refuses a replaced session directory and preserves the external target', () => withTempDir('resident-purge-link', async root => {
  fs.writeFileSync(path.join(root, 'large.txt'), 'x'.repeat(180000))
  const host = await fixture(root, true)
  let cache, moved
  try {
    const handle = await host.create('cleanup-a')
    cache = await host.read(handle); moved = `${cache}-held`
    const outside = path.join(root, 'outside'); fs.mkdirSync(outside)
    const sentinel = path.join(outside, '00000000-0000-4000-8000-000000000001.json')
    fs.writeFileSync(sentinel, 'keep outside')
    fs.renameSync(cache, moved); fs.symlinkSync(outside, cache, process.platform === 'win32' ? 'junction' : 'dir')
    await expireResultSession(host.ctx, handle.agent.session)
    assert.equal(host.purges.length, 1)
    assert.equal(host.purges[0].value.value.status, 'error')
    assert.equal(host.purges[0].value.value.error.code, 'PATH_RESTRICTED')
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep outside')
    assert.equal(listPendingCleanup().length, 1, 'failed physical cleanup remains explicitly deferred')
    fs.unlinkSync(cache); fs.renameSync(moved, cache); moved = undefined
    assert.equal((await retryDeferredResultCleanup(host.ctx, Date.now() + 60000)).completed, 1)
    assert.deepEqual(listPendingCleanup(), [])
    assert.equal(host.starts.length, 1, 'refusal and retry never fall back to a host worker')
  } finally {
    if (moved) { fs.unlinkSync(cache); fs.renameSync(moved, cache) }
    host.release(); await host.dispose(); setCleanupRegistryDir(undefined)
  }
}))
report('resident-result-cleanup')
