import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { AclWriteGrant, assertTempRootOutsideWorkspace, tempWriteSid, workspaceWriteSid } from '@deepseek-ai/dsh-sandbox-windows-acl'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { assert, test, report, withTempDir, skipSuite } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'
import { definition as fileDefinition } from '../lib/file/contract.js'
import { definition as ptcDefinition } from '../lib/ptc/contract.js'
import { invoke as fileCall } from '../lib/file/worker.js'
import { invoke as ptcCall } from '../lib/ptc/worker.js'
import { resultStorage } from '../lib/kernel/result-storage.js'
import { mountResultLifecycle, expireResultSession } from '../lib/kernel/result-lifecycle.js'
requireWorker('result-storage-cache-prep')
if (process.platform !== 'win32') skipSuite('result-storage-cache-prep', 'Windows cache preparation is Windows-specific')
class CacheSandbox extends LocalSandboxProvider {
  prepares = 0; confines = 0
  async confine(...args) { this.confines++; return super.confine(...args) }
  async prepareResultStorage(argv, policy, signal) {
    this.prepares++; signal?.throwIfAborted()
    if (policy.mode !== 'workspace-write' || !policy.sessionId) throw new Error('invalid cache authority')
    const root = canonicalPath(policy.workspaceRoot)
    assertTempRootOutsideWorkspace(root, os.tmpdir())
    const key = JSON.stringify([String(policy.sessionId), root])
    let cap = this.tempCapabilities.get(key)
    if (!cap) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-')), writeSid = tempWriteSid(dir)
      let grant
      try { grant = AclWriteGrant.create(writeSid); grant.add(dir) }
      catch (error) { try { grant?.dispose() } finally { this.removeTempDir(dir) } throw error }
      cap = { dir, writeSid, grant }; this.tempCapabilities.set(key, cap)
    }
    return { argv: [...this.windowsAclRunnerInvocation(), '--workspace', root, '--temp', cap.dir, '--mode', 'workspace-write', '--write-sid', workspaceWriteSid(root), '--temp-write-sid', cap.writeSid, '--', ...argv], enforcement: 'partial' }
  }
}
if (process.platform === 'win32') await test('native operations prepare only session cache; PTC pages shared references and lifecycle purges', async () => {
  await withTempDir('cache-prep', async root => {
    fs.writeFileSync(path.join(root, 'small.txt'), 'needle\n'); fs.writeFileSync(path.join(root, 'large.txt'), 'x'.repeat(180000) + '\n')
    const {ctx} = await bootHost(), session = { id: 'cache-prep', header: { cwd: root } }, agent = { session }
    try {
      await ctx.plugin(Subprocess); await ctx.plugin(CacheSandbox)
      const sandbox = ctx.get('sandbox')
      await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root, sessionId: session.id }) }))
      await ctx.plugin(inner => mountResultLifecycle(inner))
      await ctx.plugin(inner => { inner.inject(['tools'], scoped => {
        for (const tool of ['inspect_local_file', 'glob', 'grep']) scoped.tools.register(fileDefinition(tool, async () => ({})))
        scoped.tools.register(ptcDefinition('result', async () => ({})))
      }) })
      const call = (tool,args) => fileCall(ctx, WORKER, tool, args, {agent}, undefined, {denyCredentialReads:false})
      assert.equal((await call('inspect_local_file', {path:'small.txt'})).status, 'completed')
      assert.equal((await call('glob', {pattern:['*.txt']})).status, 'completed')
      assert.equal((await call('grep', {pattern:'needle',path:root})).status, 'completed')
      const large = await call('inspect_local_file', {path:'large.txt'})
      assert.equal(large.status,'completed'); assert.ok(large.reference?.refId, JSON.stringify(large.storageError))
      assert.equal(sandbox.prepares, 1); assert.equal(sandbox.confines, 0)
      const page = await ptcCall(ctx, WORKER, 'result', {action:'page', id:large.reference.refId}, {agent}, undefined, {denyCredentialReads:false})
      assert.equal(page.error, undefined, JSON.stringify(page.error)); assert.ok(page.items.length)
      assert.equal(sandbox.confines,1)
      const normal = sandbox.confine.bind(sandbox)
      sandbox.confine = async (...args) => { const result = await normal(...args); const argv = [...result.argv]; argv[argv.indexOf('--temp-write-sid') + 1] = 'S-1-4-123-456-1'; return {...result, argv} }
      const mismatch = await ptcCall(ctx, WORKER, 'result', {action:'page', id:large.reference.refId}, {agent}, undefined, {denyCredentialReads:false})
      assert.equal(mismatch.error?.code, 'EXECUTOR_UNAVAILABLE')
      sandbox.confine = normal
      const cap = [...sandbox.tempCapabilities.values()][0], dir = cap.dir
      const cache = path.join(dir, `s-${createHash('sha256').update(session.id).digest('hex')}`)
      assert.ok(fs.readdirSync(cache).some(name => name.endsWith('.json')))
      await expireResultSession(ctx,session)
      assert.equal(sandbox.confines,2); assert.ok(sandbox.prepares >= 2)
      assert.equal(fs.readdirSync(cache).filter(name => name.endsWith('.json')).length,0)
    } finally { await shutdown(ctx) }
  })
})


if (process.platform === 'win32') await test('read-only never prepares storage and changed authority prevents cleanup', async () => {
  await withTempDir('cache-readonly', async root => {
    const {ctx} = await bootHost(), session = {id:'cache-readonly', header:{cwd:root}}
    let mode = 'read-only'
    try {
      await ctx.plugin(Subprocess); await ctx.plugin(CacheSandbox)
      const sandbox = ctx.get('sandbox'), policy = () => ({mode, workspaceRoot:root, sessionId:session.id})
      await ctx.plugin(inner => inner.provide('sandboxPolicy', {resolve:policy}))
      const denied = await resultStorage(ctx,session,undefined,WORKER,'glob',policy(),[],false)
      assert.equal(denied,undefined); assert.equal(sandbox.prepares,0); assert.equal(sandbox.confines,0)
      mode = 'workspace-write'
      const foreign = await resultStorage(ctx,session,undefined,WORKER,'glob',{...policy(),sessionId:'other-session'},[],false)
      assert.equal(foreign,undefined); assert.equal(sandbox.prepares,0)
      const storage = await resultStorage(ctx,session,undefined,WORKER,'glob',policy(),[],false)
      assert.ok(storage); assert.equal(sandbox.prepares,1)
      mode = 'read-only'; await expireResultSession(ctx,session)
      assert.equal(sandbox.prepares,1); assert.equal(sandbox.confines,0)
    } finally { await shutdown(ctx) }
  })
})
if (process.platform === 'win32') await test('legacy host retains its normal confinement fallback', async () => {
  await withTempDir('cache-legacy', async root => {
    const {ctx} = await bootHost(), session = {id:'cache-legacy',header:{cwd:root}}
    try {
      await ctx.plugin(Subprocess); await ctx.plugin(CacheSandbox)
      const sandbox = ctx.get('sandbox'); sandbox.prepareResultStorage = undefined
      const policy = {mode:'workspace-write', workspaceRoot:root, sessionId:session.id}
      const storage = await resultStorage(ctx,session,undefined,WORKER,'glob',policy,[],false)
      assert.ok(storage); assert.equal(sandbox.confines,1)
    } finally { await shutdown(ctx) }
  })
})
report('result-storage-cache-prep')
