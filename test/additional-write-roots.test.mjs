/** DSH 0.2.2 explicit writable roots are physical grants, not mutable aliases. */
import fs from 'node:fs'
import path from 'node:path'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { bootHost, shutdown } from './lib/host.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'
import { invoke } from '../lib/file/worker.js'
import { additionalWriteRoots, sameAuthority } from '../lib/authority-paths.js'
requireWorker('additional-write-roots')
await test('workspace-write accepts an explicit physical grant without changing workspace authority', () => withTempDir('extra-roots', async root => {
  const workspace = path.join(root, 'workspace'), extra = path.join(root, 'extra')
  fs.mkdirSync(workspace); fs.mkdirSync(extra)
  const { ctx } = await bootHost()
  try {
    await ctx.plugin(Subprocess)
    const policy = { mode: 'workspace-write', workspaceRoot: workspace, additionalWritableRoots: [extra] }
    ctx.provide('sandboxPolicy', { resolve: () => policy })
    const exec = { agent: { session: { id: 'extra-roots', header: { cwd: workspace } } }, signal: new AbortController().signal }
    const target = path.join(extra, 'created')
    const value = await invoke(ctx, WORKER, 'write_file', { path: target, content: 'authorized', expectedRevision: 'absent' }, exec, exec.signal)
    assert.equal(value.status, 'completed', JSON.stringify(value)); assert.equal(fs.readFileSync(target, 'utf8'), 'authorized')
    assert.equal(policy.workspaceRoot, workspace)
  } finally { await shutdown(ctx) }
}))
await test('missing, non-directory and junction grants are rejected rather than canonicalized into authority', () => withTempDir('invalid-grants', async root => {
  const physical = path.join(root, 'physical'), alias = path.join(root, 'alias'), file = path.join(root, 'file')
  fs.mkdirSync(physical); fs.writeFileSync(file, 'x')
  fs.symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir')
  for (const grant of [path.join(root, 'missing'), file, alias]) assert.throws(() => additionalWriteRoots({ additionalWritableRoots: [grant] }))
  assert.deepEqual(additionalWriteRoots({ additionalWritableRoots: [physical] }), [physical])
}))
await test('changes to explicit root grants change authority even when mode and workspace stay equal', () => {
  const policy = { mode: 'workspace-write', workspaceRoot: process.cwd(), additionalWritableRoots: ['one'] }
  assert.equal(sameAuthority(policy, { ...policy, additionalWritableRoots: ['two'] }), false)
  assert.equal(sameAuthority(policy, { ...policy, additionalWritableRoots: [] }), false)
  assert.equal(sameAuthority(policy, { ...policy, additionalWritableRoots: ['one'] }), true)
})
report('additional-write-roots')
