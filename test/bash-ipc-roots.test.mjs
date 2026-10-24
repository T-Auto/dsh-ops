import fs from 'node:fs'
import path from 'node:path'
import { pinnedBashExecutable } from '../lib/shells/pinned.js'
import { confinedBash } from '../lib/bash-ipc.js'
import { independentBashRoots } from './lib/bash-ipc-processes.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'

await test('independent restricted Bash roots reopen the user shared section (#363)', async () => {
  if (process.platform !== 'win32') {
    console.log('  Windows restricted MSYS fixture unavailable: non-Windows host')
    return
  }
  const file = pinnedBashExecutable({ file: process.env.DSH_OPS_TEST_BASH })
  const source = path.resolve(path.dirname(file), '../usr/bin')
  await withTempDir('bash-ipc-roots', async home => {
    // Only Bash builtins are exercised. Preserve the pinned executable and DLL bytes while
    // avoiding copies of unrelated Git documentation/programs for this IPC regression.
    const minimal = path.join(home, 'payload/usr/bin')
    fs.mkdirSync(minimal, { recursive: true })
    for (const name of fs.readdirSync(source).filter(name => name === 'bash.exe' || name.endsWith('.dll'))) {
      fs.copyFileSync(path.join(source, name), path.join(minimal, name))
    }
    const runtime = confinedBash(path.join(minimal, 'bash.exe'), { home })
    assert.ok(runtime.runtime)
    const workspace = path.join(home, 'workspace')
    fs.mkdirSync(workspace)
    await independentBashRoots(runtime, workspace)
  })
})
report('bash-ipc-roots')
