/** Package defaults only. Saved Loader overrides take precedence over this layer. */
export const COMPONENTS = ['mode-minimal', 'mode-standard', 'mode-ptc', 'mode-cordis', 'discovery', 'panel', 'tui'] as const
export type Component = typeof COMPONENTS[number]
export function componentEnabled(component: Component, _platform: string): boolean {
  // Enhanced presets and progressive discovery start enabled; data capture and
  // the TUI integration are opt-in.
  return !['panel', 'tui'].includes(component)
}
export function componentEntry(component: Component): string { return `dsh-ops/${component}` }
