/** Settings descriptor for explicitly configured consumer records, not automatic preset enrollment. */
import type { Field } from './schema.js'
import { editable } from './schema.js'
const bool = (description: string) => ({ type: 'boolean' as const, meta: { description } })
const string = (description: string) => ({ type: 'string' as const, meta: { description } })
const names = (description: string) => ({ type: 'array' as const, inner: string(description), meta: { description } })
export const PRESET_SETTINGS: Field = editable('dict', 'Explicit preset consumers. Each key is an exact preset id; installation alone never opts in a preset.', {
  type: 'object', dict: {
    enabled: bool('Enable this explicitly configured consumer.'), profile: string('native, ptc, discovery or shell.'),
    files: bool('Enable built-in file capabilities.'), shell: bool('Enable authorized Bash.'),
    presentation: string('native or ptc; never changes host presentation.'), residentTools: bool('Publish the resident tool profile.'),
    residentNames: names('Exact Native resident capability names.'), discovery: bool('Publish progressive selection.'),
    allowedTools: names('Advanced built-in capabilities allowed for selection.'), alwaysLoaded: names('Allowed capabilities to load at startup.'),
    replaceOfficial: bool('Hide ready official file counterparts.'), hidePwsh: bool('Hide the host PowerShell while Bash is ready.'),
    promptPolicy: bool('Publish routing guidance.'), extraGuidance: string('Additional Native routing guidance.'),
    binaryPath: string('Optional explicit worker executable.'), required: bool('Fail activation when required runtime is missing.'),
    denyCredentialReads: bool('Native credential read fence; PTC does not accept this override.'),
    bashPath: string('Optional explicit Bash executable.'), allowSystemShellFallback: bool('Allow reviewed system shell fallback.'),
    externalTools: names('Explicit external capability allow-list.'), externalAlwaysLoaded: names('Allowed external startup capabilities.'),
    externalDisabled: names('External deny-list; disabled wins.'),
  },
})
