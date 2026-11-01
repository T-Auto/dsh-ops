import type { Agent, Context } from '../../lib/adapter/dsh/types.js'
import { registerSystemSection, registerStepTailProvider } from 'dsh-ops/prompt-injection'
declare const ctx: Context, agent: Agent
registerSystemSection(ctx, agent, { id: 'literal', revision: '1', text: '{{literal}}' })
registerStepTailProvider(ctx, agent, { id: 'typed', revision: '2', provide(context) {
  // @ts-expect-error Accepted messages are read-only.
  context.messages.push(context.messages[0])
  // @ts-expect-error Message content is deeply read-only.
  context.messages[0].content[0].type = 'text'
  // @ts-expect-error Revision is required.
  registerSystemSection(ctx, agent, { id: 'missing', text: 'No revision' })
  return String(context.step)
} })
// @ts-expect-error Providers cannot spoof a role or source through a message object.
registerStepTailProvider(ctx, agent, { id: 'invalid', revision: '1', provide: () => ({ role: 'system', content: [] }) })
