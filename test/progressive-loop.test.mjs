import fs from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { assert, test, report, withTempDir, PACKAGE_ROOT } from './lib/harness.mjs'
import { requireWorker, WORKER } from './lib/boundary.mjs'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { bootLoop } from './lib/agent-loop.mjs'
import { workerName } from '../lib/execution/runtime.js'
import { bootEntryGroup, enterPtc } from './lib/ptc-entry.mjs'
requireWorker('progressive-loop')
const names = request => request.tools.map(tool => tool.name)
const text = request => JSON.stringify(request.messages)
const sdkCall = code => ({ name: 'run_code', args: { description: 'Exercise next-step SDK publication', code } })

await test('real Native loop exposes discovery at startup and activates exactly in the next provider request', () => withTempDir('native-next-step', async root => {
  fs.writeFileSync(path.join(root, 'note'), 'fixture\n')
  const host = await bootLoop(root)
  try {
    const owner = await host.agent(), sibling = await host.agent()
    let diagnostic = false
    host.ctx.on('tools/execute', async (exec, next) => {
      const result = await next()
      if (exec.name === 'ops_discover_tools') {
        const assembly = await host.ctx.get('systemPrompt').assemble({ scope: owner, toolSet: exec.toolSet })
        assert.equal(assembly.tools.some(tool => tool.name === 'ops_stat'), false, 'current-step diagnostic assembly cannot activate pending tools')
        diagnostic = true
      }
      return result
    })
    const run = await host.run(owner, [request => {
      assert.ok(names(request).includes('ops_discover_tools'), 'discovery must be visible in the first real provider request')
      assert.equal(names(request).includes('ops_stat'), false)
      return [{ name: 'ops_discover_tools', args: { query: 'select:ops_stat' } }]
    }, request => {
      assert.ok(names(request).includes('ops_stat'), 'the second request must already include the selected schema')
      assert.equal(host.ctx.get('tools').executable('ops_stat', sibling), undefined)
      return [{ name: 'ops_stat', args: { path: 'note' } }]
    }, []])
    assert.equal(diagnostic, true); assert.equal(run.requests.length, 3)
    const stat = run.results.find(value => value.exec.name === 'ops_stat').result
    assert.equal(stat.isError, false); assert.equal(stat.value.data.exists, true, JSON.stringify(stat.value))
  } finally { await host.close() }
}))

await test('real PTC loop keeps the current run_code snapshot fixed and publishes the requested SDK at request two', () => withTempDir('ptc-next-step', async root => {
  fs.writeFileSync(path.join(root, 'note'), 'fixture\n')
  const host = await bootLoop(root, { ptcMode: true })
  try {
    const owner = await host.agent(), sibling = await host.agent()
    const run = await host.run(owner, [request => {
      assert.deepEqual(names(request), ['run_code']); assert.doesNotMatch(text(request), /ops_stat:/)
      return [sdkCall("const selected = await tools.ops_load_sdk({tools:['stat']}); let unavailable = false; try { await tools.ops_stat({path:'note'}); } catch { unavailable = true; } return {selected,unavailable};")]
    }, request => {
      assert.deepEqual(names(request), ['run_code']); assert.match(text(request), /ops_stat:/)
      assert.equal(host.ctx.get('tools').executable('ops_stat', sibling), undefined)
      return [sdkCall("return await tools.ops_stat({path:'note'});")]
    }, []])
    const calls = run.results.filter(value => value.exec.name === 'run_code')
    assert.equal(calls.length, 2)
    assert.equal(calls[0].result.isError, false, JSON.stringify(calls[0].result))
    assert.equal(calls[0].result.value.result.selected.status, 'completed')
    assert.equal(calls[0].result.value.result.unavailable, true)
    assert.equal(calls[1].result.value.result.data.exists, true, JSON.stringify(calls[1].result.value))
  } finally { await host.close() }
}))
await test('real committed authority changes cancel pending activation while always-loaded capabilities are ready at startup', () => withTempDir('loop-mode-change', async root => {
  fs.writeFileSync(path.join(root, 'note'), 'unchanged')
  const host = await bootLoop(root, { discoveryConfig: { alwaysLoaded: ['stat'] } })
  try {
    const owner = await host.agent()
    host.ctx.on('tools/execute', async (exec, next) => {
      const result = await next()
      if (exec.name === 'ops_discover_tools') setSandboxMode(owner.session, 'read-only')
      return result
    })
    const run = await host.run(owner, [request => {
      assert.ok(names(request).includes('ops_stat'))
      assert.equal(names(request).includes('ops_edit_file'), false)
      return [{ name: 'ops_discover_tools', args: { query: 'select:ops_edit_file' } }]
    }, request => {
      assert.equal(names(request).includes('ops_edit_file'), false, 'permission change must discard the pending choice before step/end')
      assert.ok(names(request).includes('ops_stat'))
      return []
    }])
    assert.equal(run.requests.length, 2)
    assert.equal(fs.readFileSync(path.join(root, 'note'), 'utf8'), 'unchanged')
  } finally { await host.close() }
}))

/** Card #990: the isolated OPS-PTC entry. Every group boots on its own throwaway
 *  root under this suite's DSH_HOME and is judged by test/lib/ptc-entry.mjs. */
await test('the isolated entry truly routes one OPS-PTC request and records its environment', () => withTempDir('ptc-entry-target', async root => {
  fs.writeFileSync(path.join(root, 'entry-note'), 'fixture line\n')
  const group = await bootEntryGroup(root)
  try {
    assert.equal(group.booted, true, 'the target group must boot on the shipped ops-ptc row')
    const report = await enterPtc(group)
    assert.equal(report.status, 'entered', JSON.stringify(report.findings))
    assert.equal(report.target, 'ops-ptc')
    assert.deepEqual(report.evidence.topLevel, ['run_code'], JSON.stringify(report.evidence))
    assert.equal(report.findings.preset.actual, 'ops-ptc')
    assert.equal(report.findings.preset.mode, 'ops-ptc')
    assert.equal(report.environment.agentPreset, 'ops-ptc')
    assert.match(report.environment.plugin.commit, /^[0-9a-f]{40}$/)
    assert.match(report.environment.host.version, /^\d+\.\d+\.\d+/)
    assert.equal(report.environment.platform, process.platform + '-' + process.arch)
    assert.equal(report.environment.sandbox.mode, 'workspace-write')
    assert.equal(report.environment.provider, 'scripted', 'the scripted provider is marked on the report, never silent')
    assert.equal(report.environment.networkModelRequests, 0)
    // The shipped row's real defaults are recorded from the resolved config, not assumed.
    assert.equal(report.environment.switches.batchingGuidance, true)
    assert.equal(report.environment.switches.residentTools, true)
    assert.equal(report.environment.switches.dynamicTools, true)
    // The worker fact: the recorded digest is the digest of the binary this group used.
    assert.match(report.environment.worker.sha256, /^[0-9a-f]{64}$/)
    assert.equal(report.environment.worker.sha256, createHash('sha256').update(fs.readFileSync(WORKER)).digest('hex'))
    const staged = report.environment.worker.staged
    if (staged !== null) {
      assert.equal(staged.target, report.environment.platform)
      assert.equal(staged.sha256, createHash('sha256').update(fs.readFileSync(
        path.join(PACKAGE_ROOT, 'runtime', report.environment.platform, workerName()))).digest('hex'),
        'the recorded staged receipt matches the staged binary')
    }
    // The resident SDK really answered through the worker; a fresh fixture file, nothing real.
    const executed = report.evidence.executed
    assert.equal(executed.isError, false, JSON.stringify(executed))
    assert.equal(executed.value.result.status, 'completed')
  } finally { await group.close() }
}))

await test('Standard routing is the deliberate counter-example: invalid with a reason, never comparable', () => withTempDir('ptc-entry-standard', async root => {
  const group = await bootEntryGroup(root, { preset: 'standard' })
  try {
    assert.equal(group.booted, true)
    const report = await enterPtc(group)
    assert.equal(report.status, 'invalid')
    assert.equal(report.reason, 'preset', JSON.stringify(report.findings))
    assert.equal(report.findings.preset.actual, 'standard')
    assert.equal(report.findings.preset.mode, 'standard')
    assert.equal(report.findings.route.ok, false)
    assert.equal(report.findings.route.topLevel.includes('run_code'), false)
    // The refusal is explicit and carries no surface that could be mistaken for a result.
    assert.equal('evidence' in report, false)
    assert.deepEqual(Object.keys(report).sort(), ['environment', 'findings', 'reason', 'status', 'target'])
    assert.equal(JSON.stringify(report).includes('Bytes'), false)
  } finally { await group.close() }
}))

await test('a PTC preset on a native executor is route-unknown, not a quiet pass', () => withTempDir('ptc-entry-route', async root => {
  const group = await bootEntryGroup(root, { executor: 'native' })
  try {
    assert.equal(group.booted, true)
    const report = await enterPtc(group)
    assert.equal(report.status, 'invalid')
    assert.equal(report.reason, 'route', JSON.stringify(report.findings))
    assert.equal(report.findings.preset.ok, true, 'the preset is right; the transport is what is unknown')
    assert.equal(report.findings.route.topLevel.includes('run_code'), false)
    assert.equal('evidence' in report, false)
  } finally { await group.close() }
}))

await test('a group without an executable worker reports invalid before any request', () => withTempDir('ptc-entry-worker', async root => {
  const group = await bootEntryGroup(root, { worker: path.join(root, 'no-such-worker') })
  assert.equal(group.booted, false)
  const report = await enterPtc(group)
  assert.equal(report.status, 'invalid')
  assert.equal(report.reason, 'worker')
  assert.match(report.findings.worker.detail, /Native worker/)
  assert.equal('evidence' in report, false)
}))
report('progressive-loop')
