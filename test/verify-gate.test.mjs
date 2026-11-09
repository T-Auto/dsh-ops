/** Exercise the gate CLI verdict with deterministic subprocess exits, not a release/security run. */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { assert, test, report, withTempDir, PACKAGE_ROOT } from './lib/harness.mjs'

await test('--keep-going includes artifact subprocess failures in its exit code and JSON verdict', async () => {
  await withTempDir('verify-gate', root => {
    const preload = path.join(root, 'steps.cjs')
    const count = fs.readdirSync(path.join(PACKAGE_ROOT, 'test')).filter(name => name.endsWith('.test.mjs')).length
    // Only step subprocesses are replaced. The CLI, summary parsing, artifact discovery,
    // failure collection and final process.exit are real. No suite or sandbox is simulated as safe.
    fs.writeFileSync(preload, `
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const spawn = cp.spawn;
cp.spawn = (command, args, options) => {
  const joined = args.join(' ');
  let output = '', code = 0;
  if (joined === 'run validate:manifest') output = 'validate-manifest: all 89 checks passed';
  if (joined === 'test/run.mjs') output = 'dsh-ops test: ${count} suite(s) passed';
  if (args[0] === 'pack') fs.writeFileSync(path.join(args[args.indexOf('--pack-destination') + 1], 'fixture.tgz'), 'orchestration fixture');
  if (process.env.GATE_ARTIFACT_FAILURE === 'unpack' && args[0] === '-xzf') code = 23;
  if (process.env.GATE_ARTIFACT_FAILURE === 'closure' && args.includes('--root')) code = 29;
  return spawn(process.execPath, ['-e', 'console.log(' + JSON.stringify(output) + '); process.exitCode = ' + code],
    { ...options, shell: false });
};
require('node:module').syncBuiltinESMExports();
`)
    const loader = path.join(root, 'pinned-fixture.mjs')
    const pinnedUrl = pathToFileURL(path.join(PACKAGE_ROOT, 'lib/shells/pinned.js')).href
    // This is an orchestration test, not a payload verifier. Isolate the in-process
    // fixture-acquisition seam as well as subprocess steps; never borrow a host Bash.
    fs.writeFileSync(loader, `
export async function load(url, context, next) {
  if (url === ${JSON.stringify(pinnedUrl)}) return { format: 'module', shortCircuit: true,
    source: 'export function pinnedBashExecutable(options = {}) { return options.file ?? "fixture-bash.exe" }' };
  return next(url, context);
}
`)
    for (const failure of ['none', 'unpack', 'closure']) {
      const child = spawnSync(process.execPath, ['--experimental-loader', pathToFileURL(loader).href,
        '--import', pathToFileURL(preload).href,
        path.join(PACKAGE_ROOT, 'scripts/verify-gate.mjs'), '--skip-install', '--keep-going', '--json'], {
        cwd: PACKAGE_ROOT, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, DSH_OPS_TEST_BASH: '', GATE_ARTIFACT_FAILURE: failure },
      })
      assert.equal(child.error, undefined, String(child.error))
      assert.equal(child.status, failure === 'none' ? 0 : 1, child.stdout + child.stderr)
      const match = /\n(\{\n  "host":[\s\S]*?\n\})\n/.exec(child.stdout)
      assert.ok(match, child.stdout + child.stderr)
      const result = JSON.parse(match[1])
      assert.equal(result.steps.filter(step => /run build$/.test(step.command)).length, 1)
      assert.equal(result.steps.filter(step => /run validate:manifest$/.test(step.command)).length, 1)
      assert.equal(result.steps.find(step => step.title === 'full suite verification').command, 'node test/run.mjs')
      const title = failure === 'unpack' ? 'unpack the release artifact' : 'packed runtime closure'
      assert.equal(result.steps.at(-1).title, 'packed runtime closure', 'keep-going must complete the final step')
      if (failure === 'none') {
        assert.deepEqual(result.failures, [])
        assert.match(child.stdout, /gate green/)
      } else {
        assert.ok(result.failures.includes(`${title}: exited ${failure === 'unpack' ? 23 : 29}`), JSON.stringify(result))
        assert.doesNotMatch(child.stdout, /gate green/)
      }
    }
  })
})

report('verify-gate')
