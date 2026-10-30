/** Global gates operate on validated consumer plans; saved intent never becomes invalid. */
import type { IntegrationConfig } from './options.js'
export interface ConsumerSwitches { bash: boolean; hidePwsh: boolean; hideOfficialTools: boolean; dynamicTools: boolean }
export function gateConsumer(config: IntegrationConfig, switches: ConsumerSwitches, pwsh7Link: boolean): IntegrationConfig {
  return { ...config,
    shell: config.shell && switches.bash,
    hidePwsh: config.hidePwsh && config.shell && switches.bash && switches.hidePwsh && !pwsh7Link,
    replaceOfficial: config.replaceOfficial && switches.hideOfficialTools,
    discovery: config.discovery && switches.dynamicTools,
    native: { ...config.native, enabled: config.native.enabled && switches.dynamicTools },
  }
}
