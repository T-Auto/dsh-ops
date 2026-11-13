/** Added read APIs use one scoped source through real Native and official run_code. */
import fs from 'node:fs'
import path from 'node:path'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import { createScope } from '@deepseek-ai/dsh-scope'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { mountNative } from '../lib/publication/native.js'
import { mountPtc } from '../lib/publication/ptc.js'
import { SHARED_FILE_APIS } from '../lib/publication/scope-owner.js'
import { definition as nativeDefinition } from '../lib/projections/native/contract.js'
import { definition as ptcDefinition } from '../lib/projections/ptc/contract.js'
import { resolveConfig } from '../lib/config.js'
import { publicToolName } from '../lib/policy.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { mountResident } from './lib/resident.mjs'
import { selectExecutor, prepareStep, executeCall } from './lib/executor.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { requireWorker, WORKER } from './lib/boundary.mjs'
import { docx, paragraph } from './lib/document-fixture.mjs'
import { textPdf, show } from './lib/pdf-fixture.mjs'
requireWorker('shared-file-read-contracts')
const added = ['diff', 'read_table', 'read_docx', 'read_pdf']
await test('four audited reads preserve typed data, Native text and single worker execution', () => withTempDir('shared-reads', async root => {
  fs.writeFileSync(path.join(root, 'note.txt'), 'shared UTF8 中\n')
  fs.writeFileSync(path.join(root, 'rows.csv'), 'id,value\n0001,TRUE\n')
  fs.writeFileSync(path.join(root, 'body.docx'), docx(paragraph('shared document')))
  fs.writeFileSync(path.join(root, 'body.pdf'), textPdf([show('shared PDF')]))
  const { ctx, tools } = await bootHost()
  const steps = [], envelopes = []
  try {
    for (const plugin of [Subprocess, Sandbox, FileSystem, NodePtc]) await ctx.plugin(plugin)
    const kernel = await mountResident(ctx, { file: WORKER, cwd: root }), dispatch = kernel.invoke.bind(kernel)
    kernel.invoke = (envelope, ...rest) => { envelopes.push(envelope); return dispatch(envelope, ...rest) }
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'read-only', workspaceRoot: root }) })
    await ctx.plugin({ apply(inner) {
      mountNative(inner, resolveConfig({ binaryPath: WORKER, required: true }), {
        id: 'shared-reads', tools: added, section: null, gate: { allows: () => true },
      })
      mountPtc(inner, { binaryPath: WORKER, required: true, alwaysLoaded: added })
    } })
    for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve))
    const agent = { id: 'reads', session: { id: 'reads', header: { cwd: root }, append() {}, read() { return [] } } }
    agent.ctx = createScope(ctx, agent).ctx
    let executor
    await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { executor = selectExecutor(inner, 'native') } })
    await ctx.serial('agent/created', { agent })
    const cases = [
      ['diff', { path: 'note.txt', content: 'changed\n' }, data => assert.ok(data.items.length > 0)],
      ['read_table', { path: 'rows.csv' }, data => assert.deepEqual(data.items[0].cells, ['0001', 'TRUE'])],
      ['read_docx', { path: 'body.docx' }, data => assert.equal(data.items[0].text, 'shared document')],
      ['read_pdf', { path: 'body.pdf' }, data => assert.match(data.items[0].text, /shared PDF/)],
    ]
    for (const api of added) {
      assert.ok(SHARED_FILE_APIS.includes(api))
      assert.deepEqual(nativeDefinition(api, async () => {}).parameters, ptcDefinition(api, async () => {}).parameters)
      assert.equal(tools.definitions(agent).filter(def => def.name === publicToolName(api)).length, 1)
    }
    for (const mode of ['native', 'ptc']) {
      if (mode === 'ptc') {
        executor()
        await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { executor = selectExecutor(inner, mode) } })
      }
      const step = await prepareStep(ctx, agent); steps.push(step)
      for (const [index, [api, args, check]] of cases.entries()) {
        const name = publicToolName(api), definition = tools.definitions(agent).find(def => def.name === name)
        assert.deepEqual(validateJsonSchemaValue(definition.parameters, args), [])
        const before = envelopes.length
        const result = await executeCall(ctx, { agent, toolSet: step.toolSet, name: mode === 'native' ? name : 'run_code',
          callId: `${mode}-${index}`, arguments: mode === 'native' ? args : { description: api, code: `return await tools.${name}(${JSON.stringify(args)});` } })
        assert.equal(result.isError, false, JSON.stringify(result))
        const value = mode === 'native' ? result.value : result.value.result
        assert.equal(value.status, 'completed', JSON.stringify(value)); check(value.data)
        assert.deepEqual(validateJsonSchemaValue(definition.output.schema, value), [])
        assert.equal(envelopes.length - before, 1, 'exactly one real worker envelope per call')
        if (mode === 'native') {
          const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n')
          assert.ok(text.length > 0); assert.ok(text.length < 4000)
          assert.doesNotMatch(text, /^\s*\{"status":/)
        }
      }
    }
  } finally { steps.forEach(step => step.dispose()); await shutdown(ctx) }
}))
report('shared-file-read-contracts')
