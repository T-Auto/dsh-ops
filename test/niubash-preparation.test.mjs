/** Deterministic lifetime regressions; no developer runtime is needed for cleanup semantics. */
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { disposeNiubash, prepareNiubash } from '../lib/niubash/runtime.js'
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
      let spawns = 0, copying = false, copiedRoot
      const original = fs.promises.cp
      fs.promises.cp = async (source, target, options) => {
        copying = true; copiedRoot = target
        // Exercise the actual cancellation-aware production filter while the event loop is free.
        try { for (let n = 0; n < 1000; n++) { options.filter(source, target); await delay(5) } }
        finally { copying = false }
      }
      const ctx = { get(name) {
        if (name === 'sandboxPolicy') return { resolve: () => policy }
        if (name === 'subprocess') return { spawn() { spawns++; throw Error('must not spawn') } }
      } }
      try {
        for (const cancel of [false, true]) {
          copiedRoot = undefined
          const controller = new AbortController()
          const execution = startSessionBash({ ctx, bash: { file, source: 'bundled' }, active: () => true },
            { command: 'printf never', workdir: root, timeoutMs: cancel ? 10000 : 500, includeDiagnostics: true }, { agent, signal: controller.signal }, policy, policy, {}, {})
          assert.equal(execution.started, false, 'handle exists before staging completes')
          if (cancel) {
            while (!copying) await delay(5)
            controller.abort(new Error('cancel staging'))
          }
          const value = await execution.result()
          assert.equal(cancel ? value.cancelled : value.timedOut, true, JSON.stringify(value))
          assert.equal(spawns, 0); assert.equal(copying, false)
          assert.ok(copiedRoot, 'injected slow copying was reached')
          assert.equal(fs.existsSync(copiedRoot), false, 'no asynchronous staging survives cleanup')
          assert.ok(value.diagnostics.durationMs >= (cancel ? 1 : 450))
        }
      } finally { fs.promises.cp = original }
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
          { command: 'printf preserved', workdir: root, timeoutMs: 30000 }, { agent: { session: { id: 'cleanup' } } }, policy, policy, {}, {})
        const value = await execution.result()
        assert.equal(value.exitCode, 0); assert.equal(value.stdout.text, 'preserved')
        await execution.done; await delay(10)
        assert.equal(warnings.length, 1); assert.match(warnings[0], /locked execution tree/)
        assert.deepEqual(unhandled, [])
      } finally {
        process.off('unhandledRejection', listener)
        fs.promises.rm = original
        if (executionRoot) await original(executionRoot, { recursive: true, force: true })
      }
    })
  })
  await test('derived faces and extra executable members fail closed', async () => {
    const runtime = await prepareNiubash(process.env.DSH_OPS_TEST_NIUBASH, '', new AbortController().signal)
    try {
      const face = path.join(path.dirname(runtime.file), 'winuxcmd/usr/bin/cat.exe')
      const saved = await fs.promises.readFile(face)
      await fs.promises.appendFile(face, 'tamper')
      await assert.rejects(runtime.verify(), /checksum/)
      await fs.promises.writeFile(face, saved)
      const extra = path.join(path.dirname(runtime.file), 'winuxcmd/usr/bin/untrusted.exe')
      await fs.promises.writeFile(extra, 'extra')
      await assert.rejects(runtime.verify(), /checksum/)
      await fs.promises.unlink(extra)
      await runtime.verify()
    } finally { await runtime.dispose() }
  })
}
report('niubash-preparation')
