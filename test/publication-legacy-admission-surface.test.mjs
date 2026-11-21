/** The retained file row must advertise admitted tools, not registered-but-unadmitted ones (#934). */
import { createScope } from '@deepseek-ai/dsh-scope'
import { applyComponent } from '../lib/legacy/host.js'
import { assert, test, report, waitFor } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { prepareStep } from './lib/executor.mjs'

const SECTION = 'dsh-ops:repository-tooling:file'
const tick = () => new Promise(resolve => setImmediate(resolve))

await test('a registered-but-unadmitted tool stays out of the legacy tooling table until admission', async () => {
  const { ctx } = await bootHost()
  try {
    ctx.provide('agents', { list: () => [] })
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: process.cwd() }) })
    ctx.provide('subprocess', { spawn() { throw new Error('legacy surface fixture never spawns') } })
    applyComponent(ctx, { promptPolicy: true }, 'file')
    const agent = { id: 'legacy-surface', session: { id: 'legacy-surface', header: { cwd: process.cwd() }, append() {}, read() { return [] } } }
    agent.ctx = createScope(ctx, agent).ctx
    // The host-bug shape from #934: a same-scope registration whose `when` fails. A host that
    // ignores `when` in definitions() reads it as declared while the step excludes it.
    let admitted = false
    await agent.ctx.plugin({ inject: ['tools'], apply(inner) {
      inner.tools.register({ name: 'read_image', description: 'fixture image reader', parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({ ran: 'read_image' }) },
        { when: () => admitted })
    } })
    await tick(); await tick()
    await waitFor(() => ctx.get('tools').get('ops_read_files', agent), { what: 'legacy file row publication' })
    const text = step => step.assembly.sections.find(section => section.name === SECTION)?.text ?? ''
    const hidden = await prepareStep(ctx, agent)
    try {
      assert.doesNotMatch(text(hidden), /read_image/, 'a registered-but-unadmitted tool must not be advertised')
      assert.match(text(hidden), /ops_read_files/, "the row's own admitted tools stay advertised")
    } finally { hidden.dispose() }
    admitted = true
    const shown = await prepareStep(ctx, agent)
    try { assert.match(text(shown), /read_image \(host\)/, 'admitting the tool brings the row back') } finally { shown.dispose() }
  } finally { await shutdown(ctx) }
})

report('publication-legacy-admission-surface')
