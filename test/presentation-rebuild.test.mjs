/** A presentation withdrawal may rebuild once per request, never in turns (#509). */
import { claimPresentationRebuild, isPresentationProbe } from '../lib/presentation.js'
import { assert, test, report } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'

await test('a rebuild claim is per request identity and never repeats', () => {
  const context = { scope: {} }
  assert.equal(claimPresentationRebuild(context), true, 'the first withdrawal in a request may rebuild')
  assert.equal(claimPresentationRebuild(context), false, 'the same request must not rebuild again')
  assert.equal(claimPresentationRebuild(context), false, 'and still not on a third pass')
  const next = { scope: {} }
  assert.equal(claimPresentationRebuild(next), true, 'a new request carries its own budget')
})

await test('two hooks that both retire tools in one assembly rebuild once, not in turns', async () => {
  const { ctx } = await bootHost()
  try {
    const passes = new Map()
    // Two hooks with the same shape as publication/ptc.ts and discovery/controller.ts:
    // each one decides to retire something and wants a fresh assembly afterwards.
    // Without a shared budget the first hook rebuilds, the second hook rebuilds
    // inside that rebuild, and the pair never stops.
    for (const label of ['alpha', 'beta']) {
      ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
        passes.set(label, (passes.get(label) ?? 0) + 1)
        const result = await next()
        if (isPresentationProbe(context)) return result
        return claimPresentationRebuild(context) ? ctx.systemPrompt.assemble(context) : result
      })
    }
    const assembly = await ctx.systemPrompt.assemble({ scope: {} })
    assert.ok(assembly !== undefined)
    // One request plus the one allowed rebuild. Unbounded behaviour showed up here
    // as a hook count that kept climbing instead of settling at two.
    assert.equal(passes.get('alpha'), 2, `alpha hook ran ${passes.get('alpha')} times`)
    assert.equal(passes.get('beta'), 2, `beta hook ran ${passes.get('beta')} times`)
  } finally { await shutdown(ctx) }
})

report('presentation-rebuild')
