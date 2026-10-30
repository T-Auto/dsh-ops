/** Legacy Loader entry; the generic controller is kept separate from preset policy. */
import type { Context, Agent } from '../adapter/dsh/types.js'
import { modeOf } from '../presets/detect.js'
import { enabledModes, onModesChange } from '../presets/registry.js'
import { residentTools } from '../presets/defaults.js'
import { integrationFor } from '../consumer/registry.js'
import { retired as retiredLegacyRow } from '../settings/legacy.js'
import { mountDiscovery } from './controller.js'
export type { DiscoveryGate } from './controller.js'
export { mountDiscovery } from './controller.js'
export const name = 'dsh-ops-discovery'
export function apply(root: Context, raw: unknown, gate: import('./controller.js').DiscoveryGate = { allows: (agent: Agent) => !integrationFor(root, agent) && modeOf(root, agent) !== undefined }): void {
  if (retiredLegacyRow(root, 'discovery')) return
  mountDiscovery(root, raw, { ...gate,
    watch: notify => {
      const dispose = gate.watch?.(notify)
      const modes = onModesChange(root, notify)
      return () => { dispose?.(); modes() }
    },
    residentTools: gate.residentTools ?? (agent => {
      const mode = modeOf(root, agent)
      return mode && enabledModes(root).get(mode)?.residentTools ? residentTools(mode) : []
    }),
  })
}
