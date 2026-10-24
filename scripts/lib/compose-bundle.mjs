import { composeEntries } from '@deepseek-ai/dsh-app-boot'

/** Use the host's patch composer, treating skipped overrides as invalid input. */
export function composeBundle(layers, compose = composeEntries) {
  const warnings = []
  const rows = compose(layers, message => warnings.push(message))
  if (warnings.length) throw new Error(`Bundle patch does not compose: ${warnings.join('; ')}`)
  return rows
}
