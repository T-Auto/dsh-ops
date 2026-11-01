/** #421: one PTC program must be able to read, derive the CAS revision from that read and edit. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import { createScope } from '@deepseek-ai/dsh-scope'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'
import * as ptcModule from '../lib/ptc/index.js'
import { legacyComponent } from './lib/legacy-component.mjs'
const ptc = legacyComponent(ptcModule)
requireWorker('ptc-compose')
const hash = text => createHash('sha256').update(text).digest('hex')
let serial = 0
/** Resident advanced tools: the same program can read and then edit without a second model step. */
const RESIDENT = ['read_files', 'edit_file', 'write_file']
async function setup(root) {
  const { ctx } = await bootHost()
  const agents = []; ctx.provide('agents', { list: () => agents })
  await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem)
  await ctx.plugin(inner => {
    inner.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: session?.mode ?? 'workspace-write', workspaceRoot: root, sessionId: session?.id }) })
  })
  await ctx.plugin(NodePtc, {})
  await ctx.plugin(ptc, { binaryPath: WORKER, required: true, alwaysLoaded: RESIDENT })
  async function agent() {
    const id = 'compose-' + ++serial
    const value = { id, session: { id, mode: 'workspace-write', header: { cwd: root }, append() {}, read() { return [] } } }
    value.ctx = createScope(ctx, value).ctx
    await value.ctx.plugin({ inject: ['tools'], apply(inner) { value.lift = inner.tools.presentAs('ptc') } })
    agents.push(value)
    await ctx.serial('agent/created', { agent: value })
    return value
  }
  return { ctx, agent }
}
async function program(ctx, agent, body) {
  const value = await ctx.get('tools').execute({ name: 'run_code', callId: 'compose-call-' + ++serial, agent,
    signal: new AbortController().signal, arguments: { description: 'Compose read and edit in one PTC program', code: body } })
  assert.equal(value.isError, false, JSON.stringify(value)); return value.value.result
}
await test('one program derives the edit revision from the read receipt and publishes one changed file', async () => {
  await withTempDir('ptc-compose-read-edit', async root => {
    const { ctx, agent } = await setup(root)
    try {
      const file = path.join(root, 'plan.md'), before = '# plan\nalpha step\nomega step\n'
      fs.writeFileSync(file, before)
      const owner = await agent()
      const out = await program(ctx, owner, `const read = await tools.ops_inspect_local_file({path:'plan.md'});
        const anchor = read.data.items.find(item => item.text === 'omega step').text;
        const edited = await tools.ops_edit_file({path:'plan.md', expectedRevision: read.data.revision,
          edits:[{oldText: anchor, newText: anchor + ' (done)'}]});
        return {read, edited, anchor};`)
      assert.equal(out.read.status, 'completed', JSON.stringify(out.read))
      assert.equal(out.read.data.revision, hash(before), 'the read receipt carries the CAS revision')
      assert.equal(out.anchor, 'omega step')
      assert.equal(out.edited.status, 'completed', JSON.stringify(out.edited))
      assert.equal(out.edited.data.revision, hash('# plan\nalpha step\nomega step (done)\n'))
      assert.notEqual(out.edited.data.revision, out.read.data.revision)
      assert.equal(fs.readFileSync(file, 'utf8'), '# plan\nalpha step\nomega step (done)\n')
    } finally { await shutdown(ctx) }
  })
})
await test('a second write inside the same program makes the earlier read revision refuse the edit', async () => {
  await withTempDir('ptc-compose-stale', async root => {
    const { ctx, agent } = await setup(root)
    try {
      const file = path.join(root, 'plan.md'); fs.writeFileSync(file, 'alpha step\nomega step\n')
      const owner = await agent()
      const out = await program(ctx, owner, `const read = await tools.ops_inspect_local_file({path:'plan.md'});
        const written = await tools.ops_write_file({path:'plan.md', content:'alpha step\\nomega step\\ninserted\\n', expectedRevision: read.data.revision});
        const stale = await tools.ops_edit_file({path:'plan.md', expectedRevision: read.data.revision,
          edits:[{oldText:'alpha step', newText:'alpha changed'}]})
          .catch(error => ({ thrown: String(error?.message ?? error) }));
        return {read, written, stale};`)
      assert.equal(out.written.status, 'completed', JSON.stringify(out.written))
      assert.equal(out.stale.thrown, undefined, 'a CAS refusal is a returned value, never a thrown error')
      assert.equal(out.stale.status, 'conflict', JSON.stringify(out.stale))
      assert.equal(out.stale.error.code, 'REVISION_CONFLICT'); assert.equal(out.stale.error.effectState, 'none')
      const after = fs.readFileSync(file, 'utf8')
      assert.equal(after, 'alpha step\nomega step\ninserted\n', 'the refused edit wrote nothing')
      assert.doesNotMatch(after, /alpha changed/)
    } finally { await shutdown(ctx) }
  })
})
await test('a multi-file read supplies each file its own revision for the same-program edits', async () => {
  await withTempDir('ptc-compose-multi', async root => {
    const { ctx, agent } = await setup(root)
    try {
      const one = path.join(root, 'one.txt'), two = path.join(root, 'two.txt')
      fs.writeFileSync(one, 'keep\nTOKEN one\n'); fs.writeFileSync(two, 'TOKEN two\nkeep\n')
      const owner = await agent()
      const out = await program(ctx, owner, `const read = await tools.ops_read_files({files:[{path:'one.txt'},{path:'two.txt'}]});
        const edits = [];
        for (const entry of read.data.items) {
          const anchor = entry.items.find(line => line.text.includes('TOKEN')).text;
          edits.push(await tools.ops_edit_file({path: entry.path, expectedRevision: entry.revision,
            edits:[{oldText: anchor, newText: anchor.replace('TOKEN','DONE')}]}));
        }
        return {read, edits};`)
      assert.equal(out.read.status, 'completed', JSON.stringify(out.read))
      assert.equal(out.read.data.items.length, 2)
      assert.deepEqual(out.edits.map(edit => edit.status), ['completed', 'completed'], JSON.stringify(out.edits))
      assert.equal(fs.readFileSync(one, 'utf8'), 'keep\nDONE one\n')
      assert.equal(fs.readFileSync(two, 'utf8'), 'DONE two\nkeep\n')
      assert.deepEqual(out.edits.map(edit => edit.data.revision), [hash('keep\nDONE one\n'), hash('DONE two\nkeep\n')])
    } finally { await shutdown(ctx) }
  })
})
report('ptc-compose')
