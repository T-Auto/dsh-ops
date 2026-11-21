/** The prepared-root workspace boundary is armed for confined modes only (#870). */
import path from 'node:path'
import { niubashPreparedRoot, prepareNiubash } from '../lib/niubash/runtime.js'
import { NIUBASH_PACKAGE_PATH } from '../lib/cli/niubash-payload.js'
import { syntheticNiubashTree } from './lib/niubash-distribution-fixture.mjs'
import { assert, report, test, withTempDir } from './lib/harness.mjs'

const signal = new AbortController().signal

await test('full access prepares a workspace-contained DSH_HOME; confined modes still refuse it', async () => {
  await withTempDir('niu-ws-mode', async root => {
    const source = syntheticNiubashTree(path.join(root, 'package', NIUBASH_PACKAGE_PATH))
    const file = path.join(source, 'niu.exe')
    const inside = { DSH_HOME: path.join(root, 'home') }
    const prepare = mode => prepareNiubash(file, 'inherited', signal, { workspaceRoot: root, env: inside, ...(mode ? { mode } : {}) })
    // Full access runs unconfined and keeps the account's own authority over every path, so the
    // default DSH_HOME inside a home workspace must not make Niubash unusable (#870).
    const full = await prepare('danger-full-access')
    assert.equal(full.file, path.join(niubashPreparedRoot(inside), 'niu.exe'))
    assert.equal(full.env.PATH.split(path.delimiter).at(-1), 'inherited', 'the inherited PATH stays last')
    assert.equal(full.env.NIU_ROOT, path.join(niubashPreparedRoot(inside), 'winuxcmd'))
    // Confined modes keep the refusal: workspace labeling must never reach an executable.
    for (const mode of ['read-only', 'workspace-write', undefined]) {
      await assert.rejects(prepare(mode), error => error.message.startsWith('EXECUTOR_UNAVAILABLE:')
        && error.message.includes('outside the session workspace'))
    }
  })
})
report('niubash-workspace-mode')
