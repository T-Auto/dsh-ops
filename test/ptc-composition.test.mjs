/** Real run_code calls reuse read facts; fixtures never reconstruct file bytes from numbered text. */
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
import { legacyComponent } from './lib/legacy-component.mjs'
import * as ptcModule from '../lib/ptc/index.js'
requireWorker('ptc-composition')
const hash = text => createHash('sha256').update(text).digest('hex')
let serial = 0
async function fixture(root, run) {
  const { ctx } = await bootHost()
  const agents = []
  ctx.provide('agents', { list: () => agents })
  try {
    await ctx.plugin(Subprocess); await ctx.plugin(Sandbox); await ctx.plugin(FileSystem)
    await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode: 'workspace-write', workspaceRoot: root, sessionId: session?.id }) }))
    // A separate writer is invoked at an exact point between the read and CAS, without sleeps.
    await ctx.plugin({ inject: ['tools'], apply(inner) {
      inner.tools.register({ name: 'fixture_external_write', description: 'Replace the test fixture from outside OPS.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: { schema: { type: 'object', properties: { written: { type: 'boolean' } }, required: ['written'] }, render: () => [] },
        execute() { fs.writeFileSync(path.join(root, 'note.txt'), 'external\n'); return { written: true } } })
    } })
    await ctx.plugin(NodePtc, {})
    await ctx.plugin(legacyComponent(ptcModule), { binaryPath: WORKER, required: true,
      alwaysLoaded: ['read_files', 'edit_file', 'replace'] })
    const id = `compose-${++serial}`
    const agent = { id, session: { id, header: { cwd: root }, append() {}, read() { return [] } } }
    agent.ctx = createScope(ctx, agent).ctx
    await agent.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.presentAs('ptc') } })
    agents.push(agent); await ctx.serial('agent/created', { agent })
    // Exercise the real provider-call boundary: publication and SDK materialization settle here.
    // Direct execute immediately after agent creation can race Node 22's initial reconciliation.
    await ctx.waterfall('agent/pre-step', { agent, messages: [], turn: 1, step: 1,
      signal: new AbortController().signal }, () => Promise.resolve({ kind: 'continue' }))
    const prompt = await ctx.get('systemPrompt').assemble({ scope: agent })
    const sdk = prompt.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
    for (const name of ['ops_inspect_local_file','ops_read_files','ops_edit_file','ops_replace']) assert.ok(sdk.includes(name), name)
    const call = async code => {
      const result = await ctx.get('tools').execute({ name: 'run_code', callId: `composition-${++serial}`,
        agent, signal: new AbortController().signal, arguments: { description: 'Verify read-to-edit composition', code } })
      assert.equal(result.isError, false, JSON.stringify(result)); return result.value.result
    }
    await run(call)
  } finally { await shutdown(ctx) }
}

await test('one real run_code passes the observed line and revision into CAS while preserving CRLF/BOM and EOF', async () => {
  await withTempDir('ptc-compose', async root => {
    const before = '\ufeffheader\r\nsetting=old\r\nlast'
    fs.writeFileSync(path.join(root, 'note.txt'), before)
    await fixture(root, async call => {
      const result = await call(`
        const read = await tools.ops_inspect_local_file({path:'note.txt'});
        if (read.status !== 'completed') return {read};
        const row = read.data.items.find(item => item.line === 2);
        if (!row || row.truncatedInLine || !read.data.revision) return {read};
        const edit = await tools.ops_edit_file({path:'note.txt',expectedRevision:read.data.revision,
          edits:[{oldText:row.text,newText:row.text.replace('old','new')}]});
        return {read,edit};`)
      assert.equal(result.read.status, 'completed')
      assert.equal(result.read.data.revision, hash(before))
      assert.equal(result.edit.status, 'completed', JSON.stringify(result.edit))
      assert.equal(result.edit.data.items[0].revisionBefore, result.read.data.revision)
      const after = '\ufeffheader\r\nsetting=new\r\nlast'
      assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), after)
      assert.equal(result.edit.data.items[0].revision, hash(after))
    })
  })
})

await test('an external change inside the same run_code rejects the old read revision without editing', async () => {
  await withTempDir('ptc-compose-stale', async root => {
    fs.writeFileSync(path.join(root, 'note.txt'), 'original\n')
    await fixture(root, async call => {
      const result = await call(`
        const read = await tools.ops_inspect_local_file({path:'note.txt'});
        if (read.status !== 'completed') return {read};
        await tools.fixture_external_write({});
        const edit = await tools.ops_edit_file({path:'note.txt',expectedRevision:read.data.revision,
          edits:[{oldText:read.data.items[0].text,newText:'replacement'}]});
        return {read,edit};`)
      assert.equal(result.edit.status, 'conflict', JSON.stringify(result))
      assert.equal(result.edit.error.code, 'REVISION_CONFLICT')
      assert.equal(result.edit.error.effectState, 'none')
      assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'external\n')
    })
  })
})

await test('multi-file partial reads and failed siblings preserve facts without being mistaken for editable full files', async () => {
  await withTempDir('ptc-compose-pages', async root => {
    fs.writeFileSync(path.join(root, 'note.txt'), 'first\nsecond\n')
    fs.writeFileSync(path.join(root, 'other.txt'), 'other\n')
    await fixture(root, async call => {
      const result = await call(`
        const page = await tools.ops_read_files({files:[{path:'note.txt',limit:1},{path:'other.txt'}]});
        const failed = await tools.ops_read_files({files:[{path:'other.txt'},{path:'missing.txt'}]});
        return {page,failed};`)
      assert.equal(result.page.status, 'partial', JSON.stringify(result.page))
      assert.equal(result.page.data.items[0].complete, false)
      assert.equal(result.page.data.items[0].nextOffset, 2)
      assert.equal(result.page.data.items[1].complete, true)
      assert.equal(typeof result.page.continuation, 'string')
      assert.equal(result.failed.status, 'error')
      assert.equal(result.failed.error.effectState, 'none')
      assert.equal(result.failed.data.items[0].items[0].text, 'other')
      assert.ok(result.failed.data.items[1].error)
      assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'first\nsecond\n')
    })
  })
})
if (process.platform === 'win32') await test('replace keeps already-applied file receipts when a later Windows readonly publication fails', async () => {
  await withTempDir('ptc-compose-replace', async root => {
    const first = path.join(root, 'a.txt'), second = path.join(root, 'b.txt')
    fs.writeFileSync(first, 'old\n'); fs.writeFileSync(second, 'old\n'); fs.chmodSync(second, 0o444)
    try {
      await fixture(root, async call => {
        const result = await call(`return await tools.ops_replace({path:'.',glob:['*.txt'],pattern:'old',replacement:'new'});`)
        assert.equal(result.status, 'error', JSON.stringify(result))
        assert.equal(result.error.effectState, 'applied')
        assert.equal(result.error.retry, 'never')
        assert.equal(fs.readFileSync(first, 'utf8'), 'new\n')
        assert.equal(fs.readFileSync(second, 'utf8'), 'old\n')
        assert.equal(result.data.changed, 1)
        assert.equal(result.data.failed, 1)
        assert.equal(result.data.items[0].status, 'completed')
        assert.equal(result.data.items[0].revisionAfter, hash('new\n'))
        assert.equal(result.data.items[1].status, 'error')
        assert.equal('continuation' in result, false)
      })
    } finally { fs.chmodSync(second, 0o666) }
  })
})
await test('two files read in one run_code edit each with its own revision and both receipts match disk bytes', async () => {
  await withTempDir('ptc-compose-per-file', async root => {
    const aBefore = 'alpha one\n', bBefore = 'bravo one\n', cBefore = 'untouched\n'
    fs.writeFileSync(path.join(root, 'a.txt'), aBefore)
    fs.writeFileSync(path.join(root, 'b.txt'), bBefore)
    fs.writeFileSync(path.join(root, 'c.txt'), cBefore)
    await fixture(root, async call => {
      const result = await call(`
        const name = item => String(item.path).split(/[\\\\/]/).pop();
        const read = await tools.ops_read_files({files:[{path:'a.txt'},{path:'b.txt'}]});
        if (read.status !== 'completed' || read.data.status !== 'completed') return {read};
        // Attribute by path, not by array position: each receipt carries its own absolute path.
        const byName = Object.fromEntries(read.data.items.map(item => [name(item), item]));
        const a = byName['a.txt'], b = byName['b.txt'];
        if (!a || !b || !a.revision || !b.revision) return {read,names:Object.keys(byName)};
        const editA = await tools.ops_edit_file({path:'a.txt',expectedRevision:a.revision,
          edits:[{oldText:'alpha',newText:'ALPHA'}]});
        const editB = await tools.ops_edit_file({path:'b.txt',expectedRevision:b.revision,
          edits:[{oldText:'bravo',newText:'BRAVO'}]});
        return {read,aRevision:a.revision,bRevision:b.revision,
          aComplete:a.complete,bComplete:b.complete,aPath:name(a),bPath:name(b),editA,editB};`)
      assert.equal(result.read.status, 'completed', JSON.stringify(result.read))
      // Both files came back whole: `failed` lives on the result payload and must be exactly zero.
      assert.equal(result.read.data.failed, 0)
      assert.equal(result.aPath, 'a.txt')
      assert.equal(result.bPath, 'b.txt')
      assert.equal(result.aComplete, true)
      assert.equal(result.bComplete, true)
      // Each read receipt describes its own file, so it must match that file's bytes - and the two
      // baselines therefore have to differ without needing a separate comparison.
      assert.equal(result.aRevision, hash(aBefore))
      assert.equal(result.bRevision, hash(bBefore))
      assert.equal(result.editA.status, 'completed', JSON.stringify(result.editA))
      assert.equal(result.editB.status, 'completed', JSON.stringify(result.editB))
      assert.equal(result.editA.data.items[0].revisionBefore, result.aRevision)
      assert.equal(result.editB.data.items[0].revisionBefore, result.bRevision)
      const aAfter = 'ALPHA one\n', bAfter = 'BRAVO one\n'
      assert.equal(result.editA.data.items[0].revision, hash(aAfter))
      assert.equal(result.editB.data.items[0].revision, hash(bAfter))
      assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), aAfter)
      assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), bAfter)
      // A file that was never read or edited must not be touched by either edit.
      assert.equal(fs.readFileSync(path.join(root, 'c.txt'), 'utf8'), cBefore)
    })
  })
})
report('ptc-composition')
