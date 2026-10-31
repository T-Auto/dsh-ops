/** A lazily invalidated session must still observe a presentation flip on its next assembly. */
import { createScope } from '@deepseek-ai/dsh-scope'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import * as discoveryModule from '../lib/discovery/index.js'
import * as ptcModule from '../lib/ptc/index.js'
import { legacyComponent } from './lib/legacy-component.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'

import { assert, test, report, wait, withTempDir } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'

const discovery = legacyComponent(discoveryModule)
const ptc = legacyComponent(ptcModule)

requireWorker('discovery-lazy-self-correction')
await test('a lazily invalidated session self-corrects on its next real assembly', () => withTempDir('lazy-self-correction', async dir => {
  const { ctx } = await bootHost({ toolsMode: 'native' })
  try {
    await ctx.plugin(Subprocess)
    await ctx.plugin(Sandbox, {})
    await ctx.plugin(inner => inner.provide('sandboxPolicy', {
      resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: session.header.cwd, sessionId: session.id }),
    }))
    await ctx.plugin(inner => inner.provide('ptcRuntime', { language: 'typescript', programFormat: 'inline' }))
    await ctx.plugin(discovery, { binaryPath: WORKER, required: true })
    await ctx.plugin(ptc, { binaryPath: WORKER, required: true })
    const prompt = ctx.get('systemPrompt')

    const create = async id => {
      const agent = { id, session: { id, mode: 'danger-full-access', header: { cwd: dir } } }
      agent.ctx = createScope(ctx, agent).ctx
      await ctx.serial('agent/created', { agent, source: 'startup' })
      return agent
    }
    // `first` is the representative an unattributed change probes; `second` stays lazy.
    await create('first')
    const second = await create('second')
    await wait(400)

    const ptcSections = async agent => (await prompt.assemble({ scope: agent })).sections
      .filter(section => section.name === 'tools:ptc-only' && section.text.trim()).length
    assert.equal(await ptcSections(second), 0, 'the second session starts Native')

    // A third party flips the second session to PTC-only during assembly, with no
    // registry event at all — the case conservative invalidation exists for.
    let collapse = false
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const result = await next()
      if (context.scope !== second || !collapse) return result
      return { ...result, tools: result.tools.filter(tool => tool.name === 'run_code'), sections: [...result.sections, { name: 'tools:ptc-only', text: 'PTC only' }] }
    })

    collapse = true
    await ctx.serial('tools/change', {})
    await wait(400)
    assert.equal(await ptcSections(second), 1, 'a lazily invalidated session must observe the flip on its next real assembly')
  } finally { await shutdown(ctx) }
}))

report('lazy-self-correction')
