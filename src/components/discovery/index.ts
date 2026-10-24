export { name, apply } from '../../discovery/index.js'
import { resolveDiscoveryConfig } from '../../discovery/config.js'
import { editable, settingsConfig } from '../../settings/schema.js'
export const Config = settingsConfig(resolveDiscoveryConfig, {
  enabled: editable('boolean', 'Publish the discovery entry.'),
  maxResults: editable('number', 'Maximum capabilities selected per discovery call, from 1 to 5.'),
  allowedTools: editable('array', 'Implemented capabilities available for discovery.', { type: 'string' }),
  alwaysLoaded: editable('array', 'Allowed capabilities published without a discovery request.', { type: 'string' }),
  binaryPath: editable('string', 'Absolute native worker path; omit to use the packaged worker.'),
  required: editable('boolean', 'Fail activation when the native worker is unavailable.'),
  denyCredentialReads: editable('boolean', 'Refuse credential locations during file reads.'),
})
