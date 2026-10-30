/** A live directory changes while the creation-time session header stays untouched. */
import fs from 'node:fs'
import path from 'node:path'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'
import { invoke } from '../lib/file/worker.js'
import { definition } from '../lib/file/contract.js'

requireWorker('session-cwd')

async function fixture(body) {
  await withTempDir('live-cwd', async root => {
    const tools = path.join(root, 'tools'); fs.mkdirSync(tools)
    fs.writeFileSync(path.join(root, 'probe.txt'), 'ROOT\n')
    fs.writeFileSync(path.join(tools, 'probe.txt'), 'TOOLS\n')
    const { ctx } = await bootHost()
    const exec = { agent: { session: { id: 'live-cwd', header: { cwd: root } } }, signal: new AbortController().signal }
    let cwd = tools, ensure = 0
    const sent = [], observations = []
    try {
      await ctx.plugin(Subprocess)
      await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root }) }))
      await ctx.plugin(inner => inner.provide('workingDirectory', {
        async ensure(agent, signal) { assert.equal(agent, exec.agent); signal.throwIfAborted(); ensure++; return cwd },
        get: () => cwd,
      }))
      await ctx.plugin(inner => inner.provide('fs', {
        resolve: async (file, options) => path.resolve(options.cwd, file),
        stat: async file => ({ type: 'file', version: 'observed:' + file, size: fs.statSync(file).size }),
      }))
      ctx.on('fs/observed', target => observations.push(target))
      const subprocess = ctx.get('subprocess'), spawn = subprocess.spawn.bind(subprocess)
      subprocess.spawn = spec => { sent.push({ cwd: spec.cwd, ...JSON.parse(spec.stdio.stdin.data).request }); return spawn(spec) }
      const call = (tool, args) => invoke(ctx, WORKER, tool, args, exec, exec.signal)
      await body({ root, tools, ctx, exec, call, sent, observations, setCwd: value => { cwd = value }, ensures: () => ensure })
    } finally { await shutdown(ctx) }
  })
}

await test('reads follow live cwd and share that base with worker spawn, envelope and host observation', () => fixture(async f => {
  const value = await f.call('read_files', { files: [{ path: 'probe.txt' }] })
  assert.equal(value.status, 'completed', JSON.stringify(value))
  assert.equal(value.items[0].items[0].text, 'TOOLS')
  assert.equal(f.sent[0].cwd, f.tools); assert.equal(f.sent[0].root, f.tools)
  assert.deepEqual(f.observations, [path.join(f.tools, 'probe.txt')])
  assert.equal(f.ensures(), 1)
  assert.equal(value.resolvedFrom, f.tools); assert.equal(value.cwdSource, 'workingDirectory')
  const rendered = definition('read_files', async () => value).output.render({}, value)[0].text
  assert.ok(rendered.includes('resolvedFrom=') && rendered.includes('workingDirectory'))
  f.setCwd(f.root)
  const next = await f.call('read_files', { files: [{ path: 'probe.txt' }] })
  assert.equal(next.items[0].items[0].text, 'ROOT')
  assert.equal(f.exec.agent.session.header.cwd, f.root)
}))

await test('omitted search paths scan the live directory and report the actual base even on zero hits', () => fixture(async f => {
  const glob = await f.call('glob', { pattern: ['*.txt'] })
  assert.equal(glob.status, 'completed', JSON.stringify(glob))
  assert.equal(glob.resolvedFrom, f.tools)
  assert.deepEqual(glob.items, [path.join(f.tools, 'probe.txt')])
  const grep = await f.call('grep', { pattern: 'ROOT' })
  assert.equal(grep.status, 'completed', JSON.stringify(grep))
  assert.equal(grep.items.length, 0)
  assert.ok(definition('grep', async () => grep).output.render({}, grep)[0].text.includes('resolvedFrom='))
}))

await test('create, copy and move resolve both relative operands at the live cwd', () => fixture(async f => {
  const created = await f.call('write_file', { path: 'created.txt', content: 'created', expectedRevision: 'absent' })
  assert.equal(created.status, 'completed', JSON.stringify(created))
  assert.equal(fs.readFileSync(path.join(f.tools, 'created.txt'), 'utf8'), 'created')
  assert.equal(fs.existsSync(path.join(f.root, 'created.txt')), false)
  const source = await f.call('stat', { path: 'probe.txt' })
  const copied = await f.call('copy', { path: 'probe.txt', to: 'copy.txt', expectedRevision: source.revision })
  assert.equal(copied.status, 'completed', JSON.stringify(copied))
  assert.equal(fs.readFileSync(path.join(f.tools, 'copy.txt'), 'utf8'), 'TOOLS\n')
  const revision = await f.call('stat', { path: 'copy.txt' })
  const moved = await f.call('move', { path: 'copy.txt', to: 'moved.txt', expectedRevision: revision.revision })
  assert.equal(moved.status, 'completed', JSON.stringify(moved))
  assert.equal(fs.readFileSync(path.join(f.tools, 'moved.txt'), 'utf8'), 'TOOLS\n')
  assert.equal(fs.existsSync(path.join(f.root, 'moved.txt')), false)
}))

await test('a live cwd outside workspaceRoot never grants write authority', () => fixture(async f => {
  await withTempDir('outside-live-cwd', async outside => {
    f.setCwd(outside)
    const result = await f.call('write_file', { path: 'forbidden.txt', content: 'no', expectedRevision: 'absent' })
    assert.equal(result.status, 'rejected', JSON.stringify(result))
    assert.equal(f.sent.length, 0)
    assert.equal(fs.existsSync(path.join(outside, 'forbidden.txt')), false)
    assert.equal(fs.existsSync(path.join(f.root, 'forbidden.txt')), false)
  })
}))

await test('service failures, invalid live paths and cancellation never fall back to the old tree', () => fixture(async f => {
  const service = f.ctx.get('workingDirectory')
  for (const outcome of [() => { throw new Error('directory unavailable') }, () => 'relative', () => undefined]) {
    service.ensure = async () => outcome()
    const result = await f.call('read_files', { files: [{ path: 'probe.txt' }] })
    assert.equal(result.status, 'error', JSON.stringify(result)); assert.equal(result.error.effectState, 'none')
  }
  const controller = new AbortController()
  service.ensure = async () => { controller.abort(); return f.tools }
  f.exec.signal = controller.signal
  const cancelled = await f.call('read_files', { files: [{ path: 'probe.txt' }] })
  assert.equal(cancelled.status, 'error', JSON.stringify(cancelled))
  assert.equal(f.sent.length, 0)
}))

await test('legacy hosts without workingDirectory explicitly report the snapshot fallback', () => withTempDir('legacy-cwd', async root => {
  fs.writeFileSync(path.join(root, 'probe.txt'), 'LEGACY\n')
  const { ctx } = await bootHost()
  try {
    await ctx.plugin(Subprocess)
    await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: () => ({ mode: 'read-only', workspaceRoot: root }) }))
    const exec = { agent: { session: { id: 'legacy-cwd', header: { cwd: root } } }, signal: new AbortController().signal }
    const result = await invoke(ctx, WORKER, 'read_files', { files: [{ path: 'probe.txt' }] }, exec, exec.signal)
    assert.equal(result.items[0].items[0].text, 'LEGACY')
    assert.equal(result.resolvedFrom, root); assert.equal(result.cwdSource, 'session.header.cwd')
  } finally { await shutdown(ctx) }
}))

report('session-cwd')
