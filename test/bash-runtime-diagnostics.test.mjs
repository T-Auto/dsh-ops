/**
 * The confined-Bash preparation failure as the caller sees it (#512).
 *
 * Two defects from the issue are pinned here:
 * · the session layer used to replace every preparation failure with one
 *   parameterless-catch paragraph, losing whether the payload was unfixable or
 *   the copy was merely interrupted;
 * · that paragraph said "Do not retry", which is wrong for the staging path —
 *   it verifies, quarantines and stages again by design.
 *
 * The classification and the lifecycle-lock text are pure functions, so most of
 * this suite runs on every platform. The end-to-end case drives the real scoped
 * registry: it needs a real Windows host because only Windows refuses a
 * non-pinned bash.
 *
 * @module dsh-ops/test/bash-runtime-diagnostics
 */
import fs from 'node:fs'
import path from 'node:path'
import { createScope } from '@deepseek-ai/dsh-scope'
import { assert, report, test, withTempDir, waitFor } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { mountSessionBash } from '../lib/session-shells.js'
import { bashRuntimeFailure, executorUnavailableMessage, isRetryableBashRuntimeFailure } from '../lib/bash-runtime-failure.js'
import { withLifecycleLock, recoverBashLifecycleLock } from '../lib/bash-ipc-lifecycle.js'

await test('a staging interruption says retry; an unfixable payload keeps its own remedy', () => {
  const staging = executorUnavailableMessage(bashRuntimeFailure('bash-staging-failed', 'the private copy was interrupted (EPERM)'))
  assert.match(staging, /^EXECUTOR_UNAVAILABLE: bash-staging-failed: /)
  assert.match(staging, /Retry this call once/)
  assert.match(staging, /bash-runtime clean-cache --yes --all-hosts-stopped/)
  assert.equal(isRetryableBashRuntimeFailure(bashRuntimeFailure('bash-staging-failed', 'x')), true)

  const missing = executorUnavailableMessage(bashRuntimeFailure('bash-runtime-missing', 'usr/bin/msys-2.0.dll is absent'))
  assert.match(missing, /bash-runtime-missing/)
  assert.match(missing, /retrying this call cannot create a missing payload/)
  assert.equal(isRetryableBashRuntimeFailure(bashRuntimeFailure('bash-runtime-missing', 'x')), false)

  // `restrictedRemedy` already owns a complete, actionable message: re-wrapping it would hide
  // which bash was refused and what to change, the exact loss this issue reports.
  const remedy = 'EXECUTOR_UNAVAILABLE: ops_bash cannot run the configured bashPath C:\\Git\\bin\\bash.exe in restricted modes: its msys-2.0.dll is not the pinned build. Next steps: remove bashPath.'
  assert.equal(executorUnavailableMessage(bashRuntimeFailure('bash-runtime-incompatible', remedy)), remedy)

  // An unclassified error keeps its reason and makes no claim about retryability.
  const unknown = executorUnavailableMessage(new Error('EACCES: permission denied, mkdir stage-x'))
  assert.match(unknown, /^EXECUTOR_UNAVAILABLE: /)
  assert.match(unknown, /EACCES: permission denied/)
  assert.doesNotMatch(unknown, /Do not retry or bypass/)

  // The stage survives a module boundary: a serialized error is still classified by its code.
  const duck = Object.assign(new Error('the cache lifecycle lock is busy'), { code: 'bash-lifecycle-lock-busy' })
  assert.equal(isRetryableBashRuntimeFailure(duck), false)
  assert.match(executorUnavailableMessage(duck), /Retrying does not repair this/)
})

await test('a lock left by an interrupted process names its owner and the recovery command', async () => {
  await withTempDir('lifecycle-lock-leftover', root => {
    const cacheRoot = path.join(root, 'dsh-ops', 'bash-ipc')
    const lock = path.join(cacheRoot, '.ops-lifecycle-lock')
    fs.mkdirSync(lock, { recursive: true })
    // A pid that cannot be alive: recovery must accept it as a dead owner and remove the lock.
    const deadPid = 999999
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: deadPid, token: 'fixture' }) + '\n')
    assert.throws(
      () => withLifecycleLock(cacheRoot, () => 'never', { attempts: 2, delayMs: 0, wait: () => {} }),
      error => {
        assert.equal(error.code, 'bash-lifecycle-lock-busy')
        const message = executorUnavailableMessage(error)
        assert.match(message, /bash-lifecycle-lock-busy/)
        assert.match(message, new RegExp(String(deadPid)), 'the recorded owner is named')
        assert.match(message, /clean-cache --yes --all-hosts-stopped/)
        assert.match(message, /Retrying does not repair this/)
        return true
      })
    recoverBashLifecycleLock(cacheRoot, { confirmedStopped: true })
    assert.equal(fs.existsSync(lock), false, 'the confirmed recovery removed the abandoned lock')
    assert.equal(withLifecycleLock(cacheRoot, () => 'taken', { attempts: 1, wait: () => {} }), 'taken')
  })
})

await test('a restricted bash that cannot run reports which bash and why, not a blanket "Do not retry"', async () => {
  if (process.platform !== 'win32') {
    console.log('  Windows-only: only the Windows restricted path refuses a non-pinned bash')
    return
  }
  const { ctx } = await bootHost()
  await withTempDir('bash-runtime-diagnostics', async root => {
    const agent = { id: 'diagnostics-1', session: { id: 'diagnostics-1', header: { cwd: root } } }
    const scope = createScope(ctx, agent)
    agent.ctx = scope.ctx
    let spawned = 0
    try {
      await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root }) }))
      await ctx.plugin(inner => inner.provide('sandbox', { confine: async argv => ({ argv, enforcement: 'full' }) }))
      await ctx.plugin(inner => inner.provide('subprocess', { spawn() { spawned += 1; throw new Error('must not spawn') } }))
      await ctx.plugin({
        inject: ['tools'],
        apply(inner) { mountSessionBash(inner, { publishBashTool: true }, { bash: { available: true, file: process.execPath, source: 'config' } }) },
      })
      await ctx.serial('agent/created', { agent })
      await waitFor(() => ctx.get('tools').get('ops_bash', agent), { what: 'deferred Bash publication' })
      const tool = ctx.get('tools').get('ops_bash', agent)
      const value = await tool.execute(
        { description: 'Probe the confined runtime diagnostic', command: 'unused', workdir: root },
        { agent, signal: new AbortController().signal })
      assert.equal(value.status, 'failed', JSON.stringify(value))
      assert.equal(spawned, 0, 'no shell may start without a verified private runtime')
      // The remedy names the refused bash and the real reason (`restrictedCompatibility`), not a blanket paragraph.
      assert.match(value.error, /restricted modes/)
      assert.match(value.error, /msys-2\.0\.dll/)
      assert.match(value.error, /custom bashPath|danger-full-access/)
      // The old paragraph hid the stage and forbade retrying; neither may come back.
      assert.doesNotMatch(value.error, /the restricted Bash runtime is unavailable or incompatible/)
      assert.doesNotMatch(value.error, /Do not retry or bypass confinement/)
      assert.equal(value.failure.code, 'EXECUTOR_UNAVAILABLE')
    } finally {
      await scope.dispose()
      await shutdown(ctx)
    }
  })
})

report('bash-runtime-diagnostics')
