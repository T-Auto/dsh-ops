/** Real host composition shared by document capability adapters. */
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import { createScope } from '@deepseek-ai/dsh-scope'
import { bootHost } from './host.mjs'
import { legacyComponent } from './legacy-component.mjs'
import { WORKER } from './boundary.mjs'
import { assert } from './harness.mjs'
import { publicToolName } from '../../lib/policy.js'
import * as discovery from '../../lib/discovery/index.js'
import * as ptc from '../../lib/ptc/index.js'
let serial = 0
export async function documentHost(root, names, { real = false } = {}) {
  const { ctx } = await bootHost({ withWorkingDirectory: true })
  const agents = []; ctx.provide('agents', { list: () => agents })
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem)
  await ctx.plugin(inner => {
    inner.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: session?.mode ?? 'workspace-write', workspaceRoot: root, sessionId: session?.id }) })
    if (!real) inner.provide('ptcRuntime', { language: 'typescript' })
  })
  if (real) await ctx.plugin(NodePtc, {})
  await ctx.plugin(legacyComponent(discovery), { binaryPath: WORKER, required: true, allowedTools: names })
  await ctx.plugin(legacyComponent(ptc), { binaryPath: WORKER, required: true, allowedTools: names.filter(name => !['result', 'inspect_local_file'].includes(name)) })
  async function agent(mode = 'native', { policy = 'workspace-write', cwd = root, parent } = {}) {
    const id = 'document-host-' + ++serial
    const value = { id, session: { id, mode: policy, header: { cwd }, append() {}, read() { return [] } } }
    value.ctx = createScope(parent?.ctx ?? ctx, value, parent ? { parent } : undefined).ctx
    await value.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.presentAs(mode) } })
    agents.push(value); await ctx.serial('agent/created', { agent: value }); return value
  }
  return { ctx, agent }
}
export const documentStep = (ctx, agent) => ctx.waterfall('agent/pre-step', { agent, messages: [], turn: 1, step: ++serial, signal: new AbortController().signal }, async () => ({ kind: 'continue' }))
export const documentNames = (ctx, agent) => ctx.get('tools').schemas(agent).map(tool => tool.name)
export const documentCall = (ctx, agent, name, args) => ctx.get('tools').get(publicToolName(name), agent).execute(args, { agent, signal: new AbortController().signal })
export async function activateDocument(ctx, agent, name, mode = 'native') {
  const result = await documentCall(ctx, agent, mode === 'native' ? 'discover_tools' : 'load_sdk', mode === 'native' ? { query: 'select:' + publicToolName(name) } : { tools: [name] })
  if (mode === 'native') assert.deepEqual(result.activated, [publicToolName(name)])
  else assert.equal(result.status, 'completed', JSON.stringify(result))
  assert.equal(documentNames(ctx, agent).includes(publicToolName(name)), false)
  await documentStep(ctx, agent)
  assert.ok(documentNames(ctx, agent).includes(publicToolName(name)))
}
export async function documentCode(ctx, agent, code) {
  const result = await ctx.get('tools').execute({ name: 'run_code', callId: 'documents-' + ++serial, agent, signal: new AbortController().signal,
    arguments: { description: 'Read document data through the scoped SDK', code } })
  assert.equal(result.isError, false, JSON.stringify(result)); return result.value.result
}
