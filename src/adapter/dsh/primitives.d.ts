/**
 * The native control this bundle consumes, declared locally on purpose.
 *
 * `@deepseek-ai/dsh-client-ui-primitives` is not a package on disk in the running
 * distribution (0.2.1-rc.3): it is a client-module name the Host's module loader
 * answers, so there is no `.d.ts` to import. These declarations are therefore the
 * local minimal contract, taken from official call sites in that distribution:
 * `Switch` is rendered with `{ checked, label, disabled, title?, onChange }`, where
 * `label` is the accessible name. Re-verify the call sites before widening this.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactElement } from 'react'
  export interface SwitchProps {
    checked: boolean
    label: string
    disabled?: boolean
    title?: string
    onChange(checked: boolean): void
  }
  export function Switch(props: SwitchProps): ReactElement
}
