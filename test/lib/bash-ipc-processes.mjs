import fs from 'node:fs'
import path from 'node:path'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import { bootHost, shutdown } from './host.mjs'
import { assert } from './harness.mjs'
import { prepareWorkspace } from '../../lib/workspace-preparation.js'

/** Keep one real MSYS root alive while independent roots reopen its shared section. */
export async function independentBashRoots(runtime, root) {
  const { ctx } = await bootHost()
  const handles = []
  const signal = AbortSignal.timeout(30_000)
  try {
    await ctx.plugin(Subprocess)
    await ctx.plugin(Sandbox, {})
    const policy = { mode: 'workspace-write', workspaceRoot: root, sessionId: 'bash-ipc-roots' }
    await prepareWorkspace(policy)
    const start = async (command, stdin = { data: '' }) => {
      const confined = await ctx.get('sandbox').confine([runtime.file, '-c', command], policy, signal)
      const handle = ctx.get('subprocess').spawn({ argv: confined.argv, cwd: root, env: runtime.env,
        graceMs: 1000, stdio: { stdin, stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }, signal })
      handles.push(handle)
      return handle
    }
    const holder = await start("printf 'HOLD_READY'; read -r answer", 'pipe')
    let settled = false
    const holderOutcome = holder.done.finally(() => { settled = true })
    // Observation waits do not retry commands or mask startup failures.
    const deadline = Date.now() + 10_000
    while (!settled && Date.now() < deadline && !holder.collected.stdout.readFrom(0).text.includes('HOLD_READY')) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(holder.collected.stdout.readFrom(0).text, 'HOLD_READY', holder.collected.stderr.readFrom(0).text)
    assert.equal(settled, false, 'the first independent MSYS root must still own its shared section')
    const results = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const child = await start(`printf 'ROOT_${index}'; printf '${index}' > inside-${index}.txt`)
      const outcome = await child.done
      return { index, outcome, stdout: child.collected.stdout.readFrom(0).text, stderr: child.collected.stderr.readFrom(0).text }
    }))
    for (const { index, outcome, stdout, stderr } of results) {
      assert.equal(outcome.exitCode, 0, `independent root ${index}: ${stderr}`)
      assert.equal(stdout, `ROOT_${index}`, stderr)
      assert.equal(fs.readFileSync(path.join(root, `inside-${index}.txt`), 'utf8'), String(index))
    }
    const denied = await start("printf forbidden > ../outside.txt")
    assert.notEqual((await denied.done).exitCode, 0, 'IPC compatibility must not grant filesystem writes')
    assert.equal(fs.existsSync(path.join(root, '../outside.txt')), false)
    holder.stdin.end('done\n')
    assert.equal((await holderOutcome).exitCode, 0)
  } finally {
    for (const handle of handles) handle.terminate()
    await Promise.allSettled(handles.map(handle => handle.done))
    await shutdown(ctx)
  }
}
