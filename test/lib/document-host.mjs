/** Real DSH 0.2.2 scoped document compositions and captured model-step sets. */
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import { createScope } from '@deepseek-ai/dsh-scope'
import { bootHost } from './host.mjs'
import { WORKER } from './boundary.mjs'
import { assert } from './harness.mjs'
import { publicToolName } from '../../lib/policy.js'
import { integration } from '../../lib/integration/index.js'
import { prepareStep, executeCall, selectExecutor } from './executor.mjs'
import { mountResident } from './resident.mjs'
let serial = 0
export async function documentHost(root, names, { real = false } = {}) {
  const { ctx } = await bootHost()
  const agents = []; ctx.provide('agents', { list: () => agents })
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem)
  await mountResident(ctx, { file: WORKER, cwd: root })
  ctx.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: session?.mode ?? 'workspace-write', workspaceRoot: root, sessionId: session?.id }) })
  await ctx.plugin(NodePtc, {})
  for (const mode of ['native', 'ptc']) await ctx.plugin(integration({ preset: `documents-${mode}`, profile: mode,
    residentTools: false, binaryPath: WORKER, required: true, allowedTools: mode === 'native' ? names : names.filter(name => !['result', 'inspect_local_file'].includes(name)) }))
  async function agent(mode = 'native', { policy = 'workspace-write', cwd = root, parent } = {}) {
    const id = 'document-host-' + ++serial
    const value = { id, session: { id, mode: policy, header: { cwd, agentPreset: `documents-${mode}` }, append() {}, read() { return [] } } }
    value.ctx = createScope(parent?.ctx ?? ctx, value, parent ? { parent } : undefined).ctx
    await value.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, mode) } })
    agents.push(value); await ctx.serial('agent/created', { agent: value })
    value.prepared = await prepareStep(ctx, value)
    return value
  }
  return { ctx, agent }
}
export async function documentStep(ctx, agent) {
  ctx.emit('session/event', agent.session, { type: 'step/end', turn: 1, step: ++serial })
  agent.prepared?.dispose()
  agent.prepared = await prepareStep(ctx, agent)
}
export const documentNames = (ctx, agent) => ctx.get('tools').definitions(agent, agent.prepared.toolSet).map(tool => tool.name)
/** Successful paths use the captured admission through the official executor. */
export async function documentCall(ctx, agent, name, args) {
  const assembly = agent.prepared.assembly
  if (assembly.tools.length === 1 && assembly.tools[0]?.name === 'run_code') {
    return documentCode(ctx, agent, `return await tools.${publicToolName(name)}(${JSON.stringify(args)});`)
  }
  const result = await executeCall(ctx, { name: publicToolName(name), callId: 'documents-' + ++serial,
    agent, toolSet: agent.prepared.toolSet, arguments: args })
  assert.equal(result.isError, false, JSON.stringify(result))
  return result.value
}
export async function activateDocument(ctx, agent, name, mode = 'native') {
  const result = await documentCall(ctx, agent, mode === 'native' ? 'discover_tools' : 'load_sdk', mode === 'native' ? { query: 'select:' + publicToolName(name) } : { tools: [name] })
  if (mode === 'native') assert.deepEqual(result.activated, [publicToolName(name)])
  else assert.equal(result.status, 'completed', JSON.stringify(result))
  assert.equal(documentNames(ctx, agent).includes(publicToolName(name)), false)
  await documentStep(ctx, agent)
  assert.ok(documentNames(ctx, agent).includes(publicToolName(name)))
}
export async function documentCode(ctx, agent, code) {
  const result = await executeCall(ctx, { name: 'run_code', callId: 'documents-' + ++serial, agent, toolSet: agent.prepared.toolSet, signal: new AbortController().signal,
    arguments: { description: 'Read document data through the scoped SDK', code } })
  assert.equal(result.isError, false, JSON.stringify(result)); return result.value.result
}
