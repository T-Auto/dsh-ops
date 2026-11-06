/** Every exact resolve owns its presentation memo; notifications spend no eager probes. */
import fs from 'node:fs'
import path from 'node:path'
import { fixture } from './lib/discovery-admission.mjs'
import { withToolChange } from '../lib/tool-changes.js'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { shutdown } from './lib/host.mjs'
await test('attributed and unknown changes are lazy, repeated resolves do not reuse stale mode verdicts', () => withTempDir('memo', async root => {
  const { ctx, mint, names, probes } = await fixture(root)
  try {
    const owner = await mint(), other = await mint()
    probes.clear()
    await withToolChange([{}], () => ctx.serial('tools/change', {}))
    await ctx.serial('tools/change', {})
    assert.equal(probes.size, 0)
    for (let i = 1; i <= 3; i++) {
      assert.ok((await names(owner)).includes('ops_discover_tools'))
      assert.equal(probes.get(owner), i, 'one mode probe shared across all candidates in each resolve')
      assert.equal(probes.get(other), undefined)
    }
  } finally { await shutdown(ctx) }
}))
await test('live cwd changes are observed without a session header event or sibling creation', () => withTempDir('memo-cwd', async root => {
  const { ctx, mint, call } = await fixture(root, { alwaysLoaded: ['stat'] })
  try {
    const changed = path.join(root, 'changed'); fs.mkdirSync(changed)
    fs.writeFileSync(path.join(root, 'note'), 'before'); fs.writeFileSync(path.join(changed, 'note'), 'after-change')
    const agent = await mint()
    assert.equal((await call(agent, 'ops_stat', { path: 'note' })).value.data.bytes, 6)
    // Change the actual authoritative service, leaving the serialized header untouched.
    const service = ctx.get('workingDirectory'), original = service.get, ensure = service.ensure
    service.get = () => changed; service.ensure = async () => changed
    try {
      assert.equal((await call(agent, 'ops_stat', { path: 'note' })).value.data.bytes, 12)
      assert.equal(agent.session.header.cwd, root)
    } finally { service.get = original; service.ensure = ensure }
  } finally { await shutdown(ctx) }
}))
report('discovery-probe-memo')
