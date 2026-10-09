/** Dependency-free strict settings and structural host form descriptor. */
export const AUTO_COMPACT_DEFAULTS = Object.freeze({ thresholdPercent: 50, cooldownSeconds: 120, timeoutSeconds: 120 })
const LIMITS = Object.freeze({ thresholdPercent: [1, 99], cooldownSeconds: [30, 3600], timeoutSeconds: [10, 600] })
const WRITE = Symbol.for('cosmokit.volatile.write')

export function resolveAutoCompactConfig(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new TypeError('dsh-ops auto-compact config must be a plain object')
  }
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(LIMITS, key)) throw new TypeError(`dsh-ops auto-compact: unknown config key ${key}`)
  }
  return Object.fromEntries(Object.entries(AUTO_COMPACT_DEFAULTS).map(([key, fallback]) => {
    const raw = input[key]
    const value = raw !== null && typeof raw === 'object' && WRITE in raw ? raw.get() : raw === undefined ? fallback : raw
    const [min, max] = LIMITS[key]
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new TypeError(`dsh-ops auto-compact: ${key} must be an integer between ${min} and ${max}`)
    }
    return [key, value]
  }))
}

/**
 * Standard Schema validation plus a serializable structural descriptor, not a
 * Schemastery instance or vendor impersonation. The host rehydrates with its OWN
 * library. No loading-time host values are imported. Live references implement
 * the shared cosmokit.volatile.write protocol and are validated before updates.
 */
export function createAutoCompactConfigSchema() {
  const dict = Object.fromEntries(Object.entries(AUTO_COMPACT_DEFAULTS).map(([key, value]) => [key, {
    type: 'number',
    meta: { default: value, min: LIMITS[key][0], max: LIMITS[key][1], step: 1, volatile: true },
    toJSON() { return { type: this.type, meta: { ...this.meta } } },
  }]))
  return {
    type: 'object', meta: { default: {} }, dict,
    '~standard': {
      version: 1, vendor: 'dsh-ops',
      validate(input) {
        try {
          const value = Object.fromEntries(Object.entries(resolveAutoCompactConfig(input)).map(([key, initial]) => {
            let current = initial
            return [key, Object.freeze({ get: () => current, [WRITE]: next => { current = next } })]
          }))
          return { value }
        } catch (error) { return { issues: [{ message: error.message }] } }
      },
    },
    toJSON() {
      const refs = { 0: { type: 'object', meta: { default: {} }, dict: {} } }
      Object.entries(dict).forEach(([key, node], index) => {
        refs[0].dict[key] = index + 1
        refs[index + 1] = { type: node.type, meta: { ...node.meta } }
      })
      return { uid: 0, refs }
    },
  }
}
