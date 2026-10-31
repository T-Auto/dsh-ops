/**
 * Which host action advances the PTC re-derivation epoch?
 *
 * The deferred-verdict fix spends a probe only when `system-prompt/change` has
 * fired since the last re-derivation. This probe asks the one question that
 * decides whether the fix reaches the issue's actual symptom: does creating a
 * session, or registering a tool, emit that event?
 */
import { createScope } from '@deepseek-ai/dsh-scope'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bootHost, shutdown } from '../../test/lib/host.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-490-epoch-'))
const { ctx } = await bootHost({ toolsMode: 'ptc', withWorkingDirectory: true })

let promptChanges = 0
let toolChanges = 0
ctx.on('system-prompt/change', () => { promptChanges += 1 })
ctx.on('tools/change', () => { toolChanges += 1 })

const bulkTool = index => ({
  name: `epoch_probe_${index}`,
  description: `fixture ${index}`,
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } } }, render: () => [] },
  execute: async () => ({ content: 'ok' }),
})

const reading = label => {
  console.log(JSON.stringify({ step: label, promptChanges, toolChanges }))
  promptChanges = 0
  toolChanges = 0
}

await new Promise(resolve => setTimeout(resolve, 50))
reading('boot')

await ctx.get('tools').register(bulkTool(0))
await new Promise(resolve => setTimeout(resolve, 50))
reading('register one tool')

// Attach a scope without presenting anything — the plainest possible session.
const agent = { id: 'probe-0', session: { id: 'probe-0', header: { cwd: dir } } }
await ctx.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
await new Promise(resolve => setTimeout(resolve, 50))
reading('attach a scope')

await ctx.serial('agent/created', { agent, source: 'startup' })
await new Promise(resolve => setTimeout(resolve, 50))
reading('agent/created (a new session appears)')

await ctx.serial('tools/change', {})
await new Promise(resolve => setTimeout(resolve, 50))
reading('bare tools/change')

await ctx.serial('system-prompt/change', {})
await new Promise(resolve => setTimeout(resolve, 50))
reading('bare system-prompt/change')

await shutdown(ctx)
fs.rmSync(dir, { recursive: true, force: true })
