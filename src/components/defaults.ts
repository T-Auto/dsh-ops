/** Package defaults only. Saved Loader overrides take precedence over this layer. */
export const COMPONENTS = ['mode-minimal', 'mode-standard', 'mode-ptc', 'mode-cordis', 'discovery', 'download-guard', 'panel', 'tui'] as const
export type Component = typeof COMPONENTS[number]
export function componentEnabled(component: Component, _platform: string): boolean {
  // Enhanced presets and progressive discovery start enabled. The download
  // guard is opt-in: it only acts once an operator names a downloader, so
  // enabling it by default would add a listener to installs that gain nothing.
  // Data capture and the TUI integration are opt-in for their own reasons.
  return !['download-guard', 'panel', 'tui'].includes(component)
}
export function componentEntry(component: Component): string { return `dsh-ops/${component}` }
