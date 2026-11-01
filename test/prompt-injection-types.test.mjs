import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { assert, test, report, PACKAGE_ROOT } from './lib/harness.mjs'
await test('public export is callable and rejects mutable snapshots, missing revisions and arbitrary message results', () => {
  const result = spawnSync(process.execPath, [path.join(PACKAGE_ROOT, 'node_modules/typescript/lib/tsc.js'),
    '--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    path.join(PACKAGE_ROOT, 'test/lib/prompt-injection-types.mts')], { cwd: PACKAGE_ROOT, encoding: 'utf8', timeout: 30_000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
report('prompt-injection-types')
