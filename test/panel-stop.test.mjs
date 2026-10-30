import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { parse } from 'yaml'
import { reconcileProfilePatches } from '@deepseek-ai/dsh-app-boot'
import { createPanelCollector, resolvePanelConfig } from '../lib/panel/collect.js'
import * as Panel from '../lib/components/panel/index.js'
import { profileFixture } from './lib/settings-profile.mjs'
import { shutdown } from './lib/host.mjs'
import { assert, test, report, waitFor } from './lib/harness.mjs'
// Exercises the pre-merge panel module directly.
process.env.DSH_OPS_LEGACY_ROWS = '1'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const event = (text, seq = 0) => ({ type: 'user/message', seq, time: 1700000000000 + seq,
  data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const session = (cwd, id) => ({ id, header: { cwd } })
const config = resolvePanelConfig({ capture: true })
const env = { DSH_HOME: path.join(tmpdir(), 'panel-stop-unrelated-home') }

await test('stopping during initial I/O cancels all queued writes and waits for that I/O', async () => {
  const entered = deferred(), release = deferred(), writes = [], warnings = []
  const io = Object.fromEntries(['mkdir', 'appendFile', 'writeFile', 'rename', 'rm', 'stat'].map(name => [name, async () => { writes.push(name) }]))
  io.readFile = async () => { entered.resolve(); await release.promise; throw Object.assign(new Error('absent'), { code: 'ENOENT' }) }
  const collector = createPanelCollector({ config, env, io, report: value => warnings.push(value) })
  const captured = session(tmpdir(), 'queued')
  collector.observe(captured, event('must not land'))
  collector.observe(captured, { type: 'turn/end', seq: 1, time: 1700000000001, data: {} })
  await entered.promise
  let settled = false
  const stopping = collector.stop().then(() => { settled = true })
  assert.equal(collector.stop(), collector.stop(), 'stop is idempotent')
  await Promise.resolve()
  assert.equal(settled, false, 'in-flight I/O is still owned by the component')
  collector.observe(captured, event('after stop', 2))
  release.resolve()
  await stopping
  assert.deepEqual(writes, [])
  assert.deepEqual(warnings, [], 'shutdown is not a capture failure')
  assert.equal(collector.size, 0)
})

await test('stop waits for an issued append but never starts the queued append or final fold', async () => {
  const cwd = fs.mkdtempSync(path.join(tmpdir(), 'dsh-ops-panel-stop-'))
  try {
    const entered = deferred(), release = deferred()
    let block = false, writes = 0
    const io = { ...fs.promises, appendFile: async (...args) => {
      writes++
      if (block) { entered.resolve(); await release.promise }
      return fs.promises.appendFile(...args)
    } }
    const collector = createPanelCollector({ config, env, io })
    const captured = session(cwd, 'inflight')
    collector.observe(captured, event('initial'))
    await collector.flush()
    block = true
    collector.observe(captured, event('issued', 1))
    await entered.promise
    collector.observe(captured, event('queued', 2))
    void collector.close(captured.id)
    let finished = false
    const stopping = collector.stop().then(() => { finished = true })
    await Promise.resolve()
    assert.equal(finished, false)
    release.resolve()
    await stopping
    const dir = path.join(cwd, '.dsh-ops/panel')
    assert.equal(writes, 3, 'header, initial event and the already-issued event only')
    assert.deepEqual(fs.readdirSync(dir), ['inflight.ndjson'], 'no final materialisation or log removal')
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'inflight.ndjson'), 'utf8'), /queued/)
  } finally { fs.rmSync(cwd, { recursive: true, force: true }) }
})

await test('real settings capture toggle and Loader row disable physically stop writes, then re-enable cleanly', async () => {
  const cwd = fs.mkdtempSync(path.join(tmpdir(), 'dsh-ops-panel-toggle-'))
  const fixture = await profileFixture('panel-toggle', Panel, { capture: true })
  const { ctx, patchPath, snapshot, mutate } = fixture
  const dir = path.join(cwd, '.dsh-ops/panel')
  const emit = (id, text, seq = 0) => ctx.emit('session/event', session(cwd, id), event(text, seq))
  const contents = () => Object.fromEntries(fs.readdirSync(dir).map(file => [file, fs.readFileSync(path.join(dir, file), 'utf8')]))
  try {
    emit('first', 'captured')
    await waitFor(() => fs.existsSync(path.join(dir, 'first.ndjson')) && fs.readFileSync(path.join(dir, 'first.ndjson'), 'utf8').includes('captured'))
    await mutate([{ op: 'set', path: ['capture'], value: false }], snapshot().revision)
    await ctx.loader.await()
    const stopped = contents()
    assert.match(fs.readFileSync(patchPath, 'utf8'), /capture: false/)
    emit('first', 'off', 1); emit('off', 'new while off')
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(contents(), stopped)
    await mutate([{ op: 'set', path: ['capture'], value: true }], snapshot().revision)
    await ctx.loader.await()
    emit('second', 're-enabled')
    await waitFor(() => fs.existsSync(path.join(dir, 'second.ndjson')))
    const patches = parse(fs.readFileSync(patchPath, 'utf8'))
    patches.push({ id: 'panel-toggle', disabled: true })
    fs.writeFileSync(patchPath, JSON.stringify(patches))
    await reconcileProfilePatches(ctx, patches, 'dsh', ['panel-toggle'])
    await ctx.loader.await()
    const disabled = contents()
    emit('disabled', 'must not collect')
    ctx.emit('session/disposed', session(cwd, 'second'))
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(contents(), disabled)
    assert.equal(snapshot(), undefined)
    patches.at(-1).disabled = false
    fs.writeFileSync(patchPath, JSON.stringify(patches))
    await reconcileProfilePatches(ctx, patches, 'dsh', ['panel-toggle'])
    await ctx.loader.await()
    emit('third', 'row re-enabled')
    await waitFor(() => fs.existsSync(path.join(dir, 'third.ndjson')))
    assert.equal(snapshot().value.capture, true)
    assert.equal(fs.existsSync(path.join(dir, 'disabled.ndjson')), false)
  } finally { await shutdown(ctx); fs.rmSync(cwd, { recursive: true, force: true }) }
})
report('panel-stop')
