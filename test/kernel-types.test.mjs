/** Negative assertions must keep failing compilation; @ts-expect-error detects accidental widening. */
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { CPU_PROCESS_TIMEOUT_MS, assert, test, report, PACKAGE_ROOT } from './lib/harness.mjs'
await test('shared result types narrow correctly and reject incomplete or contradictory outcomes', () => {
  const result = spawnSync(process.execPath, [path.join(PACKAGE_ROOT, 'node_modules/typescript/lib/tsc.js'), '-p', path.join(PACKAGE_ROOT, 'test/types/tsconfig.json')], { cwd: PACKAGE_ROOT, encoding: 'utf8', timeout: CPU_PROCESS_TIMEOUT_MS })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
report('kernel-types')
