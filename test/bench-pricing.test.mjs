/** Off-peak DeepSeek rates and the `--pricing-model` wiring that selects them. */
import { assert, report, test } from './lib/harness.mjs'
import { parseArgs } from '../bench/compare.mjs'
import { PRICING_AS_OF, PRICING_SOURCE, estimateCost, formatCny, pricingFor } from '../bench/lib/pricing.mjs'

await test('off-peak rates price cache-miss, cache-hit and output buckets separately', () => {
  const flash = pricingFor()
  assert.equal(flash.model, 'deepseek-flash')
  assert.deepEqual([flash.cacheMiss, flash.cacheHit, flash.output], [1, 0.02, 4])
  assert.equal(estimateCost({ input: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 }, flash), 5.02)
  const pro = pricingFor('deepseek-v4-pro')
  assert.deepEqual([pro.cacheMiss, pro.cacheHit, pro.output], [4.5, 0.15, 13.5])
  assert.equal(estimateCost({ input: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 }, pro), 18.15)
  assert.equal(pricingFor('deepseek-v4-1-flash').model, 'deepseek-flash', 'a benchmark model id resolves to the published rate card')
  assert.equal(PRICING_AS_OF, '2026-10-27')
  assert.match(PRICING_SOURCE, /^https:\/\/api-docs\.deepseek\.com\//)
  assert.throws(() => pricingFor('gpt-4o'), /unknown pricing model/)
})
await test('a missing bucket means unknown money, never zero', () => {
  assert.equal(estimateCost({ input: 1000, cacheRead: null, output: 100 }, pricingFor()), null)
  assert.equal(formatCny(null), 'n/a')
  assert.equal(formatCny(0.0019), '0.0019')
  assert.equal(formatCny(-0.0019), '\u22120.0019')
})
await test('--pricing-model chooses the rate card and rejects unknown models', () => {
  assert.equal(parseArgs(['base', 'cand']).pricingModel, 'deepseek-flash')
  assert.equal(parseArgs(['base', 'cand', '--pricing-model', 'deepseek-v4-pro']).pricingModel, 'deepseek-v4-pro')
  assert.throws(() => parseArgs(['base', 'cand', '--pricing-model', 'unknown']), /--pricing-model/)
})
report('bench-pricing')
