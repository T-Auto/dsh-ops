/** Family registration is stable; admission is local to the requesting model step. */
import { fixture } from './lib/discovery-admission.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { shutdown } from './lib/host.mjs'
await test('unknown changes do not eagerly traverse a family or replace its definitions', () => withTempDir('lazy-family', async root => {
  const { ctx, probes, mint, names } = await fixture(root)
  try {
    const parent = await mint(), children = []
    for (let i = 0; i < 3; i++) children.push(await mint(parent))
    const family = [parent, ...children]
    const definitions = family.map(agent => ctx.tools.get('ops_discover_tools', agent))
    probes.clear()
    await ctx.serial('tools/change', {})
    assert.equal(probes.size, 0, 'notifications never eagerly assemble live sessions')
    for (let i = 0; i < family.length; i++) {
      assert.ok((await names(family[i])).includes('ops_discover_tools'))
      assert.equal(ctx.tools.get('ops_discover_tools', family[i]), definitions[i])
    }
    assert.ok([...probes.values()].every(count => count === 1), 'one mode inspection per resolve, not per candidate')
  } finally { await shutdown(ctx) }
}))
report('lazy-family')
