/**
 * TEST ONLY: opt one retained pre-merge component mount into legacy behavior.
 * Clone the plugin so its real metadata and implementation remain intact. The
 * retirement guard runs synchronously in apply; never hold the process-wide
 * opt-in across a promise, host boot, or the rest of a test.
 */
export function legacyComponent(plugin) {
  return {
    ...plugin,
    apply(...args) {
      const previous = process.env.DSH_OPS_LEGACY_ROWS
      process.env.DSH_OPS_LEGACY_ROWS = '1'
      try {
        return Reflect.apply(plugin.apply, this, args)
      } finally {
        if (previous === undefined) delete process.env.DSH_OPS_LEGACY_ROWS
        else process.env.DSH_OPS_LEGACY_ROWS = previous
      }
    },
  }
}
