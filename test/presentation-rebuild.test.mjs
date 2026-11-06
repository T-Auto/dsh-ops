/** Host-owned admission replaces recursive assembly rebuilds. */
import { fixture } from './lib/discovery-admission.mjs'
import { selectExecutor } from './lib/executor.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { shutdown } from './lib/host.mjs'
await test('two presentation consumers cannot recursively rebuild one model request', () => withTempDir('presentation-rebuild', async root => {
  const { ctx, mint, capture } = await fixture(root)
  try {
    ctx.provide('ptcRuntime', { language: 'typescript' })
    const owner = await mint()
    let passes = 0
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => { ++passes; return next() })
    for (const mode of ['native', 'ptc', 'native']) {
      const lift = selectExecutor(owner.ctx, mode)
      const before = passes, step = await capture(owner)
      try {
        assert.equal(passes - before, 2, 'one admission probe and one provider assembly, no rebuild')
        assert.deepEqual(step.assembly.tools.map(t => t.name), mode === 'ptc' ? ['run_code'] : ['ops_discover_tools'])
      } finally { step.dispose(); lift() }
    }
  } finally { await shutdown(ctx) }
}))
report('presentation-rebuild')
