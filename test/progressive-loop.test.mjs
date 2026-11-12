import fs from 'node:fs'
import path from 'node:path'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { requireWorker } from './lib/boundary.mjs'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { bootLoop } from './lib/agent-loop.mjs'
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
report('progressive-loop')
