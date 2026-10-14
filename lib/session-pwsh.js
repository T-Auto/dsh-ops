/**
 * A reversible runtime-only config overlay; never edits profile files or services.
 *
 * Windows-only by design, and this guard is the second half of the platform
 * policy `resolveShells` states: `pwsh-sandbox` is a Windows executor, so on
 * Linux there is no host row to point at and the plugin's PowerShell 7 rung
 * reports `available: false` with the Linux reason. Returning early keeps the
 * overlay inert there instead of rewriting a row that cannot exist.
 */
export function mountBundledPwsh(ctx, shells) {
  if (!shells.pwsh.available || process.platform !== 'win32') return
  ctx.inject(['loader'], loaderCtx => {
    const loader = loaderCtx.get('loader')
    const matches = entry => entry?.options?.id === 'pwsh-sandbox'
      && entry.options.name === '@deepseek-ai/dsh-pwsh-sandbox'
    const refresh = () => {
      for (const entry of loader.entries()) {
        if (matches(entry) && entry.fiber?.state === 2) {
          // Public Fiber.update with noSave recomputes from the owner's latest
          // raw config. No stored config, volatile reference, or method is changed.
          entry.fiber.update(entry.options.config, true)
        }
      }
    }
    const unhook = loaderCtx.on('internal/config', function (_raw, next) {
      const config = next()
      if (!matches(this.entry) || this.parent?.fiber?.entry === this.entry) return config
      return { ...config, pwshPath: shells.pwsh.file }
    }, { global: true, prepend: true })
    let stopped = false
    loaderCtx.effect(() => () => {
      if (stopped) return
      stopped = true
      unhook()
      refresh()
    }, 'dsh-ops: restore owning PowerShell executor config')
    refresh()
  })
}
