import { resolveConfig } from '../config.js'
import { configObject, editable, settingsConfig } from './schema.js'
export const Config = settingsConfig(value => {
  const raw = configObject(value ?? {}), config = resolveConfig(raw)
  return { ...raw, promptPolicy: config.promptPolicy, required: config.required, denyCredentialReads: config.denyCredentialReads }
}, {
  promptPolicy: editable('boolean', 'Publish guidance for the active file tools.'),
  required: editable('boolean', 'Fail startup if the native worker is unavailable.'),
  denyCredentialReads: editable('boolean', 'Deny reads of credential paths.'),
  binaryPath: editable('string', 'Optional explicit native worker path.'),
})
