/**
 * DeepSeek's published token prices, used to turn benchmark usage buckets into money.
 *
 * The report prices the **off-peak** column only: the benchmark asks what a run
 * would cost at the cheaper window, not what a charge at a particular wall-clock
 * instant happened to be. Prices are CNY per 1M tokens, copied from
 * {@link PRICING_SOURCE} on {@link PRICING_AS_OF}. DeepSeek bills cache-hit and
 * cache-miss input separately and does not publish a cache-write rate, so the three
 * buckets the report shows (input, cache read, output) are also the three it prices.
 *
 * @module dsh-ops/bench/pricing
 */

/** Where the rates come from. */
export const PRICING_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'
/** The date the rates below were read from the page. */
export const PRICING_AS_OF = '2026-10-27'
/** Rates are quoted per this many tokens. */
const PER_MILLION = 1_000_000

/** Off-peak CNY per 1M tokens, keyed by the canonical model id. */
const OFF_PEAK = Object.freeze({
  'deepseek-flash': Object.freeze({ cacheMiss: 1, cacheHit: 0.02, output: 4 }),
  'deepseek-v4-pro': Object.freeze({ cacheMiss: 4.5, cacheHit: 0.15, output: 13.5 }),
})

/** Historical ids that bill as one of the canonical models above. */
const ALIASES = Object.freeze({
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-1-flash': 'deepseek-flash',
  'deepseek-v4-1-flash-economy': 'deepseek-flash',
})

/** The canonical models accepted by `--pricing-model`. */
export const PRICING_MODELS = Object.freeze(Object.keys(OFF_PEAK))

/** Whether a value is a usable bucket count. */
const usable = (value) => Number.isFinite(value) ? value : null

/**
 * Resolve one model's off-peak rates.
 * @param {string} [model] - canonical id or a historical alias (default `deepseek-flash`).
 * @returns {{model: string, cacheMiss: number, cacheHit: number, output: number, source: string, asOf: string}} the rates.
 * @throws {Error} when the id is not priced.
 */
export function pricingFor(model = 'deepseek-flash') {
  const canonical = ALIASES[model] ?? model
  const rates = OFF_PEAK[canonical]
  if (!rates) throw new Error(`unknown pricing model "${model}"; choose one of ${PRICING_MODELS.join(', ')}`)
  return { model: canonical, ...rates, source: PRICING_SOURCE, asOf: PRICING_AS_OF }
}

/**
 * The off-peak cost of one usage slice, in CNY.
 *
 * Returns `null` when any priced bucket is unknown: a missing bucket is not zero,
 * and a partial total must not read as money spent.
 * @param {{input?: number, cacheRead?: number, output?: number}} buckets - token counts.
 * @param {{cacheMiss: number, cacheHit: number, output: number}} rates - CNY per 1M tokens.
 * @returns {number|null} the cost, or null.
 */
export function estimateCost(buckets = {}, rates = pricingFor()) {
  const input = usable(buckets.input)
  const cacheRead = usable(buckets.cacheRead)
  const output = usable(buckets.output)
  if (input === null || cacheRead === null || output === null) return null
  return (input * rates.cacheMiss + cacheRead * rates.cacheHit + output * rates.output) / PER_MILLION
}

/**
 * Render a CNY amount with four decimals, which keeps sub-cent benchmark runs legible.
 * @param {number|null} value - the amount.
 * @returns {string} `n/a` for an unknown amount, else `0.0123` (CNY, no symbol).
 */
export function formatCny(value) {
  if (!Number.isFinite(value)) return 'n/a'
  const sign = value < 0 ? '\u2212' : ''
  return `${sign}${Math.abs(value).toFixed(4)}`
}
