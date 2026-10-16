import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { assert, test, report } from './lib/harness.mjs'

const fixturesModule = await import('../bench/fixtures.mjs').catch(() => null)
const measureModule = await import('../bench/measure.mjs').catch(() => null)
await test('manual file benchmark helpers exist', () => {
  assert.ok(fixturesModule && measureModule, 'benchmark fixture and measurement modules must exist')
})
if (fixturesModule && measureModule) {
  const { createFixtures, cleanupOwned } = fixturesModule
  const { canonical, summarize, runWorker, compare, median } = measureModule
  await test('normalization preserves semantic fields and item ordering', () => {
    assert.equal(canonical({ b: 2, a: { elapsedMs: 1, text: 'x' } }), canonical({ a: { text: 'x', elapsedMs: 2 }, b: 2 }))
    assert.notEqual(canonical({ complete: true }), canonical({ complete: false }))
    assert.notEqual(canonical({ items: [1, 2] }), canonical({ items: [2, 1] }))
    assert.equal(median([5, 1, 4, 2, 3]), 3)
    assert.equal(median([]), null)
  })
  await test('comparison refuses mismatch, unstable, expected differences and timeouts', () => {
    const ok = { state: 'OK', ms: 10, outputBytes: 2, value: { status: 'completed', matched: 1 } }
    const base = summarize([ok, ok])
    assert.equal(compare(base, base).state, 'MATCH')
    const other = summarize([{ ...ok, value: { status: 'completed', matched: 2 } }])
    assert.equal(compare(base, other).speedup, null)
    assert.equal(compare(base, other).state, 'MISMATCH')
    assert.equal(compare(base, other, 'documented query-specific migration').state, 'EXPECTED_DIFFERENCE')
    assert.equal(compare(base, other, 'documented query-specific migration').speedup, null)
    assert.equal(compare(base, summarize([ok, { state: 'TIMEOUT' }])).speedup, null)
    assert.equal(compare(base, summarize([ok, { ...ok, value: { status: 'completed', matched: 3 } }])).state, 'UNSTABLE')
    const rejected = summarize([{ ...ok, value: { status: 'error', error: { code: 'OUTPUT_LIMIT', message: 'too large' } } }])
    assert.equal(compare(rejected, base).speedup, null)
    assert.equal(rejected.nativeErrors[0].code, 'OUTPUT_LIMIT')
    assert.equal(rejected.rejectionMedianMs, 10)
    assert.equal(rejected.medianMs, null)
  })
  await test('spawn timer waits for close, classifies failure and reaps watchdog children', async () => {
    const success = await runWorker(process.execPath, {}, { args: ['-e', 'process.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({status:"completed"})))'], timeoutMs: 5000 })
    assert.equal(success.state, 'OK')
    assert.equal(success.value.status, 'completed')
    const timeout = await runWorker(process.execPath, {}, { args: ['-e', 'setTimeout(()=>{},60000)'], timeoutMs: 100 })
    assert.equal(timeout.state, 'TIMEOUT')
    assert.throws(() => process.kill(timeout.pid, 0))
    const invalid = await runWorker(process.execPath, {}, { args: ['-e', 'console.log("incomplete{")'], timeoutMs: 5000 })
    assert.equal(invalid.state, 'ERROR')
    const overflow = await runWorker(process.execPath, {}, { args: ['-e', 'process.stdout.write("x".repeat(4096))'], maxOutputBytes: 1024, timeoutMs: 5000 })
    assert.equal(overflow.state, 'OUTPUT_LIMIT')
    assert.equal((await runWorker(path.join(os.tmpdir(), 'missing-dsh-bench-worker.exe'), {}, { timeoutMs: 5000 })).state, 'ERROR')
  })
  await test('five seeded fixtures retain size boundaries and cleanup refuses foreign data', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ops-bench-test-'))
    const first = createFixtures({ parent, scale: 0.001 })
    const second = createFixtures({ parent, scale: 0.001 })
    try {
      assert.deepEqual(first.cases.map(x => x.fixture).filter((v, i, a) => a.indexOf(v) === i), ['small-files', 'deep-tree', 'big-file', 'dense-hits', 'edge-text'])
      assert.equal(fs.statSync(path.join(first.root, 'big-file', 'large.txt')).size, 33 * 1024 * 1024)
      const relative = 'small-files/d000/f00000.txt'
      assert.deepEqual(fs.readFileSync(path.join(first.root, relative)), fs.readFileSync(path.join(second.root, relative)))
      assert.equal(fs.statSync(path.join(first.root, relative)).size, 4096)
      for (const query of first.cases.filter(x => x.tool !== 'inspect_local_file')) assert.ok(query.args.outputMode)
      const foreign = path.join(first.root, 'user-data.txt')
      fs.writeFileSync(foreign, 'keep')
      assert.throws(() => cleanupOwned(first), /unexpected/i)
      assert.equal(fs.readFileSync(foreign, 'utf8'), 'keep')
      assert.ok(fs.readdirSync(first.root).includes('user-data.txt'))
      fs.unlinkSync(foreign)
    } finally {
      cleanupOwned(first)
      cleanupOwned(second)
      assert.deepEqual(fs.readdirSync(parent), [])
      fs.rmdirSync(parent)
    }
  })
  await test('CLI runs five paired rounds, writes an exclusive report and removes only its fixtures', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ops-bench-cli-test-'))
    const preload = path.join(parent, 'worker.cjs'), output = path.join(parent, 'smoke.json')
    // A Node preload is only the test transport. The measured CLI still spawns real processes.
    fs.writeFileSync(preload, `if(process.argv.length===1){const fs=require('node:fs');const r=JSON.parse(fs.readFileSync(0,'utf8'));fs.writeFileSync(1,JSON.stringify(r.args.path.endsWith('large.txt')?{status:'error',error:{code:'OUTPUT_LIMIT'}}:{status:'completed',items:[]}));process.exit(0);}`)
    const args = ['bench/files.mjs', '--baseline', process.execPath, '--candidate', process.execPath,
      '--out', output, '--temp-dir', parent, '--scale', '0.0001']
    try {
      // Not a tight budget, on purpose. This smoke drives 168 short-lived workers through
      // the CLI (14 queries x one warmup + five rounds x two engines), and `test/run.mjs`
      // stops a suite at 120s, so the watchdog sits just under that: a slow shared runner
      // still finishes, and one that cannot gets a failure naming this budget instead of an
      // unexplained runner timeout.
      const run = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 110000,
        env: { ...process.env, NODE_OPTIONS: `--require="${preload.replaceAll('\\', '/')}"` } })
      assert.equal(run.status, 0, run.stderr + (fs.existsSync(output) ? JSON.stringify(JSON.parse(fs.readFileSync(output)).rows[0].failures) : ''))
      const result = JSON.parse(fs.readFileSync(output, 'utf8'))
      assert.equal(result.rounds, 5)
      assert.equal(result.warmups, 1)
      assert.equal(result.rows.length, 28)
      assert.ok(result.rows.filter(row => row.state === 'MATCH').every(row => row.runsMs.length === 5))
      assert.deepEqual(fs.readdirSync(parent).sort(), ['smoke.json', 'worker.cjs'])
      const before = fs.readFileSync(output)
      const repeat = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30000 })
      assert.equal(repeat.status, 1)
      assert.match(repeat.stderr, /Refusing to overwrite/)
      assert.deepEqual(fs.readFileSync(output), before)
    } finally {
      const entries = fs.readdirSync(parent).sort()
      assert.ok(entries.every(name => ['worker.cjs', 'smoke.json'].includes(name)), `Unexpected test files: ${entries}`)
      for (const name of entries) fs.unlinkSync(path.join(parent, name))
      fs.rmdirSync(parent)
    }
  })
}
report('file-bench')
