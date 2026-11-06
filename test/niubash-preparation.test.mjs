/** Deterministic lifetime regressions; no developer runtime is needed for cleanup semantics. */
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { disposeNiubash, prepareNiubash } from '../lib/niubash/runtime.js'
import { nodeTreeOps } from '../lib/niubash/execution-tree.js'
import { removeSealedTree } from '../lib/niubash/seal.js'
import { startSessionBash } from '../lib/shells/session-execution.js'
import { assert, test, report, withTempDir, skipSuite } from './lib/harness.mjs'

await test('cleanup rejection is diagnostic, never replaces a successful command or leaks rejection', async () => {
  const warnings = [], unhandled = []
  const listener = error => unhandled.push(error)
  process.on('unhandledRejection', listener)
  try {
    const value = { exitCode: 0, stdout: 'kept' }
    const settled = Promise.resolve(value).finally(() => disposeNiubash(async () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }) }, text => warnings.push(text)))
    const done = settled.then(() => undefined, () => undefined)
    assert.equal(await settled, value)
    await done; await delay(10)
    assert.equal(warnings.length, 1); assert.match(warnings[0], /EPERM|locked/)
    assert.deepEqual(unhandled, [])
  } finally { process.off('unhandledRejection', listener) }
})

if (process.platform === 'win32' && !process.env.DSH_OPS_TEST_NIUBASH) skipSuite('niubash-preparation', 'requires frozen DSH_OPS_TEST_NIUBASH for production preparation checks')
if (process.platform === 'win32') {
  await test('preparation deadline and cancellation stop staging before spawn, then dispose after writes stop', async () => {
    await withTempDir('niu-preparation', async root => {
      const file = process.env.DSH_OPS_TEST_NIUBASH
      const policy = { mode: 'read-only', workspaceRoot: root }
      const agent = { session: { id: 'preparation' } }
      let spawns = 0, cloning = false, clonedRoot
      const original = nodeTreeOps.link
      // The clone is one link per payload member; pin the first one so the
      // deadline/cancellation races the real production clone instead of a mock tree.
      nodeTreeOps.link = async (source, target) => {
        if (cloning) return original(source, target)
        let current = path.dirname(target)
        while (!path.basename(current).startsWith('dsh-ops-niu-exec-')) current = path.dirname(current)
        clonedRoot = current
        cloning = true
        try { for (let n = 0; n < 1000; n++) await delay(5) } finally { cloning = false }
        return original(source, target)
      }
      const ctx = { get(name) {
        if (name === 'sandboxPolicy') return { resolve: () => policy }
        if (name === 'subprocess') return { spawn() { spawns++; throw Error('must not spawn') } }
      } }
      try {
        for (const cancel of [false, true]) {
          clonedRoot = undefined
          const controller = new AbortController()
          const execution = startSessionBash({ ctx, bash: { file, source: 'bundled' }, active: () => true },
            { command: 'printf never', workdir: root, timeoutMs: cancel ? 10000 : 500, includeDiagnostics: true }, { agent, signal: controller.signal }, policy, policy, {}, {})
          assert.equal(execution.started, false, 'handle exists before staging completes')
          if (cancel) {
            while (!cloning) await delay(5)
            controller.abort(new Error('cancel staging'))
          }
          const value = await execution.result()
          assert.equal(cancel ? value.cancelled : value.timedOut, true, JSON.stringify(value))
          assert.equal(spawns, 0); assert.equal(cloning, false)
          assert.ok(clonedRoot, 'injected slow cloning was reached')
          assert.equal(fs.existsSync(clonedRoot), false, 'no asynchronous staging survives cleanup')
          assert.ok(value.diagnostics.durationMs >= (cancel ? 1 : 450))
        }
      } finally { nodeTreeOps.link = original }
    })
  })
  await test('production session cleanup failure preserves success and leaves no unhandled done rejection', async () => {
    await withTempDir('niu-cleanup', async root => {
      const warnings = [], unhandled = []
      const listener = error => unhandled.push(error)
      const policy = { mode: 'danger-full-access', workspaceRoot: root }
      const ctx = { logger: { warn: text => warnings.push(text) }, get(name) {
        if (name === 'sandboxPolicy') return { resolve: () => policy }
        if (name === 'subprocess') return { spawn() { return { done: Promise.resolve({ exitCode: 0 }), collected: {
          stdout: { readFrom: () => ({ text: 'preserved', nextOffset: 9, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        } } } }
      } }
      const original = fs.promises.rm
      let executionRoot
      fs.promises.rm = async (target, options) => {
        if (path.basename(target).startsWith('dsh-ops-niu-exec-')) {
          executionRoot = target
          throw Object.assign(new Error('deterministic locked execution tree'), { code: 'EPERM' })
        }
        return original(target, options)
      }
      process.on('unhandledRejection', listener)
      try {
        const execution = startSessionBash({ ctx, bash: { file: process.env.DSH_OPS_TEST_NIUBASH, source: 'bundled' }, active: () => true },
          { command: 'printf preserved', workdir: root }, { agent: { session: { id: 'cleanup' } } }, policy, policy, {}, {})
        const value = await execution.result()
        assert.equal(value.exitCode, 0); assert.equal(value.stdout.text, 'preserved')
        await execution.done; await delay(10)
        assert.equal(warnings.length, 1); assert.match(warnings[0], /locked execution tree/)
        assert.deepEqual(unhandled, [])
      } finally {
        process.off('unhandledRejection', listener)
        fs.promises.rm = original
        // Clear the seal before deleting the tree the failed disposal left behind.
        if (executionRoot) await removeSealedTree(executionRoot)
      }
    })
  })
  await test('derived faces and extra executable members fail closed', async () => {
    const runtime = await prepareNiubash(process.env.DSH_OPS_TEST_NIUBASH, '', new AbortController().signal)
    const root = path.dirname(runtime.file)
    const face = path.join(root, 'winuxcmd/usr/bin/cat.exe')
    try {
      const saved = await fs.promises.readFile(face)
      // A privileged process can clear the seal; the stat check must still notice
      // the size change and the missing read-only bit.
      await runtime.unseal()
      await fs.promises.appendFile(face, 'tamper')
      await assert.rejects(runtime.verify(), /size mismatch/)
      await fs.promises.writeFile(face, saved)
      await runtime.seal()
      await runtime.verify()

      await runtime.unseal()
      const extra = path.join(root, 'winuxcmd/usr/bin/untrusted.exe')
      await fs.promises.writeFile(extra, 'extra')
      await assert.rejects(runtime.verify(), /Unsafe Niubash execution tree member/)
      await fs.promises.unlink(extra)

      const alias = path.join(root, 'outside-hardlink')
      await fs.promises.link(face, alias)
      await assert.rejects(runtime.verify(), /link count mismatch/)
      await fs.promises.unlink(alias)
      await runtime.seal()
      await runtime.verify()
    } finally { await runtime.dispose() }
  })
}
report('niubash-preparation')
