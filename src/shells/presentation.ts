/** Pure, replayable shell cards through the host's public presentation contract. */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export const presentBashCall: NonNullable<ToolDefinition['presentCall']> = args => {
  if (!record(args)) return undefined
  const command = typeof args.command === 'string' && args.command.trim() ? args.command : undefined
  const script = typeof args.script_path === 'string' && args.script_path.trim() ? args.script_path : undefined
  if ((!command && !script) || (command && script)) return undefined
  return {
    card: 'terminal', title: command ?? script!,
    ...(typeof args.description === 'string' && args.description.trim() ? { description: args.description } : {}),
    ...(typeof args.workdir === 'string' && args.workdir.trim() ? { cwd: args.workdir } : {}),
  }
}

/** Only process facts are persisted here; output remains in the host's content record. */
export const bashPresentationMeta: NonNullable<ToolDefinition['output']['presentationMeta']> = (_args, value): ReturnType<NonNullable<ToolDefinition['output']['presentationMeta']>> => {
  if (!record(value) || value.kind !== 'foreground') return {}
  if (typeof value.signal === 'string' && value.signal) return { opsShell: { signal: value.signal } }
  if (typeof value.exitCode === 'number' && Number.isSafeInteger(value.exitCode)) return { opsShell: { exitCode: value.exitCode } }
  return {}
}

export const presentBashResult: NonNullable<ToolDefinition['presentResult']> = (_args, result) => {
  const facts = record(result.meta) && record(result.meta.opsShell) ? result.meta.opsShell : {}
  const signal = typeof facts.signal === 'string' && facts.signal ? facts.signal : undefined
  const exitCode = typeof facts.exitCode === 'number' && Number.isSafeInteger(facts.exitCode) ? facts.exitCode : undefined
  return {
    card: 'terminal',
    output: result.content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
    ...(signal ? { signal } : exitCode !== undefined ? { exitCode } : {}),
  }
}
