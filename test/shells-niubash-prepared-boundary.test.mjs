/** The session layer arms the prepared-root boundary only for confined modes (#870). */
import path from 'node:path'
import { startSessionBash } from '../lib/shells/session-execution.js'
import { niubashPreparedRoot } from '../lib/niubash/runtime.js'
import { NIUBASH_PACKAGE_PATH } from '../lib/cli/niubash-payload.js'
import { syntheticNiubashTree } from './lib/niubash-distribution-fixture.mjs'
import { assert, report, skipSuite, TEST_HOME, test, withTempDir } from './lib/harness.mjs'

if (process.platform !== 'win32') skipSuite('shells-niubash-prepared-boundary', 'requires the Windows Niubash runtime branch')

await test('full access executes with the prepared root inside the workspace; confined modes refuse it', async () => {
  await withTempDir('niu-boundary', async root => {
    const source = syntheticNiubashTree(path.join(root, 'package', NIUBASH_PACKAGE_PATH))
    let argv0, spawnCalls = 0
    const run = mode => {
      // The test process DSH_HOME (TEST_HOME) is itself the workspace root, so the prepared
      // root it selects is contained in the workspace exactly like a default ~/.dsh inside
      // a home workspace (#870).
      const policy = { mode, workspaceRoot: TEST_HOME }
      const agent = { id: 'niu-boundary', session: { id: 'niu-boundary', header: { cwd: root } } }
      const ctx = {
        get(name) {
          if (name === 'sandboxPolicy') return { resolve: () => policy }
          if (name === 'sandbox') return { confine: async argv => ({ argv, enforcement: 'partial' }) }
          if (name === 'subprocess') return {
            spawn(spec) {
              spawnCalls++; argv0 = spec.argv[0]
              const stream = text => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
              return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: stream('ok'), stderr: stream('') } }
            },
          }
          return undefined
        },
      }
      const execution = startSessionBash({ ctx, bash: { file: path.join(source, 'niu.exe'), source: 'bundled' }, active: () => true },
        { command: 'true', workdir: root }, { agent, signal: new AbortController().signal }, policy, policy, {}, {})
      return execution.result()
    }
    const full = await run('danger-full-access')
    assert.equal(full.error, undefined, JSON.stringify(full))
    assert.equal(full.status, 'completed', JSON.stringify(full))
    assert.equal(spawnCalls, 1, 'full access spawned the prepared runtime')
    assert.equal(argv0, path.join(niubashPreparedRoot(), 'niu.exe'), 'full access executes the prepared runtime')
    const denied = await run('workspace-write')
    assert.match(denied.error, /EXECUTOR_UNAVAILABLE:.*outside the session workspace/)
    assert.equal(spawnCalls, 1, 'the confined refusal spawned nothing')
  })
})
report('shells-niubash-prepared-boundary')
