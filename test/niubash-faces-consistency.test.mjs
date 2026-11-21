/**
 * The Niubash face list must match what winuxcmd actually implements (#966).
 *
 * A face the multi-call binary cannot dispatch still becomes an argv0 stub on
 * the prepared PATH: the stub shadows a system command (jq, link) with an entry
 * that only answers "command not found". Two contracts are pinned here: the
 * static list names no unimplemented applet, every generated face dispatches
 * for real inside winuxcmd, and a prepared cache that still carries a stale
 * face is retired and rebuilt instead of being reused (#966 cache upgrade).
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { assert, test, report, withTempDir, PACKAGE_ROOT } from './lib/harness.mjs'
import { NIUBASH_FACES, niubashFacePath } from '../lib/niubash/faces.js'
import { NIUBASH_PIN } from '../lib/cli/niubash-payload.js'

await test('the face list names no applet winuxcmd cannot dispatch', () => {
  // Measured against the frozen payload: winuxcmd answers "command not found"
  // with exit 127 for these, so their argv0 stubs only shadow the system tools.
  assert.equal(NIUBASH_FACES.includes('jq'), false, 'winuxcmd reports command not found: jq; the stub shadows a real system jq')
  assert.equal(NIUBASH_FACES.includes('link'), false, 'winuxcmd reports command not found: link')
})

/** Live-probe base: the staged frozen tree, or the gate-provided fixture. */
const staged = path.join(PACKAGE_ROOT, 'runtime', 'win32-x64', 'niubash')
const base = process.env.DSH_OPS_TEST_NIUBASH ? path.dirname(process.env.DSH_OPS_TEST_NIUBASH) : staged
const winuxcmd = path.join(base, 'winuxcmd', 'usr', 'bin', 'winuxcmd.exe')
const live = process.platform === 'win32' && fs.existsSync(winuxcmd)

await test('every generated face dispatches inside winuxcmd, not to command-not-found', () => {
  if (!live) {
    console.log('  note: no staged winuxcmd on this host; the live probe needs the frozen payload')
    return
  }
  const generated = NIUBASH_FACES.map(niubashFacePath).filter(name => !Object.hasOwn(NIUBASH_PIN.files, name))
  const missing = []
  for (const name of generated) {
    const face = path.basename(name, '.exe')
    const probe = spawnSync(winuxcmd, [face],
      { timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
    if (probe.status === 127) missing.push(face)
  }
  assert.deepEqual(missing, [], 'each generated face must be a real winuxcmd applet')
})

await test('a prepared cache carrying a stale face is retired and rebuilt, not reused', () => withTempDir('faces-cache-upgrade', async root => {
  if (!live) {
    console.log('  note: no staged payload on this host; the cache-upgrade probe needs the frozen tree')
    return
  }
  const { prepareNiubashVersion } = await import('../lib/niubash/runtime.js')
  const source = base
  const target = path.join(root, 'prepared')
  await prepareNiubashVersion(source, target)
  const staleFace = path.join(target, 'winuxcmd', 'usr', 'bin', 'jq.exe')
  const winuxcmdCopy = path.join(target, 'winuxcmd', 'usr', 'bin', 'winuxcmd.exe')
  // Simulate a cache written by a face list that still declared jq (#966).
  fs.copyFileSync(winuxcmdCopy, staleFace)
  // Reuse must not bless the stale stub: it shadows the system jq.
  await prepareNiubashVersion(source, target)
  assert.equal(fs.existsSync(staleFace), false, 'a face the list no longer declares must not survive a cache reuse')
}))

report('niubash-faces-consistency')
