import { createScope } from '@deepseek-ai/dsh-scope'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import * as discoveryModule from '../../lib/discovery/index.js'
import * as ptcModule from '../../lib/ptc/index.js'
import { isPresentationProbe } from '../../lib/presentation.js'
import { bootHost, shutdown } from '../../test/lib/host.mjs'
import { legacyComponent } from '../../test/lib/legacy-component.mjs'
import { WORKER } from '../../test/lib/boundary.mjs'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reentry-'))
const { ctx } = await bootHost({ toolsMode: 'native' })
await ctx.plugin(Subprocess); await ctx.plugin(Sandbox, {})
await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: session.header.cwd, sessionId: session.id }) }))
await ctx.plugin(inner => inner.provide('ptcRuntime', { language: 'typescript', programFormat: 'inline' }))
await ctx.plugin(legacyComponent(discoveryModule), { binaryPath: WORKER, required: true })
await ctx.plugin(legacyComponent(ptcModule), { binaryPath: WORKER, required: true })
const tools = ctx.get('tools'), prompt = ctx.get('systemPrompt'), real = prompt.assemble.bind(prompt)
const calls = []
let depth = 0, maxDepth = 0, sdkTexts = 0, sdkMs = 0
prompt.assemble = async context => {
  const started = process.hrtime.bigint()
  const record = { depth, probe: isPresentationProbe(context) }
  calls.push(record)
  depth++; if (depth > maxDepth) maxDepth = depth
  try { return await real(context) }
  finally {
    record.ms = +(Number(process.hrtime.bigint() - started) / 1e6).toFixed(2)
    depth--
  }
}
// A PTC request pays for the resident SDK declarations inside `tools.sdkSection`, so
// counting its text reads separates "the declarations arrived once, with the request"
// from "they were re-rendered once per assembly".
const realSection = tools.sdkSection.bind(tools)
tools.sdkSection = () => {
  const section = realSection()
  const text = section.text
  section.text = context => {
    const started = process.hrtime.bigint()
    try { return text(context) }
    finally { sdkTexts++; sdkMs += Number(process.hrtime.bigint() - started) / 1e6 }
  }
  return section
}
const bulk = index => ({ name: `probe_bulk_${index}`, description: `bulk ${index}`, parameters: { type: 'object', properties: { path: { type: 'string', description: 'path' }, pattern: { type: 'string', description: 'pattern' }, options: { type: 'object', properties: { depth: { type: 'number' }, mode: { enum: ['a', 'b'] } } } } }, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) })
for (let index = 0; index < 150; index++) await tools.register(bulk(index))
const agent = { id: 'reentry', session: { id: 'reentry', mode: 'danger-full-access', header: { cwd: dir } } }
await ctx.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
await ctx.serial('agent/created', { agent, source: 'startup' })
await ctx.waterfall('agent/pre-step', { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'continue' }))
// Both publication paths settle on their own microtask chains; let the startup
// registration traffic finish before the first measured switch.
await new Promise(resolve => setTimeout(resolve, 200))
await new Promise(resolve => setTimeout(resolve, 100))
async function measure(label, action) {
  calls.length = 0; maxDepth = 0; sdkTexts = 0; sdkMs = 0
  const started = process.hrtime.bigint()
  await action()
  const elapsedMs = +(Number(process.hrtime.bigint() - started) / 1e6).toFixed(2)
  console.log(JSON.stringify({ label, calls, maxDepth, sdkTexts, sdkMs: +sdkMs.toFixed(2), elapsedMs }))
}
await prompt.assemble({ scope: agent })
await measure('native->native', () => prompt.assemble({ scope: agent }))
await measure('native->ptc', async () => {
  await agent.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.presentAs('ptc') } })
  const result = await prompt.assemble({ scope: agent })
  console.log(JSON.stringify({ final: result.sections.filter(section => section.text.trim()).map(section => section.name), tools: result.tools.map(tool => tool.name).slice(0, 8) }))
})
await measure('ptc->ptc', () => prompt.assemble({ scope: agent }))
await shutdown(ctx); fs.rmSync(dir, { recursive: true, force: true })
