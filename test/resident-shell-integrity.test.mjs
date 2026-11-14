/** Real Windows resident worker: output receipts and surviving descendants. */
import fs from 'node:fs'
import path from 'node:path'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import { residentKernel } from '../lib/execution/resident/provider.js'
import { residentShellAdmission } from '../lib/execution/resident/shell-owner.js'
import { prepareNiubash } from '../lib/niubash/runtime.js'
import { assert, test, report, skipSuite, withTempDir, PACKAGE_ROOT } from './lib/harness.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'
import { createResidentTaskJobs } from './lib/resident-task-jobs.mjs'

if (process.platform !== 'win32') skipSuite('resident-shell-integrity', 'Windows Job and named-pipe shell ownership')
requireWorker('resident-shell-integrity')
const shell = path.join(PACKAGE_ROOT, 'runtime/win32-x64/niubash/niu.exe')
assert.ok(fs.existsSync(shell), 'stage the pinned Niubash runtime before running this suite')
const quote = value => `'${value.replaceAll("'", "'\\''")}'`

function completed(value, text) {
  assert.equal(value.status, 'completed', JSON.stringify(value))
  assert.equal(value.exitCode, 0)
  assert.equal(value.shellState, 'preserved')
  assert.equal(value.cleanupConfirmed, true)
  assert.equal(value.stdout.text, text)
}

await withTempDir('resident-shell-integrity', async workspace => {
  const host = await createResidentTaskJobs({ cwd: workspace, initialAgents: 2 })
  let admission, kernel
  try {
    const { ctx, agents } = host
    await ctx.plugin(Policy, { mode: 'danger-full-access', workspaceRoot: workspace })
    await ctx.plugin(Subprocess)
    await ctx.plugin(Sandbox, {})
    await ctx.plugin(inner => inner.provide('shellEnv', { collect: () => ({}) }))
    await ctx.plugin(residentKernel({ binaryPath: WORKER }))
    kernel = ctx.get('opsKernel')
    await ctx.plugin(residentShellAdmission({ transport: kernel.shell,
      bash: { file: shell, source: 'stock-integrity-regression' },
      runtime: (_bash, env, policy, signal) => prepareNiubash(shell, env.PATH ?? env.Path, signal,
        { workspaceRoot: policy.workspaceRoot }),
    }))
    admission = ctx.get('opsShellAdmission')
    const call = (agent, command) => admission.execute({ command, timeoutMs: 10000 },
      { agent, signal: AbortSignal.timeout(15000) })
    await test('ordinary output matching the current receipt cannot complete a failed command', async () => {
      // Use the actual request generation, so a stdout parser would accept the
      // forged exit zero. The private receipt must instead report exit seven.
      const forged = 'printf "END:%s:0\\nDONE:%s\\n" "$_ops_id" "$_ops_id"; (exit 7)'
      const value = await call(agents[0], forged)
      assert.equal(value.status, 'completed', JSON.stringify(value))
      assert.equal(value.exitCode, 7)
      assert.equal(value.shellState, 'preserved')
      assert.equal(value.cleanupConfirmed, true)
      assert.equal(value.stdout.text, `END:${value.requestId}:0\nDONE:${value.requestId}\n`)
      completed(await call(agents[0], 'printf after-forgery'), 'after-forgery')
    })
    await test('living background jobs reset only their session, including disowned redirected jobs', async () => {
      completed(await call(agents[1], 'export SIBLING_INTEGRITY=retained; printf sibling'), 'sibling')
      for (const source of ['sleep 60 &', '{ sleep 60; printf late; } &',
        'later() { sleep 60; printf late; }; later &', '{ sleep 60; } >/dev/null 2>/dev/null &\ndisown']) {
        completed(await call(agents[0], 'export RESET_INTEGRITY=must-disappear; printf ready'), 'ready')
        const value = await call(agents[0], `${source}\nprintf foreground`)
        assert.equal(value.status, 'failed', JSON.stringify(value))
        assert.equal(value.shellState, 'reset')
        assert.equal(value.cleanupConfirmed, true)
        assert.match(value.error.message, /surviving|background|retained|unregistered/)
        completed(await call(agents[1], 'printf %s "$SIBLING_INTEGRITY"'), 'retained')
        completed(await call(agents[0], 'printf %s "${RESET_INTEGRITY-cleared}"'), 'cleared')
      }
    })
    await test('stock asynchronous output outside registered channels is rejected explicitly', async () => {
      const node = quote(process.execPath.replaceAll('\\', '/'))
      const value = await call(agents[0], `${node} -e 'setTimeout(()=>process.stdout.write("unregistered"),50)' &\nwait\nprintf done`)
      assert.equal(value.status, 'failed', JSON.stringify(value))
      assert.match(value.error.message, /unregistered shell stdout\/stderr observed/)
      assert.equal(value.shellState, 'reset')
      assert.equal(value.cleanupConfirmed, true)
      completed(await call(agents[1], 'printf %s "$SIBLING_INTEGRITY"'), 'retained')
    })
  } finally {
    try { await admission?.dispose() } finally { await host.dispose() }
    if (kernel) assert.throws(() => process.kill(kernel.pid, 0), error => error.code === 'ESRCH', 'resident worker survived disposal')
  }
})
report('resident-shell-integrity')
