/**
 * Where does the remaining O(live sessions) cost sit? — the ruled-out half.
 *
 * The deferred-verdict fix collapses assembly count to a constant, yet wall
 * clock still grows with the live set. The first suspect was `surfaceOf()`:
 * it reads `tools.schemas(agent)`, and rc's `schemas()` copies every visible
 * `parameters` through `snapshotJsonValue`, so that copy would be per session.
 *
 * This probe disproves that suspicion. `surface.ts` already consults
 * `tools.view(agent).visible` first and memoises by definition identity, so a
 * surface read costs about 0.05ms regardless of the live set. Run it before
 * blaming the surface: the real remainder is elsewhere (the per-session publish
 * loop in `reconcile`), and this file exists so that is not re-guessed.
 */
import { createScope } from '@deepseek-ai/dsh-scope'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bootHost, shutdown } from '../../test/lib/host.mjs'
import { surfaceOf } from '../../lib/surface.js'

const TOOLS = Number(process.env.PROBE_TOOLS ?? 150)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-490-surface-'))
const { ctx } = await bootHost({ toolsMode: 'native', withWorkingDirectory: true })

const bulkTool = index => ({
  name: `surface_probe_${index}`,
  description: `Bulk fixture tool ${index} with realistic nested parameters`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the target resource' },
      pattern: { type: 'string', description: 'Pattern to match' },
      options: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Maximum results' },
          encoding: { type: 'string', enum: ['utf-8', 'utf-16'], description: 'Text encoding' },
          range: { type: 'array', items: { type: 'object', properties: { start: { type: 'number' }, end: { type: 'number' } } } },
          filter: { type: 'object', properties: { field: { type: 'string' }, value: { type: 'string' }, operator: { type: 'string', enum: ['eq', 'ne', 'gt', 'lt'] } } },
        },
      },
    },
    required: ['path'],
  },
  output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } } }, render: () => [] },
  execute: async () => ({ content: 'ok' }),
})

for (let index = 0; index < TOOLS; index++) await ctx.get('tools').register(bulkTool(index))

const create = async id => {
  const agent = { id, session: { id, header: { cwd: dir } } }
  await ctx.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
  await ctx.serial('agent/created', { agent, source: 'startup' })
  return agent
}

const agents = []
for (let index = 0; index < 64; index++) agents.push(await create(`s-${index}`))
await new Promise(resolve => setTimeout(resolve, 300))

const tools = ctx.get('tools')
const median = samples => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]
const time = (fn, runs = 7) => {
  for (let warm = 0; warm < 3; warm++) fn()
  const samples = []
  for (let run = 0; run < runs; run++) {
    const started = process.hrtime.bigint()
    fn()
    samples.push(Number(process.hrtime.bigint() - started) / 1e6)
  }
  return Number(median(samples).toFixed(3))
}

const one = agents[0]
const schemasMs = time(() => tools.schemas(one))
const byteLength = Buffer.byteLength(JSON.stringify(tools.schemas(one)))
const surfaceMs = time(() => surfaceOf(tools, one))

console.log(JSON.stringify({
  tools: TOOLS,
  schemasPayloadKB: Number((byteLength / 1024).toFixed(1)),
  schemasMs,
  surfaceMs,
}))

// What one reconciliation pass would pay over the whole live set, if it reads
// each session's surface twice (probe loop + publish loop).
const perPass = surfaceMs * agents.length * 2
console.log(JSON.stringify({
  liveSessions: agents.length,
  estimatedPerReconcileMs: Number(perPass.toFixed(1)),
  note: 'surfaceOf is read once in the probe loop and once in the publish loop',
}))

await shutdown(ctx)
fs.rmSync(dir, { recursive: true, force: true })
