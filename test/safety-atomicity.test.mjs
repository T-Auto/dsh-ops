/** Existing-tool safety seam; no new public file capabilities. */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { callTool, envelopeOf, requireWorker } from './lib/boundary.mjs'
import { invoke } from '../lib/file/worker.js'
import { ensureSessionTemp, sessionTempDir } from '../lib/session-temp.js'
import { anchoredPath } from '../lib/authority-paths.js'
import { normalizeNativeDenial } from '../lib/permissions.js'
import { CallBudget } from '../lib/kernel/call-budget.js'

await test('authority snapshots stop before spawn without inventing selector denials', async () => {
  await withTempDir('safety-authority', async root => {
    let resolves = 0, spawns = 0, current = 'workspace-write'
    const calls = new CallBudget()
    const kernel = { file: 'unused', available: true,
      admitFileCall: (id, signal, run) => calls.run(id, signal, run),
      invoke() { spawns++; throw new Error('must not dispatch') } }
    const ctx = { get(name) {
      if (name === 'opsKernel') return kernel
      if (name === 'workingDirectory') return { ensure: async agent => agent.session.header.cwd }
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: ++resolves === 1 ? 'danger-full-access' : current, workspaceRoot: root }) }
      if (name === 'subprocess') return { spawn() { spawns++; throw new Error('must not spawn') } }
    } }
    const exec = { agent: { session: { id: 'safety-test', header: { cwd: root } } } }
    for (const [mode, code] of [['workspace-write', 'AUTHORITY_CHANGED'], ['read-only', 'POLICY_DENIED']]) {
      current = mode; resolves = 0
      const value = await invoke(ctx, 'unused', 'replace', { path: 'local.txt', pattern: 'a', replacement: 'b' }, exec)
      assert.equal(value.error.code, code, JSON.stringify(value))
      assert.equal(value.error.effectState, 'none')
      assert.equal(value.error.permission?.current, mode === 'read-only' ? mode : undefined)
    }
    assert.equal(spawns, 0)
    const missing = await invoke({}, 'unused', 'replace', {}, {})
    assert.equal(missing.error.code, 'EXECUTOR_UNAVAILABLE')
  })
})

await test('metadata and path restrictions never become selector advice', () => {
  for (const code of ['METADATA_UNSUPPORTED', 'PATH_RESTRICTED', 'CREDENTIAL_DENIED']) {
    const value = { status: 'error', error: { code, reason: 'write-roots', effectState: 'applied' } }
    assert.equal(normalizeNativeDenial(value, {}, 'replace', 'workspace-write'), value)
  }
})

await test('trusted anchor aliases retain descendant no-follow and temp never widens', async () => {
  await withTempDir('safety-anchors', async root => {
    const real = path.join(root, 'real'), alias = path.join(root, 'alias')
    fs.mkdirSync(real); fs.symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const child = path.join(real, 'child'); fs.symlinkSync(real, child, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(anchoredPath(path.join(alias, 'child', 'new'), [alias]), path.join(real, 'child', 'new'))
    assert.equal(ensureSessionTemp(child).ok, false)
    const longRoot = path.join(root, 'x'.repeat(220))
    assert.notEqual(sessionTempDir('test', longRoot), longRoot)
  })
})

requireWorker('safety-atomicity')
if (process.platform === 'win32') {
  await test('Windows replace retains exact security/timestamps and rejects named streams before publication', async () => {
    await withTempDir('safety-windows-metadata', async root => {
      const source = path.join(root, 'source.txt')
      fs.writeFileSync(source, 'TOKEN')
      fs.utimesSync(source, new Date('2020-01-02T00:00:00Z'), new Date('2020-01-03T00:00:00Z'))
      const acl = () => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Acl -LiteralPath '${source.replaceAll("'", "''")}').Sddl`], { encoding: 'utf8', env: { ...process.env, PSModulePath: '' } }).trim()
      const before = acl(), modified = fs.statSync(source).mtimeMs
      const replace = async () => envelopeOf(await callTool('replace', { path: source, pattern: 'TOKEN', replacement: 'DONE' }, { root }), assert)
      const value = await replace()
      assert.equal(value.status, 'completed', JSON.stringify(value))
      assert.equal(fs.readFileSync(source, 'utf8'), 'DONE')
      assert.equal(acl(), before); assert.equal(fs.statSync(source).mtimeMs, modified)
      assert.equal(value.items[0].metadata.dacl, true)
      fs.writeFileSync(source, 'TOKEN'); fs.writeFileSync(`${source}:secret`, 'KEEP')
      const refused = await replace()
      assert.equal(refused.error.code, 'METADATA_UNSUPPORTED', JSON.stringify(refused))
      assert.equal(refused.error.effectState, 'none')
      assert.match(refused.error.nextAction, /metadata|filesystem/)
      assert.equal(fs.readFileSync(source, 'utf8'), 'TOKEN')
      assert.equal(fs.readFileSync(`${source}:secret`, 'utf8'), 'KEEP')
      assert.equal(fs.readdirSync(root).some(name => /\.dsh-ops-[0-9a-f-]{36}$/.test(name)), false)
    })
  })
}
report('safety-atomicity')
