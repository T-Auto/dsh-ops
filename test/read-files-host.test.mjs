/** Multi-range reads cross the real Cordis/subprocess boundary once per call. */
import fs from 'node:fs'
import path from 'node:path'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { mountResident } from './lib/resident.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'
import { invoke } from '../lib/file/worker.js'
import { resolveReadFiles } from '../lib/file/read-files.js'
import { definition } from '../lib/file/contract.js'
import { publicToolName } from '../lib/policy.js'
requireWorker('read-many-host')
const execution = cwd => ({ agent: { session: { id: 'read-many-host', header: { cwd } } }, signal: new AbortController().signal })

await test('range normalization preserves caller data, invalid fields and the current cwd', () => {
  const input = { files: [{ path: 'a.txt', offset: null, limit: undefined, unknown: '' }, { path: 'b.txt', offset: 0 }] }
  const snapshot = structuredClone(input)
  const value = resolveReadFiles(input, process.cwd())
  assert.deepEqual(input, snapshot)
  assert.equal(value.files[0].path, path.resolve('a.txt'))
  assert.equal(Object.hasOwn(value.files[0], 'offset'), false)
  assert.equal(value.files[0].unknown, '')
  assert.equal(value.files[1].offset, 0, 'invalid bounds must reach authoritative validation')
  for (const files of [[], Array.from({ length: 33 }, () => ({ path: 'a' })), [null], [{ path: '' }], [{ path: 'a\0b' }]]) {
    assert.equal(typeof resolveReadFiles({ files }, process.cwd()).error, 'string')
  }
})

await test('one resident request reads all ranges, refreshes cwd and observes only returned successful files', async () => {
  await withTempDir('read-many-host', async root => {
    const first = path.join(root, 'first'), second = path.join(root, 'second')
    fs.mkdirSync(first); fs.mkdirSync(second)
    fs.writeFileSync(path.join(first, 'a.txt'), 'alpha\nlast\n')
    fs.writeFileSync(path.join(first, 'b.txt'), 'beta\n')
    fs.writeFileSync(path.join(first, 'binary'), Buffer.from([0xff]))
    fs.writeFileSync(path.join(second, 'a.txt'), 'changed cwd\n')
    const { ctx } = await bootHost()
    const observed = []; const sent = []
    try {
      await ctx.plugin(Subprocess)
      await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: () => ({ mode: 'read-only', workspaceRoot: root }) }))
      await ctx.plugin(inner => inner.provide('fs', {
        resolve: async file => file,
        stat: async file => ({ type: 'file', version: `before:${file}`, size: 0 }),
      }))
      ctx.on('fs/observed', (target, observation) => observed.push({ target, observation }))
      const processService = ctx.get('subprocess'), spawn = processService.spawn.bind(processService)
      let spawns = 0
      processService.spawn = spec => { ++spawns; return spawn(spec) }
      const kernel = await mountResident(ctx, { file: WORKER, cwd: root }), dispatch = kernel.invoke.bind(kernel)
      kernel.invoke = (envelope, ...rest) => { sent.push(envelope); return dispatch(envelope, ...rest) }
      const exec = execution(first)
      const value = await invoke(ctx, WORKER, 'read_files', { files: [{ path: 'a.txt', offset: 2 }, { path: 'binary' }, { path: 'b.txt' }] }, exec, exec.signal)
      assert.equal(sent.length, 1)
      assert.equal(Object.hasOwn(sent[0].request.args, 'path'), false)
      assert.deepEqual(sent[0].request.args.files.map(file => file.path), ['a.txt', 'binary', 'b.txt'].map(file => path.join(first, file)))
      assert.equal(value.status, 'partial', JSON.stringify(value))
      assert.equal(value.complete, false); assert.equal(value.pending, 0)
      assert.equal(value.items[0].items[0].text, 'last')
      assert.equal(value.items[0].items[0].line, 2)
      assert.equal(value.items[1].error.code, 'ERR_INVALID_ENCODING')
      assert.equal(value.items[2].items[0].text, 'beta')
      assert.deepEqual(observed.map(item => item.target), [path.join(first, 'a.txt'), path.join(first, 'b.txt')])
      assert.ok(observed.every(item => item.observation.version.startsWith('before:')))
      exec.agent.session.header.cwd = second
      const next = await invoke(ctx, WORKER, 'read_files', { files: [{ path: 'a.txt' }] }, exec, exec.signal)
      assert.equal(sent.length, 2)
      assert.equal(spawns, 1, 'both reads share the activation-owned kernel')
      assert.equal(next.items[0].items[0].text, 'changed cwd')
      assert.equal(sent[1].request.args.files[0].path, path.join(second, 'a.txt'))
      assert.deepEqual(fs.readdirSync(root).sort(), ['first', 'second'], 'read-only calls leave no audit or job files')
    } finally { await shutdown(ctx) }
  })
})

await test('every credential path and invalid descriptor is rejected before spawn; preparation races stop the whole read', async () => {
  await withTempDir('read-many-preflight', async root => {
    const { ctx } = await bootHost()
    let spawned = 0, resolves = 0, race = false
    try {
      await ctx.plugin(inner => inner.provide('subprocess', { spawn() { spawned++; throw new Error('unexpected spawn') } }))
      await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: () => ({ mode: race && ++resolves > 1 ? 'read-only' : 'workspace-write', workspaceRoot: root }) }))
      const exec = execution(root)
      for (const [files, code] of [[[{ path: 'safe' }, { path: '.env' }], 'CREDENTIAL_DENIED'], [[{ path: 'safe' }, { path: '' }], 'INVALID_ARGUMENT'], [[], 'INVALID_ARGUMENT']]) {
        const value = await invoke(ctx, WORKER, 'read_files', { files }, exec, exec.signal)
        assert.equal(value.error.code, code, JSON.stringify(value))
        assert.equal(value.error.effectState, 'none')
      }
      race = true
      const changed = await invoke(ctx, WORKER, 'read_files', { files: [{ path: 'safe' }] }, exec, exec.signal)
      assert.equal(changed.error.code, 'AUTHORITY_CHANGED')
      assert.equal(spawned, 0)
    } finally { await shutdown(ctx) }
  })
})

await test('multi-read rendering separates physical lines, file errors and pending-file continuation', () => {
  const value = { status: 'partial', complete: false, nextIndex: 2, pending: 1, items: [
    { path: '/a', status: 'completed', complete: false, lineCount: 8, nextOffset: 3, items: [{ path: '/a', line: 2, text: 'second' }] },
    { path: '/b', status: 'error', complete: false, error: { code: 'ERR_INVALID_ENCODING', effectState: 'none', nextAction: 'Use view=hex.', message: 'Invalid UTF-8.' } },
  ] }
  const tool = definition('read_files', async () => value)
  assert.equal(tool.name, publicToolName('read_files'))
  const before = JSON.stringify(value), view = tool.output.render({}, value)[0].text
  assert.match(view, /FILE: \/a \(Lines 2-2 of 8\)/)
  assert.match(view, /2 \| second/)
  assert.match(view, /nextOffset=3/)
  assert.match(view, /FILE: \/b/)
  assert.match(view, /ERR_INVALID_ENCODING/)
  assert.match(view, /nextIndex=2; pending=1/)
  assert.equal(JSON.stringify(value), before)
  assert.equal(definition('edit_file', async () => value).isConcurrencySafe, undefined)
})
report('read-many-host')
