import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { main, parseArgs } from '../bench/calls/index.mjs'
import { pluginFixture, corpusFixture } from './lib/bench-calls-fixture.mjs'

await test('version comparison selects both OPS arms and keeps historical identity separate', () => {
  const options = parseArgs(['--out', 'x', '--baseline-plugin-root', 'old', '--plugin-root', 'new', '--baseline', 'earlier.json'])
  assert.deepEqual(options.projections, ['baseline', 'candidate'])
  assert.equal(options.baselinePluginRoot, 'old')
  assert.equal(options.pluginRoot, 'new')
  assert.equal(options.baseline, 'earlier.json')
  assert.deepEqual(parseArgs(['--out', 'x']).projections, ['official', 'candidate'])
  assert.deepEqual(parseArgs(['--dry-run', '--baseline-plugin-root', 'old', '--projection', 'official,baseline,candidate']).projections, ['official', 'baseline', 'candidate'])
})

await test('incomplete arm selections cannot silently measure another comparison', () => {
  assert.throws(() => parseArgs(['--dry-run', '--projection', ',']), /at least one projection/)
  assert.throws(() => parseArgs(['--dry-run', '--projection', 'baseline,candidate']), /--baseline-plugin-root/)
  assert.throws(() => parseArgs(['--dry-run', '--baseline-worker', 'old.exe']), /--baseline-plugin-root/)
  assert.throws(() => parseArgs(['--dry-run', '--baseline-plugin-root', 'old', '--projection', 'candidate']), /baseline projection/)
})

await test('two builds use separate policies and workers in one process with AB/BA rounds', async () => {
  await withTempDir('calls-versions', async root => {
    const log = path.join(root, 'calls.jsonl')
    const base = pluginFixture(path.join(root, 'old build'), 'old', log)
    const cand = pluginFixture(path.join(root, 'new build'), 'candidate', log)
    const override = path.join(root, 'baseline-worker')
    fs.writeFileSync(override, 'explicit baseline worker')
    const output = path.join(root, 'report.json')
    const lines = []
    const manifest = corpusFixture(root)
    manifest.cases[0].candidate = { outputMode: 'content', limit: 5, exactTotal: false }
    const code = await main(['--corpus', 'tiny', '--baseline-plugin-root', base.root, '--baseline-worker', override,
      '--plugin-root', cand.root, '--repeat', '2', '--warmup', '1', '--out', output],
    { manifests: [manifest], out: line => lines.push(line), err: line => lines.push(line) })
    assert.equal(code, 0, lines.join('\n'))
    const result = JSON.parse(fs.readFileSync(output, 'utf8'))
    assert.deepEqual(result.projections, ['baseline', 'candidate'])
    assert.equal(result.pluginRoot, cand.root)
    assert.equal(result.worker.path, cand.worker)
    assert.equal(result.arms.baseline.pluginRoot, base.root)
    assert.equal(result.arms.baseline.version, 'old')
    assert.equal(result.arms.candidate.version, 'candidate')
    assert.notEqual(result.arms.baseline.libSha256, result.arms.candidate.libSha256)
    assert.equal(result.arms.baseline.worker.path, override)
    assert.equal(result.arms.baseline.worker.sha256, createHash('sha256').update('explicit baseline worker').digest('hex'))
    assert.equal(result.corpora[0].inputChanged, false)
    assert.deepEqual(result.corpora[0].rows.map(row => [row.round, row.projection]),
      [[0, 'baseline'], [0, 'candidate'], [1, 'candidate'], [1, 'baseline']])
    const summary = result.corpora[0].cases[0]
    assert.deepEqual(summary.candidate.arguments, { pattern: 'needle', path: '.', outputMode: 'content', limit: 5, exactTotal: false })
    assert.deepEqual(summary.baseline.arguments, summary.candidate.arguments)
    assert.equal(summary.baseline.bytesMedian, 3)
    assert.equal(summary.candidate.bytesMedian, 9)
    assert.equal(summary.baseline.errors + summary.candidate.errors, 0)
    const events = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const calls = events.filter(event => !event.closed)
    assert.deepEqual(calls.map(call => call.label), ['candidate', 'old', 'old', 'candidate', 'candidate', 'old'])
    assert.ok(calls.every(call => call.pid === process.pid && call.args.pattern === 'needle'))
    assert.ok(calls.filter(call => call.label === 'old').every(call => call.worker === override))
    assert.ok(calls.filter(call => call.label === 'candidate').every(call => call.worker === cand.worker))
    assert.deepEqual(events.filter(event => event.closed).map(event => event.closed).sort(), ['candidate', 'old'])
  })
})

await test('a missing baseline build is named before either host executes', async () => {
  await withTempDir('calls-missing-build', async root => {
    const log = path.join(root, 'calls.jsonl')
    const cand = pluginFixture(path.join(root, 'new'), 'new', log)
    const output = path.join(root, 'report.json'), lines = []
    assert.equal(await main(['--corpus', 'tiny', '--baseline-plugin-root', path.join(root, 'missing'),
      '--plugin-root', cand.root, '--out', output],
    { manifests: [corpusFixture(root)], out: () => {}, err: line => lines.push(line) }), 2)
    assert.match(lines.join('\n'), /baseline.*missing build input/)
    assert.equal(fs.existsSync(output), false)
    assert.equal(fs.existsSync(log), false)
  })
})

await test('official-only runs need no plugin build, and a version failure remains an error', async () => {
  await withTempDir('calls-version-failure', async root => {
    const manifest = corpusFixture(root), log = path.join(root, 'calls.jsonl')
    const io = { manifests: [manifest], out: () => {}, err: () => {} }
    const official = path.join(root, 'official.json')
    assert.equal(await main(['--corpus', 'tiny', '--projection', 'official', '--plugin-root', path.join(root, 'absent'),
      '--repeat', '1', '--warmup', '0', '--out', official], io), 0)
    assert.equal(JSON.parse(fs.readFileSync(official, 'utf8')).arms.official.projection, 'official')
    const base = pluginFixture(path.join(root, 'bad'), 'bad', log, { fail: true })
    const cand = pluginFixture(path.join(root, 'good'), 'good', log)
    const output = path.join(root, 'failed.json')
    assert.equal(await main(['--corpus', 'tiny', '--baseline-plugin-root', base.root, '--plugin-root', cand.root,
      '--repeat', '1', '--warmup', '0', '--out', output], io), 1)
    const result = JSON.parse(fs.readFileSync(output, 'utf8')).corpora[0].cases[0]
    assert.equal(result.baseline.errors, 1)
    assert.equal(result.baseline.medianMs, null)
    assert.equal(result.candidate.errors, 0)
    assert.match(fs.readFileSync(log, 'utf8'), /"closed":"bad"/)
    assert.match(fs.readFileSync(log, 'utf8'), /"closed":"good"/)
  })
})

await test('OPS domain errors are excluded even when host transport is successful', async () => {
  await withTempDir('calls-domain-error', async root => {
    const manifest = corpusFixture(root), log = path.join(root, 'calls.jsonl')
    for (const status of ['error', 'rejected', 'conflict', 'unknown']) {
      const plugin = pluginFixture(path.join(root, status), status, log, { fail: status })
      const output = path.join(root, status + '.json')
      const code = await main(['--corpus', 'tiny', '--projection', 'candidate', '--plugin-root', plugin.root,
        '--repeat', '1', '--warmup', '0', '--out', output], { manifests: [manifest], out: () => {}, err: () => {} })
      assert.equal(code, 1, status)
      const row = JSON.parse(fs.readFileSync(output, 'utf8')).corpora[0].cases[0].candidate
      assert.equal(row.errors, 1)
      assert.equal(row.medianMs, null)
    }
  })
})

report('bench-call-versions')
