/** Full access projects straight through; confinement is a confined-mode fact (#581). */
import path from 'node:path'
import { startSessionBash } from '../lib/shells/session-execution.js'
import { NIUBASH_PACKAGE_PATH } from '../lib/cli/niubash-payload.js'
import { syntheticNiubashTree } from './lib/niubash-distribution-fixture.mjs'
import { assert, report, skipSuite, test, withTempDir } from './lib/harness.mjs'

if (process.platform !== 'win32') skipSuite('shells-full-access-confinement', 'requires the Windows Niubash runtime branch')

await test('full access spawns directly and never confines; confined modes route through confine', async () => {
  await withTempDir('niu-full-access', async root => {
    const source = syntheticNiubashTree(path.join(root, 'package', NIUBASH_PACKAGE_PATH))
    const scenarios = [
      { label: 'the Niubash runtime', file: path.join(source, 'niu.exe') },
      { label: 'a plain bash payload', file: path.join(root, 'bash.exe') },
    ]
    for (const { label, file } of scenarios) {
      let argv0, confineCalls = 0, spawnCalls = 0
      const run = mode => {
        const policy = { mode, workspaceRoot: root }
        const agent = { id: 'niu-full-access', session: { id: 'niu-full-access', header: { cwd: root } } }
        const ctx = {
          get(name) {
            if (name === 'sandboxPolicy') return { resolve: () => policy }
            if (name === 'sandbox') return { confine: async argv => { confineCalls++; return { argv, enforcement: 'partial' } } }
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
        const execution = startSessionBash({ ctx, bash: { file, source: 'config' }, active: () => true },
          { command: 'true', workdir: root }, { agent, signal: new AbortController().signal }, policy, policy, {}, {})
        return execution.result()
      }
      // Full access keeps the caller's own token: no confinement, no runner downgrade (#581).
      const full = await run('danger-full-access')
      assert.equal(full.error, undefined, `${label}: ${JSON.stringify(full)}`)
      assert.equal(full.status, 'completed', `${label}: ${JSON.stringify(full)}`)
      assert.equal(spawnCalls, 1, `${label}: full access spawned once`)
      assert.equal(confineCalls, 0, `${label}: full access never asks the sandbox to confine`)
      if (file.endsWith('niu.exe')) assert.equal(path.basename(argv0), 'niu.exe', `${label}: the prepared runtime executes`)
      else assert.equal(argv0, file, `${label}: the configured payload executes unchanged`)
      // A confined mode must pass through the sandbox before the spawn; a plain bash.exe
      // that is not the supported MSYS payload is refused by confinedBash instead, which is
      // exactly the call full access must never make.
      const confined = await run('workspace-write')
      if (file.endsWith('niu.exe')) {
        assert.equal(confined.error, undefined, `${label}: ${JSON.stringify(confined)}`)
        assert.equal(confineCalls, 1, `${label}: the confined mode routed through confine exactly once`)
        assert.equal(spawnCalls, 2, `${label}: the confined mode spawned once more`)
      } else {
        assert.match(confined.error ?? '', /EXECUTOR_UNAVAILABLE:.*restricted modes/, `${label}: a foreign payload is refused in confined modes`)
        assert.equal(confineCalls, 0, `${label}: the refusal precedes confinement`)
        assert.equal(spawnCalls, 1, `${label}: the refusal spawned nothing`)
      }
    }
  })
})
report('shells-full-access-confinement')
