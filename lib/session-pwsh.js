/** A reversible runtime-only config overlay; never edits profile files or services. */
export function mountBundledPwsh(ctx, shells) {
  // Upstream gated this to win32 as well. The overlay itself is platform
  // neutral: it only points the owning `pwsh-sandbox` row at this plugin's copy
  // when one is resolvable. Whether that row is mounted at all stays the host's
  // decision, so on a host that disables its pwsh rows this is a no-op.
  if (!shells.pwsh.available) return
  ctx.inject(['loader'], loaderCtx => {
    const loader = loaderCtx.get('loader')
    const matches = entry => entry?.options?.id === 'pwsh-sandbox'
      && entry.options.name === '@deepseek-ai/dsh-pwsh-sandbox'
    // The owning executor re-reads `config.pwshPath` (a volatile config
    // reference) before every command and re-probes the executable when the
    // declared value changed, so the overlay commits the value into that live
    // reference — and the unmount restores the owner's latest declared value
    // the same way. It must never restart the row: `entry.fiber.update()` on an
    // ACTIVE row is a dispose/reload, and restarting the official executor
    // swaps the `shell` service provider — every `inject('shell')` consumer is
    // rebuilt, which bricks `permission-presets` (its constructor re-pins
    // loaded sessions and throws on a session still carrying the `auto` preset)
    // and takes the whole tool surface down with it (#29, #104, #129;
    // deepseek-harness discussion #9882).
    // `Symbol.for('cosmokit.volatile.write')` is the symbol the loader's own
    // `updateVolatile()` writes through; the global symbol keeps the commit
    // behaviour-identical without a new runtime dependency.
    const commit = (entry, value) => {
      try {
        if (entry.fiber?.state !== 2) return // not active: the config hook covers its next activation
        const ref = entry.fiber.config?.pwshPath
        const write = Symbol.for('cosmokit.volatile.write')
        if (!ref || typeof ref.get !== 'function' || typeof ref[write] !== 'function') return
        if (ref.get() !== value) ref[write](value)
      } catch (error) {
        // One row that refuses the commit must not strand the rows behind it (#30): the loop
        // continues, and the refusal is reported rather than swallowed.
        loaderCtx.logger?.warn?.(`dsh-ops: pwsh executor row ${entry.options?.id ?? '(unnamed)'} rejected the overlay: ${error?.message ?? error}`)
      }
    }
    const unhook = loaderCtx.on('internal/config', function (_raw, next) {
      const config = next()
      if (!matches(this.entry) || this.parent?.fiber?.entry === this.entry) return config
      return { ...config, pwshPath: shells.pwsh.file }
    }, { global: true, prepend: true })
    for (const entry of loader.entries()) {
      if (matches(entry)) commit(entry, shells.pwsh.file)
    }
    let stopped = false
    loaderCtx.effect(() => () => {
      if (stopped) return
      stopped = true
      unhook()
      // Restore each matched row's own declared value — the latest raw config,
      // which is what the owner last chose — again without restarting the row.
      // A declared non-string (`!!js` expression node) is left alone: the next
      // natural re-resolution evaluates it.
      for (const entry of loader.entries()) {
        if (!matches(entry)) continue
        const declared = entry.options.config?.pwshPath
        if (declared === undefined || typeof declared === 'string') commit(entry, declared)
      }
    }, 'dsh-ops: restore owning PowerShell executor config')
  })
}
