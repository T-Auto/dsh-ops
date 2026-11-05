import { onInternalUpdate } from '../lib/discovery/index.js'
import { assert, test, report } from './lib/harness.mjs'

// cordis <= 4.0.5 dispatched (config, noSave, next); >= 4.0.6-alpha dropped
// noSave and dispatches (config, next). This listener is { global: true,
// prepend: true }, so a broken continuation aborts every settings.update in the
// profile, not just this plugin's own writes.
await test('internal/update listener continues on both cordis arities', async () => {
  let refreshed = 0
  const listener = onInternalUpdate(() => { refreshed += 1 })

  // cordis <= 4.0.5
  assert.equal(await listener({ a: 1 }, false, async () => 'tail'), 'tail')
  // cordis >= 4.0.6-alpha / 4.1.x
  assert.equal(await listener({ a: 1 }, async () => 'tail'), 'tail')
  // A dispatch without a continuation must not throw, and must still refresh.
  assert.equal(await listener({ a: 1 }), undefined)
  assert.equal(refreshed, 3)
})

await test('the previous positional form is the regression this pins', async () => {
  const legacy = async (_config, _noSave, next) => { await next() }
  await assert.rejects(() => legacy({ a: 1 }, async () => 'tail'), /next is not a function/u)
})

report('internal-update-contract')
