/**
 * P14: opt-in data capture and the panel landing zone (issue #205 §五).
 *
 * The suite never touches the real `~/.dsh`: every workspace is a directory the
 * runner's temporary home owns, and the collector is handed a synthetic DSH home
 * so the "never write the harness home" guard is exercised without naming the
 * developer's own. Nothing here calls a model, opens a socket, or measures time.
 *
 * @module dsh-ops/test/ops-panel-collect
 */

import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import {
  PANEL_FORMAT, createPanelCollector, fitDocument, foldRecords, panelPaths,
  parseAppendLog, projectEvent, resolvePanelConfig, safeSessionId,
} from '../lib/panel/collect.js'
import { renderPanelHtml } from '../lib/panel/render.js'
import { apply } from '../lib/components/panel/index.js'
import { assert, PACKAGE_ROOT, report, test, waitFor, withTempDir } from './lib/harness.mjs'

/** A DSH home outside every fixture, so a fixture workspace is never "inside the home". */
const SYNTHETIC_HOME = Object.freeze({ DSH_HOME: path.join(tmpdir(), 'dsh-ops-panel-suite-home') })

/** A context stub that records what the component registered. */
function fakeContext() {
  const calls = { on: [], effect: 0, warnings: [] }
  return {
    calls,
    logger: {
      warn: (message) => calls.warnings.push(String(message)),
      error: () => {},
      info: () => {},
    },
    on(name) { calls.on.push(name) },
    effect(callback) { calls.effect += 1; return typeof callback === 'function' ? () => {} : undefined },
  }
}

/** An observed event, with a monotonic clock the assertions can name. */
function event(type, data, seq, time = 1_700_000_000_000 + seq) {
  return { type, seq, time, data }
}

/** The minimum an observer needs: an id and the working directory the session runs in. */
function sessionFixture(cwd, id = 'sess-1') {
  return { id, header: { cwd } }
}

/** The files one captured session owns below `<cwd>/.dsh-ops/panel`. */
function panelDir(cwd) {
  return path.join(cwd, '.dsh-ops', 'panel')
}

await test('the default configuration captures nothing', () => {
  const config = resolvePanelConfig()
  assert.equal(config.capture, false)
  assert.equal(config.textLimit, 2_000)
  assert.equal(config.maxSessionBytes, 8 * 1024 * 1024)
  assert.ok(Object.isFrozen(config))
  // Unknown keys and mistyped values fail loud, like every other component's validator.
  assert.throws(() => resolvePanelConfig({ capture: 'yes' }), /capture must be a boolean/)
  assert.throws(() => resolvePanelConfig({ captures: true }), /unknown key "captures"/)
  assert.throws(() => resolvePanelConfig({ textLimit: 1 }), /textLimit must be an integer/)
  assert.throws(() => resolvePanelConfig({ maxSessionBytes: 1 }), /maxSessionBytes must be an integer/)
})

await test('capture off registers no listener, no effect, and writes no file', async () => {
  await withTempDir('panel-off', async (cwd) => {
    const ctx = fakeContext()
    apply(ctx, {})
    apply(ctx, { capture: false, textLimit: 2000, maxSessionBytes: 8388608 })
    assert.deepEqual(ctx.calls.on, [], 'the off row must register no event listener')
    assert.equal(ctx.calls.effect, 0, 'the off row must register no effect')
    assert.equal(fs.existsSync(path.join(cwd, '.dsh-ops')), false, 'the off row must create no directory')
  })
})

await test('capture on is lazy: listeners register, but no directory exists before an event', async () => {
  await withTempDir('panel-lazy', async (cwd) => {
    const ctx = fakeContext()
    apply(ctx, { capture: true })
    assert.deepEqual(ctx.calls.on, ['session/event', 'session/disposed'])
    assert.equal(ctx.calls.effect, 1)
    assert.equal(fs.existsSync(path.join(cwd, '.dsh-ops')), false, 'mounting alone must not create files')
  })
})

await test('a captured session writes JSON and the viewer into <cwd>/.dsh-ops/panel/', async () => {
  await withTempDir('panel-on', async (cwd) => {
    const collector = createPanelCollector({ config: resolvePanelConfig({ capture: true }), env: SYNTHETIC_HOME, now: () => 1_700_000_000_000 })
    const session = sessionFixture(cwd)
    const paths = panelPaths(cwd, session.id, { env: SYNTHETIC_HOME })
    assert.equal(paths.dir, panelDir(cwd))
    assert.equal(paths.data, path.join(panelDir(cwd), 'sess-1.json'))
    assert.equal(paths.html, path.join(panelDir(cwd), 'panel.html'))

    collector.observe(session, event('user/message', { role: 'user', content: [{ type: 'text', text: '请统计一下' }], source: { kind: 'user' } }, 0))
    collector.observe(session, event('turn/start', { turn: 1 }, 1))
    collector.observe(session, event('step/start', { turn: 1, step: 1 }, 2))
    collector.observe(session, event('assistant/message', {
      turn: 1, step: 1, stream: [],
      message: { content: [{ type: 'text', text: '好的' }, { type: 'tool-call', id: 'call-1', name: 'ops_stat', arguments: '{}' }] },
      usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 },
    }, 3))
    collector.observe(session, event('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'ops_stat', arguments: '{"path":"a"}' }, 4))
    collector.observe(session, event('tool/result', {
      turn: 1, step: 1,
      message: { role: 'tool', content: [{ type: 'text', text: 'size 12' }], source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1' },
    }, 5))
    // A turn end is the idle point; the fold is scheduled without an explicit merge.
    collector.observe(session, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 6))

    await waitFor(() => fs.existsSync(paths.data), { what: 'the merged JSON after turn end' })
    const document = JSON.parse(fs.readFileSync(paths.data, 'utf8'))
    assert.equal(document.schemaVersion, 1)
    assert.equal(document.format, PANEL_FORMAT)
    assert.equal(document.meta.sessionId, 'sess-1')
    assert.equal(document.meta.cwd, fs.realpathSync.native(cwd))
    assert.deepEqual(document.conversation.map((row) => row.role), ['user', 'assistant', 'tool'])
    assert.equal(document.conversation[0].text, '请统计一下')
    assert.deepEqual(document.trace.map((row) => row.kind), [
      'user_message', 'turn_start', 'step_start', 'assistant_message', 'tool_call', 'tool_result', 'turn_end',
    ])
    assert.equal(document.trace.find((row) => row.kind === 'tool_result').durationMs, 1)
    assert.deepEqual(document.trace.find((row) => row.kind === 'tool_call').lane, 'tool_call')
    assert.equal(document.metrics.turns, 1)
    assert.equal(document.metrics.steps, 1)
    assert.equal(document.metrics.toolCalls, 1)
    assert.equal(document.metrics.toolErrors, 0)
    assert.equal(document.metrics.stepsWithUsage, 1)
    assert.equal(document.metrics.usageReported, true)
    assert.deepEqual(document.metrics.usage, {
      inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1, grandTotal: 17,
    })
    assert.deepEqual(document.metrics.toolCallsByName, { ops_stat: 1 })
    assert.equal(document.metrics.turnEndReason, 'completed')
    assert.equal(document.limits.truncated, false)
    assert.ok(fs.existsSync(paths.html), 'the viewer must land beside the data')
    assert.ok(fs.existsSync(paths.wal), 'the append log stays while the session is live')
    assert.deepEqual(document.archive.map((entry) => entry.role).sort(), ['events', 'panel'])
    assert.deepEqual(document.events.files.map((entry) => entry.path), ['sess-1.ndjson'])
    assert.equal(document.events.layout, 'merged')
    assert.equal(document.events.merged, true)
    await collector.dispose()
  })
})

await test('panel.html never inlines run data, in any of five encodings', async () => {
  await withTempDir('panel-sentinel', async (cwd) => {
    const raw = 'DSH_OPS_PANEL_SENTINEL_RAW_7f3a'
    const escapedInner = '<!--DSH_OPS_PANEL_SENTINEL_ESC_7f3a-->'
    const urlRaw = 'DSH_OPS_PANEL_SENTINEL_URL_7f3a'
    const base64Raw = 'DSH_OPS_PANEL_SENTINEL_B64_7f3a'
    const jsonRaw = 'DSH_OPS_PANEL_SENTINEL_JSON_7f3a'
    const unicodeEscaped = jsonRaw.split('').map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')
    const variants = [
      raw,
      '&lt;!--DSH_OPS_PANEL_SENTINEL_ESC_7f3a--&gt;',
      encodeURIComponent(urlRaw),
      Buffer.from(base64Raw, 'utf8').toString('base64'),
      JSON.stringify(jsonRaw).slice(1, -1),
      unicodeEscaped,
    ]
    const collector = createPanelCollector({ config: resolvePanelConfig({ capture: true }), env: SYNTHETIC_HOME, now: () => 1_700_000_000_000 })
    const session = sessionFixture(cwd, 'sentinel')
    collector.observe(session, event('user/message', {
      role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: [raw, escapedInner, urlRaw, base64Raw, jsonRaw].join(' ') }],
    }, 0))
    collector.observe(session, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1))
    const paths = collector.pathsFor('sentinel')
    await waitFor(() => fs.existsSync(paths.data), { what: 'the merged JSON' })
    const html = fs.readFileSync(paths.html, 'utf8')
    const json = fs.readFileSync(paths.data, 'utf8')
    // The JSON carries the text (so the assertion below is not vacuous) ...
    assert.ok(json.includes(raw), 'the data document is the place the text lands')
    for (const variant of [...new Set(variants)]) {
      assert.equal(html.includes(variant), false, `panel.html must not inline ${JSON.stringify(variant)}`)
    }
    // ... and the viewer has no sink that could turn text into markup.
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
      assert.equal(html.includes(sink), false, `the viewer must not use ${sink}`)
    }
    assert.ok(html.startsWith('<!doctype html>'))
    assert.ok(renderPanelHtml().includes('panel.html'), 'the viewer documents how it is loaded')
    await collector.dispose()
  })
})

await test('an append log left by a crash is folded into the JSON and then sealed', async () => {
  await withTempDir('panel-crash', async (cwd) => {
    const dir = panelDir(cwd)
    fs.mkdirSync(dir, { recursive: true })
    const wal = path.join(dir, 'crash-1.ndjson')
    fs.writeFileSync(wal, [
      JSON.stringify({ record: 'open', sessionId: 'crash-1', cwd, at: '2023-01-01T00:00:00.000Z' }),
      JSON.stringify({ record: 'event', seq: 0, time: 1, type: 'user/message', role: 'user', payload: { text: 'written before the crash', chars: 24, truncated: false, droppedChars: 0 } }),
      'this line is not JSON',
    ].join('\n') + '\n')

    const collector = createPanelCollector({ config: resolvePanelConfig({ capture: true }), env: SYNTHETIC_HOME, now: () => 1_700_000_000_000 })
    const session = sessionFixture(cwd, 'crash-1')
    collector.observe(session, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1))
    await collector.flush()
    const data = path.join(dir, 'crash-1.json')
    await waitFor(() => fs.existsSync(data), { what: 'the recovered JSON' })
    const document = JSON.parse(fs.readFileSync(data, 'utf8'))
    assert.deepEqual(document.conversation.map((row) => row.text), ['written before the crash'])
    assert.deepEqual(document.trace.map((row) => row.kind), ['user_message', 'turn_end'])
    assert.equal(document.meta.cwd, cwd)
    assert.equal(document.events.malformed, 1, 'one bad line is counted, not fatal')
    assert.equal(document.events.records, 2)
    assert.ok(fs.existsSync(wal), 'the append log survives until the session is sealed')

    await collector.close('crash-1')
    assert.equal(fs.existsSync(wal), false, 'sealing removes the append log: the JSON is the only source')
    const sealed = JSON.parse(fs.readFileSync(data, 'utf8'))
    assert.deepEqual(sealed.archive.map((entry) => entry.path), ['panel.html'])
    assert.deepEqual(sealed.events.files, [])
    assert.ok(sealed.archive.every((entry) => /^[a-f0-9]{64}$/u.test(entry.sha256) && entry.bytes > 0))
    assert.equal(collector.size, 0)
  })
})

await test('text, per-session bytes, and the folded document are all capped and marked', async () => {
  await withTempDir('panel-cap', async (cwd) => {
    const config = resolvePanelConfig({ capture: true, textLimit: 128, maxSessionBytes: 64 * 1024 })
    const collector = createPanelCollector({ config, env: SYNTHETIC_HOME, now: () => 1_700_000_000_000 })
    const session = sessionFixture(cwd, 'cap-1')
    const long = 'y'.repeat(500)
    collector.observe(session, event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: long }] }, 0))
    let observed = 1
    for (let index = 1; index <= 4000; index += 1) {
      collector.observe(session, event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: long }] }, index))
      observed += 1
    }
    await collector.merge('cap-1')
    const data = path.join(panelDir(cwd), 'cap-1.json')
    const bytes = fs.statSync(data).size
    const document = JSON.parse(fs.readFileSync(data, 'utf8'))
    assert.equal(document.limits.textLimit, 128)
    assert.equal(document.limits.truncated, true, 'the session budget must be marked as hit')
    assert.ok(document.limits.droppedEvents > 0, 'records over the budget are counted as dropped')
    assert.ok(document.limits.droppedChars > 0, 'clamped text names how much it dropped')
    assert.ok(document.limits.trimmed === true && document.limits.trimmedRows > 0, 'the document trims its oldest rows')
    assert.ok(bytes <= config.maxSessionBytes, `the JSON must stay under its cap (${bytes} <= ${config.maxSessionBytes})`)
    assert.equal(document.metrics.eventCount + document.limits.droppedEvents, observed, 'every observed event is either recorded or counted')
    assert.equal(document.limits.droppedEvents > 0, true)
    const first = document.conversation.find((row) => row.seq === 0)
    assert.equal(first, undefined, 'the oldest view row is the one trimming drops')
    const last = document.conversation[document.conversation.length - 1]
    assert.equal(last.truncated, true, 'a clamped text names itself truncated')
    assert.equal(last.chars, long.length)
    assert.equal(last.droppedChars, long.length - 128)
    assert.equal(document.conversation.every((row) => row.text.length <= 128), true)
    await collector.dispose()
  })
})

await test('a capture failure is contained: the session keeps running and the JSON still lands', async () => {
  await withTempDir('panel-fail', async (cwd) => {
    const warnings = []
    const real = fs.promises
    const brokenViewer = {
      mkdir: (...args) => real.mkdir(...args),
      appendFile: (...args) => real.appendFile(...args),
      readFile: (...args) => real.readFile(...args),
      stat: (...args) => real.stat(...args),
      rename: (...args) => real.rename(...args),
      rm: (...args) => real.rm(...args),
      writeFile: (file, ...rest) => {
        if (String(file).endsWith('panel.html') || String(file).includes('panel.html.tmp-')) throw new Error('viewer write refused')
        return real.writeFile(file, ...rest)
      },
    }
    const collector = createPanelCollector({
      config: resolvePanelConfig({ capture: true }), env: SYNTHETIC_HOME, io: brokenViewer,
      now: () => 1_700_000_000_000, report: (message) => warnings.push(String(message)),
    })
    const session = sessionFixture(cwd, 'fail-1')
    assert.doesNotThrow(() => collector.observe(session, event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'still here' }] }, 0)))
    await collector.flush()
    collector.observe(session, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1))
    await collector.flush()
    const data = path.join(panelDir(cwd), 'fail-1.json')
    await waitFor(() => fs.existsSync(data), { what: 'the JSON, despite the viewer failure' })
    assert.equal(JSON.parse(fs.readFileSync(data, 'utf8')).conversation[0].text, 'still here')
    assert.equal(fs.existsSync(path.join(panelDir(cwd), 'panel.html')), false)
    await collector.dispose()
    assert.equal(warnings.length >= 1, true, 'the failure is reported, not swallowed')
    assert.ok(warnings.some((message) => message.includes('viewer')), warnings.join(' | '))

    // A sink that cannot even open the append log must not throw either.
    const dead = {
      mkdir: async () => {}, appendFile: async () => { throw new Error('disk on fire') },
      readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) },
      stat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) },
      writeFile: async () => {}, rename: async () => {}, rm: async () => {},
    }
    const nested = []
    const second = createPanelCollector({
      config: resolvePanelConfig({ capture: true }), env: SYNTHETIC_HOME, io: dead,
      now: () => 1_700_000_000_000, report: (message) => nested.push(String(message)),
    })
    assert.doesNotThrow(() => second.observe(sessionFixture(cwd, 'dead-1'), event('turn/end', { turn: 1 }, 0)))
    await second.dispose()
    assert.ok(nested.some((message) => message.includes('disk on fire')), nested.join(' | '))
  })
})

await test('the sink refuses cwds and ids it cannot write safely', async () => {
  await withTempDir('panel-guard', async (cwd) => {
    assert.equal(panelPaths('relative/dir', 'sess-1', { env: SYNTHETIC_HOME }), undefined, 'a relative cwd is refused')
    assert.equal(panelPaths(cwd, '../escape', { env: SYNTHETIC_HOME }), undefined, 'a traversing id is refused')
    assert.equal(panelPaths(cwd, 'a/b', { env: SYNTHETIC_HOME }), undefined, 'a path separator in the id is refused')
    assert.equal(panelPaths(cwd, '', { env: SYNTHETIC_HOME }), undefined, 'an empty id is refused')
    assert.equal(panelPaths(cwd, 'x'.repeat(200), { env: SYNTHETIC_HOME }), undefined, 'an over-long id is refused')
    assert.equal(panelPaths(cwd, 'sess-1', { env: { DSH_HOME: cwd } }), undefined, 'a cwd inside the DSH home is refused')
    assert.equal(safeSessionId('sess-1_ok.2'), 'sess-1_ok.2')

    const collector = createPanelCollector({ config: resolvePanelConfig({ capture: true }), env: { DSH_HOME: cwd } })
    assert.doesNotThrow(() => collector.observe(sessionFixture(cwd, 'sess-1'), event('turn/end', { turn: 1 }, 0)))
    await collector.dispose()
    assert.equal(fs.existsSync(path.join(cwd, '.dsh-ops')), false, 'a refused session writes nothing at all')
  })
})

await test('projection and fold are pure enough to pin without a filesystem', () => {
  const config = resolvePanelConfig({ capture: true, textLimit: 64 })
  const projected = projectEvent({
    type: 'assistant/message', seq: 3, time: 10,
    data: {
      turn: 1, step: 2, stream: [],
      message: { content: [{ type: 'text', text: 'z'.repeat(100) }, { type: 'reasoning', text: 'thinking' }] },
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 5 },
    },
  }, config)
  assert.equal(projected.payload.truncated, true)
  assert.equal(projected.payload.droppedChars, 36)
  assert.equal(projected.reasoning.text, 'thinking')
  assert.deepEqual(projected.usageBuckets, ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'])
  assert.equal(projectEvent({ type: 'turn/start' }, config), undefined, 'an event without a seq is unusable')
  assert.deepEqual(parseAppendLog('{"record":"open"}\n\nnot json\n'), {
    records: [{ record: 'open' }], malformed: 1,
  })

  const document = foldRecords([
    { record: 'open', sessionId: 's', cwd: '/w' },
    { record: 'event', seq: 0, time: 1, type: 'assistant/message', role: 'assistant', usageReported: false, payload: { text: '', chars: 0, truncated: false, droppedChars: 0 }, reasoning: { text: '', chars: 0, truncated: false, droppedChars: 0 } },
  ], { config })
  assert.equal(document.metrics.usageReported, false, 'a step without usage makes the totals a lower bound')
  assert.equal(document.metrics.stepsWithUsage, 0)

  const trimmed = foldRecords([
    { record: 'open', sessionId: 's', cwd: '/w' },
    ...Array.from({ length: 40 }, (_, index) => ({
      record: 'event', seq: index, time: index + 1, type: 'user/message', role: 'user',
      payload: { text: 'q'.repeat(64), chars: 64, truncated: false, droppedChars: 0 },
    })),
  ], { config })
  const before = trimmed.conversation.length + trimmed.trace.length
  const fitted = fitDocument(trimmed, 2_000)
  assert.ok(fitted.trimmedRows > 0)
  assert.equal(trimmed.limits.trimmed, true)
  assert.equal(trimmed.limits.trimmedRows, fitted.trimmedRows)
  assert.equal(trimmed.conversation.length + trimmed.trace.length, before - fitted.trimmedRows)
  assert.ok(fitted.bytes <= 2_000, `${fitted.bytes} must fit 2000`)
  assert.equal(trimmed.metrics.eventCount, 40, 'trimming views never rewrites the accounting')
  assert.equal(trimmed.verify.degraded, false, 'a view trim is reported in limits, not invented as verifier failure')
})

await test('the documented metric names are the bench schema names where the two describe the same fact', async () => {
  await withTempDir('panel-schema', async (cwd) => {
    const collector = createPanelCollector({ config: resolvePanelConfig({ capture: true }), env: SYNTHETIC_HOME, now: () => 1 })
    const session = sessionFixture(cwd, 'schema-1')
    collector.observe(session, event('assistant/message', {
      turn: 1, step: 1, stream: [],
      message: { content: [{ type: 'text', text: 'ok' }] },
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }, 0))
    collector.observe(session, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1))
    await collector.flush()
    const data = path.join(panelDir(cwd), 'schema-1.json')
    await waitFor(() => fs.existsSync(data), { what: 'the merged JSON' })
    const document = JSON.parse(fs.readFileSync(data, 'utf8'))

    const schema = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'bench', 'run.schema.json'), 'utf8'))
    const usageProperties = Object.keys(schema.$defs.usage.properties)
    for (const key of Object.keys(document.metrics.usage)) {
      assert.ok(usageProperties.includes(key), `usage.${key} is not a bench/run.schema.json usage name`)
    }
    for (const key of schema.$defs.usage.required) {
      assert.ok(key in document.metrics.usage, `usage.${key} is required by the schema`)
    }
    assert.equal(
      document.metrics.usage.grandTotal,
      ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
        .reduce((total, key) => total + document.metrics.usage[key], 0),
      'grandTotal is the four core buckets, exactly as the schema defines it',
    )
    // Every metric this document writes is a schema metric name, except the two
    // deliberate differences the P14 PR lists (a live capture has no `exit`, and
    // `malformed` is this document's one-line count of unusable append records).
    const documentedDifferences = new Set(['malformed', 'endedAt'])
    const metricProperties = Object.keys(schema.$defs.metrics.properties)
    for (const key of Object.keys(document.metrics)) {
      assert.ok(metricProperties.includes(key) || documentedDifferences.has(key), `metrics.${key} has no bench counterpart and is not declared`)
    }
    assert.deepEqual(schema.$defs.usage.required.filter((key) => key !== 'grandTotal').sort(), ['cacheReadTokens', 'cacheWriteTokens', 'inputTokens', 'outputTokens'])
    assert.ok(schema.properties.events.properties.layout.enum.includes(document.events.layout))
    assert.ok(schema.$defs.result.properties.events, 'the result row still owns its own event reference')
    await collector.dispose()
  })
})

await test('a real Cordis host mounts the row and the events reach the sink', async () => {
  // bootHost() gives the production Context and fiber lifecycle, so this proves
  // the wiring (ctx.on / ctx.effect / ctx.logger) and not just the module.
  const { bootHost } = await import('./lib/host.mjs')
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'dsh-ops-panel-host-'))
  try {
    const { ctx } = await bootHost({ withTools: false, withSystemPrompt: false })
    const module = await import('../lib/components/panel/index.js')
    assert.equal(module.name, 'dsh-ops-panel')
    const silent = await ctx.plugin(module, { capture: false })
    const session = sessionFixture(directory, 'host-silent')
    ctx.emit('session/event', session, event('turn/end', { turn: 1 }, 0))
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(fs.existsSync(path.join(directory, '.dsh-ops')), false, 'default off stays inert on a real host')
    await silent.dispose()

    const live = await ctx.plugin(module, { capture: true, textLimit: 200, maxSessionBytes: 65536 })
    const captured = sessionFixture(directory, 'host-live')
    ctx.emit('session/event', captured, event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'from the host' }] }, 0))
    ctx.emit('session/event', captured, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1))
    const data = path.join(panelDir(directory), 'host-live.json')
    await waitFor(() => fs.existsSync(data), { what: 'the host-driven fold' })
    const document = JSON.parse(fs.readFileSync(data, 'utf8'))
    assert.equal(document.conversation[0].text, 'from the host')
    assert.equal(document.meta.sessionId, 'host-live')
    const wal = path.join(panelDir(directory), 'host-live.ndjson')
    ctx.emit('session/disposed', captured)
    await waitFor(() => !fs.existsSync(wal), { what: 'the sealed append log' })
    await live.dispose()
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

report('ops-panel-collect')
