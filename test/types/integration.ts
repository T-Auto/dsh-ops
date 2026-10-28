import { integration, registerNativeCapability, diagnose } from '../../src/integration/index.js'
import type { IntegrationOptions } from '../../src/integration/index.js'
import type { Context, Agent } from '../../src/adapter/dsh/types.js'
declare const ctx: Context
declare const agent: Agent
const config: IntegrationOptions = { preset: 'external', files: false, shell: true, discovery: false, replaceOfficial: false }
integration(config)
// @ts-expect-error invalid presentation is rejected by the public contract
integration({ preset: 'external', presentation: 'hybrid' })
// @ts-expect-error a preset identity is mandatory
integration({ files: true })
registerNativeCapability(ctx, { search: 'lookup', authorize: exec => Boolean(exec.agent), definition: {
  name: 'external_lookup', description: 'Lookup.', parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({ value: true }),
} })
const result = await diagnose(ctx, agent)
const state: 'not-selected' | 'ready' | 'degraded' = result.state
void state
