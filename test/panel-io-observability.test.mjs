/** Append failures and interrupted tails must not silently report complete capture. */
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createPanelCollector, parseAppendLog, resolvePanelConfig } from '../lib/panel/collect.js'
import { assert, report, test, withTempDir } from './lib/harness.mjs'

const config = resolvePanelConfig({ capture: true, textLimit: 10000, maxSessionBytes: 65536 })
const env = { DSH_HOME: path.join(tmpdir(), '_tmp_fix-capture', 'unrelated-home') }
const time = 1700000000000
const event = (text, seq) => ({ type: 'user/message', seq, time: time + seq,
  data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const directory = cwd => path.join(cwd, '.dsh-ops', 'panel')
const walPath = (cwd, id) => path.join(directory(cwd), id + '.ndjson')
const document = (cwd, id) => JSON.parse(fs.readFileSync(path.join(directory(cwd), id + '.json'), 'utf8'))
const wire = value => JSON.stringify(value) + '\n'
const record = (text, seq) => ({ record: 'event', seq, time: time + seq, type: 'user/message', role: 'user',
  payload: { text, chars: text.length, truncated: false, droppedChars: 0 } })

for (const partial of [false, true]) {
  await test('append failure remains degraded across restart, partial=' + partial, async () => {
    await withTempDir('panel-io-failure', async cwd => {
      const id = 'failed', session = { id, header: { cwd } }, warnings = []
      const wal = walPath(cwd, id)
      let failed = false
      const io = { ...fs.promises, appendFile: async (file, text) => {
        if (String(file) === wal && text.includes('"seq":1') && !failed) {
          failed = true
          if (partial) await fs.promises.appendFile(file, text.slice(0, 35))
          throw Object.assign(new Error('injected append failure'), { code: 'EIO' })
        }
        return fs.promises.appendFile(file, text)
      } }
      const first = createPanelCollector({ config, env, io, report: message => warnings.push(message) })
      try {
        first.observe(session, event('before failure', 0))
        first.observe(session, event('lost event', 1))
        first.observe(session, event('after failure', 2))
        await first.merge(id)
        const merged = document(cwd, id)
        assert.equal(merged.verify.degraded, true, 'failed append must degrade capture')
        assert.equal(merged.metrics.usageReported, false, 'missing events cannot establish complete usage')
        assert.deepEqual(merged.conversation.map(row => row.text), ['before failure', 'after failure'])
        assert.equal(warnings.length, 1)
        assert.equal(parseAppendLog(fs.readFileSync(wal, 'utf8')).malformed, partial ? 1 : 0)
      } finally { await first.stop() }
      const restarted = createPanelCollector({ config, env })
      try {
        restarted.observe(session, event('after restart', 3))
        await restarted.close(id)
        const sealed = document(cwd, id)
        assert.equal(sealed.verify.degraded, true, 'failure marker survives activation restart and seal')
        assert.equal(sealed.metrics.usageReported, false)
        assert.deepEqual(sealed.conversation.map(row => row.text), ['before failure', 'after failure', 'after restart'])
        assert.equal(fs.existsSync(wal), false)
      } finally { await restarted.stop() }
    })
  })
}

for (const tail of ['{"record":"event","payload":', JSON.stringify(record('complete tail', 1))]) {
  await test('recovery isolates an unterminated WAL tail: ' + tail.slice(0, 35), async () => {
    await withTempDir('panel-io-tail', async cwd => {
      const id = 'tail', session = { id, header: { cwd } }, wal = walPath(cwd, id)
      fs.mkdirSync(directory(cwd), { recursive: true })
      const prefix = wire({ record: 'open', sessionId: id, cwd }) + wire(record('prefix', 0))
      fs.writeFileSync(wal, prefix + tail)
      const collector = createPanelCollector({ config, env })
      try {
        collector.observe(session, event('first resumed event', 2))
        collector.observe(session, event('second resumed event', 3))
        await collector.close(id)
        const sealed = document(cwd, id)
        const complete = tail.endsWith('}')
        assert.deepEqual(sealed.conversation.map(row => row.text), [
          'prefix', ...(complete ? ['complete tail'] : []), 'first resumed event', 'second resumed event',
        ], 'the first resumed event must not be concatenated into the old tail')
        assert.equal(sealed.events.malformed, complete ? 0 : 1)
        assert.equal(sealed.verify.degraded, !complete)
        assert.equal(sealed.metrics.usageReported, complete)
      } finally { await collector.stop() }
    })
  })
}

await test('healthy append and restart preserve complete capture without warnings', async () => {
  await withTempDir('panel-io-healthy', async cwd => {
    const id = 'healthy', session = { id, header: { cwd } }, warnings = []
    const first = createPanelCollector({ config, env, report: value => warnings.push(value) })
    first.observe(session, event('before restart', 0))
    await first.flush(); await first.stop()
    const restarted = createPanelCollector({ config, env, report: value => warnings.push(value) })
    try {
      restarted.observe(session, event('after restart', 1))
      await restarted.close(id)
      const sealed = document(cwd, id)
      assert.equal(sealed.verify.degraded, false)
      assert.equal(sealed.metrics.usageReported, true)
      assert.equal(sealed.events.malformed, 0)
      assert.deepEqual(sealed.conversation.map(row => row.text), ['before restart', 'after restart'])
      assert.deepEqual(warnings, [])
    } finally { await restarted.stop() }
  })
})

for (const partial of [false, true]) {
  await test('a failed gap marker is retried safely before resumed events, partial=' + partial, async () => {
    await withTempDir('panel-io-marker', async cwd => {
      const id = 'marker', session = { id, header: { cwd } }, wal = walPath(cwd, id)
      let eventFailed = false, markerFailed = false
      const io = { ...fs.promises, appendFile: async (file, text) => {
        if (String(file) === wal && !eventFailed && text.includes('"seq":1')) {
          eventFailed = true
          throw new Error('injected event failure')
        }
        if (String(file) === wal && !markerFailed && text.includes('capture-failed')) {
          markerFailed = true
          if (partial) await fs.promises.appendFile(file, text.slice(0, 12))
          throw new Error('injected gap marker failure')
        }
        return fs.promises.appendFile(file, text)
      } }
      const collector = createPanelCollector({ config, env, io })
      try {
        collector.observe(session, event('retained prefix', 0))
        collector.observe(session, event('lost', 1))
        await collector.flush()
        collector.observe(session, event('retained suffix', 2))
        await collector.flush()
        assert.equal(eventFailed, true)
        assert.equal(markerFailed, true, 'the failure path must attempt a persisted gap marker')
        const parsed = parseAppendLog(fs.readFileSync(wal, 'utf8'))
        assert.equal(parsed.records.filter(row => row.record === 'capture-failed').length, 1)
        assert.equal(parsed.malformed, partial ? 1 : 0)
      } finally { await collector.stop() }
      const resumed = createPanelCollector({ config, env })
      try {
        resumed.observe(session, event('after restart', 3))
        await resumed.close(id)
        const sealed = document(cwd, id)
        assert.equal(sealed.verify.degraded, true)
        assert.equal(sealed.metrics.usageReported, false)
        assert.deepEqual(sealed.conversation.map(row => row.text), ['retained prefix', 'retained suffix', 'after restart'])
      } finally { await resumed.stop() }
    })
  })
}

for (const ending of ['stop', 'close']) {
  await test('persistent marker denial stays visible after ' + ending + ' and restart', async () => {
    await withTempDir('panel-io-persistent', async cwd => {
      const id = 'persistent', session = { id, header: { cwd } }, wal = walPath(cwd, id)
      const io = { ...fs.promises, appendFile: async (file, text) => {
        if (String(file) === wal && (text.includes('"seq":1') || text.includes('capture-failed'))) {
          throw new Error('injected persistent append denial')
        }
        return fs.promises.appendFile(file, text)
      } }
      const collector = createPanelCollector({ config, env, io })
      try {
        collector.observe(session, event('retained', 0))
        collector.observe(session, event('lost', 1))
        await collector.merge(id)
        const failed = document(cwd, id)
        assert.equal(failed.verify.degraded, true)
        assert.equal(failed.metrics.usageReported, false)
        assert.equal(failed.limits.captureFailed, true)
        assert.ok(failed.verify.notes.some(note => note.includes('采集追加失败')))
        if (ending === 'close') await collector.close(id)
      } finally { await collector.stop() }
      assert.equal(fs.existsSync(wal), true, 'an unpersisted gap prevents WAL removal')
      const resumed = createPanelCollector({ config, env })
      try {
        resumed.observe(session, event('after restart', 2))
        await resumed.close(id)
        const sealed = document(cwd, id)
        assert.equal(sealed.verify.degraded, true, 'the prior JSON preserves a gap absent from WAL')
        assert.equal(sealed.metrics.usageReported, false)
        assert.equal(sealed.limits.captureFailed, true)
        assert.deepEqual(sealed.conversation.map(row => row.text), ['retained', 'after restart'])
        assert.equal(fs.existsSync(wal), false)
      } finally { await resumed.stop() }
    })
  })
}

report('panel-io-observability')
