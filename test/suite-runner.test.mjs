import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { assert, test, report, withTempDir, PACKAGE_ROOT, CPU_PROCESS_TIMEOUT_MS } from './lib/harness.mjs'
import { runPool, runSuite, testJobs } from './lib/suite-runner.mjs'

await test('CPU-bound subprocesses get contention headroom below the CI suite watchdog', () => {
  assert.equal(CPU_PROCESS_TIMEOUT_MS, 120_000)
  assert.ok(CPU_PROCESS_TIMEOUT_MS < 300_000)
})

await test('jobs defaults to host parallelism and rejects invalid budgets', async () => {
  assert.ok(testJobs('') >= 1)
  assert.equal(testJobs('1'), 1)
  assert.equal(testJobs('4'), 4)
  for (const raw of ['0', '-1', '1.5', 'NaN', 'Infinity']) assert.throws(() => testJobs(raw), /DSH_OPS_TEST_JOBS/)
})

await test('bounded workers overlap, run every suite once, then run exclusives alone', async () => {
  for (const jobs of [1, 3]) {
    const suites = ['a', 'b', 'exclusive', 'c', 'd']
    let active = 0, peak = 0
    const seen = [], finished = []
    let release
    const barrier = new Promise(resolve => { release = resolve })
    await runPool(suites, { jobs, exclusive: new Set(['exclusive']), run: async suite => {
      if (suite === 'exclusive') {
        assert.equal(active, 0)
        assert.equal(finished.length, 4)
      }
      active++
      peak = Math.max(peak, active)
      seen.push(suite)
      // Deterministic overlap assertion, not a timing-dependent sleep.
      if (jobs > 1 && seen.length <= jobs) {
        if (seen.length === jobs) release()
        await barrier
      }
      active--
      finished.push(suite)
    } })
    assert.equal(peak, jobs)
    assert.deepEqual([...seen].sort(), [...suites].sort())
    assert.equal(seen.at(-1), 'exclusive')
  }
})

await test('suite processes isolate and remove homes, buffer both streams, preserve skips and failures', async () => {
  await withTempDir('suite-runner', async root => {
    const suite = path.join(root, 'fixture.mjs')
    fs.writeFileSync(suite, `console.log(process.env.DSH_HOME); console.error('stderr fixture'); process.exit(Number(process.env.FIXTURE_EXIT))`)
    const results = await Promise.all([0, 77, 3].map(code => runSuite(suite, {
      cwd: PACKAGE_ROOT, env: { FIXTURE_EXIT: String(code) }, timeoutMs: 10000,
    })))
    assert.deepEqual(results.map(result => result.status), [0, 77, 3])
    const spawnFailure = await runSuite(suite, { cwd: path.join(root, 'missing'), timeoutMs: 10000 })
    assert.equal(spawnFailure.status, null)
    assert.equal(spawnFailure.timedOut, false)
    assert.match(spawnFailure.output, /ENOENT/)
    const homes = results.map(result => result.output.split(/\r?\n/).find(line => line.includes('dsh-ops-test-home-')))
    assert.equal(new Set(homes).size, 3)
    for (const [index, result] of results.entries()) {
      assert.match(result.output, /stderr fixture/)
      assert.equal(result.timedOut, false)
      assert.ok(result.durationMs > 0)
      assert.equal(fs.existsSync(homes[index]), false)
    }
  })
})

await test('deadline stops a suite once even when the removed retry environment is present', async () => {
  await withTempDir('suite-deadline', async root => {
    const suite = path.join(root, 'fixture.mjs')
    const calls = path.join(root, 'calls')
    fs.writeFileSync(suite, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(calls)}, 'once\\n'); setInterval(() => {}, 1000)`)
    const result = await runSuite(suite, { cwd: PACKAGE_ROOT, env: { DSH_OPS_RETRY_TIMEOUTS: '1' }, timeoutMs: 5000 })
    assert.equal(result.timedOut, true)
    assert.notEqual(result.status, 0)
    assert.match(result.output, /exceeded the 5s suite deadline/)
    assert.equal(fs.readFileSync(calls, 'utf8'), 'once\n')
  })
})

await test('real CLI preserves skip policy, blocks output, durations and one-shot timeout failure', async () => {
  await withTempDir('suite-cli', async root => {
    const preload = path.join(root, 'driver.cjs')
    const calls = path.join(root, 'calls')
    const testDir = path.join(PACKAGE_ROOT, 'test')
    fs.writeFileSync(preload, `
const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path');
const originalRead = fs.readdirSync, originalSpawn = cp.spawn;
if (process.env.FIXTURE_TIMERS === '1') {
  const schedule = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => { console.log('fixture watchdog ' + ms); return schedule(fn, ms, ...args); };
}
fs.readdirSync = (directory, ...args) => path.resolve(String(directory)) === ${JSON.stringify(testDir)}
  ? ['pass.test.mjs', 'skip.test.mjs', 'hang.test.mjs', 'permissions.test.mjs',
    'niubash-consumer.test.mjs', 'niubash-preparation.test.mjs', 'niubash-security-host.test.mjs'] : originalRead(directory, ...args);
cp.spawn = (command, args, options) => {
  if (process.env.FIXTURE_SPAWN_ERROR === '1') {
    const child = new (require('node:events').EventEmitter)();
    child.stdout = new (require('node:stream').PassThrough)();
    child.stderr = new (require('node:stream').PassThrough)();
    queueMicrotask(() => child.emit('error', new Error('fixture spawn ENOENT')));
    return child; // Deliberately no close event after the failed spawn.
  }
  const label = path.basename(args[0]);
  fs.appendFileSync(${JSON.stringify(calls)}, label + '\\n');
  const source = label.startsWith('hang') ? 'setInterval(() => {}, 1000)'
    : 'console.log("fixture begin"); console.error("fixture end"); process.exit(' + (label.startsWith('skip') ? 77 : 0) + ')';
  return originalSpawn(command, ['-e', source], options);
};
require('node:module').syncBuiltinESMExports();
`)
    const invoke = (filters, env = {}) => spawnSync(process.execPath,
      ['--import', pathToFileURL(preload).href, path.join(testDir, 'run.mjs'), ...filters], {
        cwd: PACKAGE_ROOT, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, DSH_OPS_TEST_JOBS: '2', DSH_OPS_SUITE_TIMEOUT_MS: '10000',
          DSH_OPS_REQUIRE_RUNTIME: '', DSH_OPS_ALLOW_SKIPS: '', DSH_OPS_RETRY_TIMEOUTS: '1', ...env },
      })
    const unmatched = invoke(['no-match'])
    assert.equal(unmatched.status, 1)
    assert.match(unmatched.stderr, /no suites matched/)
    const invalid = invoke(['pass'], { DSH_OPS_TEST_JOBS: '0' })
    assert.equal(invalid.status, 2)
    assert.match(invalid.stderr, /invalid DSH_OPS_TEST_JOBS/)
    const spawnFailure = invoke(['pass'], { FIXTURE_SPAWN_ERROR: '1' })
    assert.equal(spawnFailure.status, 1, spawnFailure.stdout + spawnFailure.stderr)
    assert.match(spawnFailure.stdout, /fixture spawn ENOENT/)
    assert.match(spawnFailure.stderr, /pass.test.mjs exited null/)
    assert.doesNotMatch(spawnFailure.stdout, /exceeded.*suite deadline/)
    const heavy = invoke(['pass', 'permissions'], { DSH_OPS_TEST_JOBS: '1' })
    assert.equal(heavy.status, 0, heavy.stdout + heavy.stderr)
    assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), ['permissions.test.mjs', 'pass.test.mjs'])
    fs.writeFileSync(calls, '')
    const exclusive = invoke(['pass', 'niubash-consumer'], { FIXTURE_TIMERS: '1', DSH_OPS_SUITE_TIMEOUT_MS: '' })
    assert.equal(exclusive.status, 0, exclusive.stdout + exclusive.stderr)
    assert.match(exclusive.stdout, /fixture watchdog 120000/)
    assert.match(exclusive.stdout, /fixture watchdog 300000/)
    assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), ['pass.test.mjs', 'niubash-consumer.test.mjs'])
    const override = invoke(['niubash-consumer'], { FIXTURE_TIMERS: '1', DSH_OPS_SUITE_TIMEOUT_MS: '650000' })
    assert.equal(override.status, 0, override.stdout + override.stderr)
    assert.match(override.stdout, /fixture watchdog 650000/)
    fs.writeFileSync(calls, '')
    const independent = invoke(['pass', 'niubash-preparation', 'niubash-security-host'])
    assert.equal(independent.status, 0, independent.stdout + independent.stderr)
    assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'),
      ['niubash-preparation.test.mjs', 'niubash-security-host.test.mjs', 'pass.test.mjs'],
      'private prepared runtimes enter the pool before the short tail, not the exclusive phase')
    const normal = invoke(['pass', 'skip'])
    assert.equal(normal.status, 0, normal.stdout + normal.stderr)
    assert.match(normal.stdout, /1 suite\(s\) passed, 1 skipped/)
    assert.match(normal.stdout, /=== pass.test.mjs \([\d.]+s\)\r?\n(?:fixture begin\r?\nfixture end|fixture end\r?\nfixture begin)/)
    assert.match(normal.stdout, /10 slowest suites:/)
    const strict = invoke(['skip'], { DSH_OPS_REQUIRE_RUNTIME: '1' })
    assert.equal(strict.status, 1, strict.stdout + strict.stderr)
    assert.match(strict.stderr, /skipped while DSH_OPS_REQUIRE_RUNTIME=1/)
    const allowed = invoke(['skip'], { DSH_OPS_REQUIRE_RUNTIME: '1', DSH_OPS_ALLOW_SKIPS: 'skip' })
    assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr)
    const deadline = invoke(['hang'], { DSH_OPS_SUITE_TIMEOUT_MS: '1500' })
    assert.equal(deadline.status, 1, deadline.stdout + deadline.stderr)
    assert.match(deadline.stdout, /exceeded the 2s suite deadline/)
    assert.match(deadline.stderr, /1 of 1 suite\(s\) failed/)
    assert.equal(fs.readFileSync(calls, 'utf8').split('\n').filter(label => label === 'hang.test.mjs').length, 1)
  })
})

report('suite-runner')
