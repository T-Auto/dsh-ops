import { updateContinuation } from '../lib/discovery/controller.js'
import { assert, test } from './lib/harness.mjs'

await test('internal/update continuation resolves on both cordis arities', () => {
  const next = () => undefined
  // cordis <= 4.0.5 emits (config, noSave, next)
  assert.equal(updateContinuation([false, next]), next)
  assert.equal(updateContinuation([true, next]), next)
  // cordis >= 4.0.6-alpha drops noSave and emits (config, next)
  assert.equal(updateContinuation([next]), next)
})
