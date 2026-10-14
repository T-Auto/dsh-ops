/**
 * The Linux component against the real host sandbox, one row per permission
 * mode. Every row is the production composition: the real DSH policy service,
 * the real `dsh-sandbox-local` runner and the real native worker.
 *
 * The facts this suite pins are the ones a deployment depends on:
 *
 *   - read-only refuses every write and still reads what the OS allows;
 *   - workspace-write writes the workspace, refuses another session's temporary
 *     directory and refuses everything outside the workspace, through the file
 *     tools AND through the batch component;
 *   - full access adds no fence, and the credential fence holds in all three.
 *
 * It also records what the plugin does NOT govern: a confined bash may still
 * reach the shared temporary root on Linux, because the host's Landlock profile
 * grants it. That is asserted as a fact of the host, not as a plugin promise.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createScope } from '@deepseek-ai/dsh-scope'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { applyComponent } from '../lib/index.js'
import { BASH_TOOL, publicToolName } from '../lib/policy.js'
import { invoke as ptcInvoke } from '../lib/ptc/worker.js'
import { resolveWorker } from '../lib/ptc/runtime.js'
import { sessionTempDir } from '../lib/session-temp.js'
import { assert, report, test, waitFor, withTempDir } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'

const MODES = ['read-only', 'workspace-write', 'danger-full-access']

async function mount(ctx) {
  await ctx.plugin(Subprocess)
  await ctx.plugin(Sandbox, {})
  await ctx.plugin(inner => inner.provide('sandboxPolicy', {
    resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: session.header.cwd, sessionId: session.id }),
  }))
  await ctx.plugin({ name: 'sandbox-matrix', apply(inner) {
    return applyComponent(inner, { promptPolicy: false, publishBashTool: true, allowSystemShellFallback: true, configUpdateVersion: 1 }, 'linux')
  } })
  await waitFor(() => ['glob', 'grep', 'inspect_local_file', 'replace'].map(publicToolName).every(n => (ctx.get('tools').schemas() ?? []).some(s => s.name === n)), 10_000)
}

async function session(ctx, root, mode) {
  const agent = { id: `sandbox-${mode}`, session: { id: `sandbox-${mode}`, mode, header: { cwd: root } } }
  agent.ctx = createScope(ctx, agent).ctx
  await ctx.serial('agent/created', { agent })
  await waitFor(() => ctx.get('tools').get(BASH_TOOL, agent) !== undefined, 10_000)
  return agent
}

await test('every permission mode fences the file tools the way it says it does', async () => {
  if (process.platform !== 'linux') return
  await withTempDir('sandbox-matrix', async root => {
    const home = os.homedir()
    const foreign = sessionTempDir('another-session-entirely')
    const outsideBase = os.tmpdir() === '/tmp' ? '/var/tmp' : os.tmpdir()
    const outside = fs.mkdtempSync(path.join(outsideBase, 'ops-sandbox-'))
    fs.mkdirSync(foreign, { recursive: true })
    fs.writeFileSync(path.join(foreign, 'foreign.txt'), 'foreign')
    fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside')
    for (const mode of MODES) fs.writeFileSync(path.join(root, `inside-${mode}.txt`), 'inside')
    const { ctx } = await bootHost()
    try {
      await mount(ctx)
      for (const mode of MODES) {
        // Reset the shared files: full access is allowed to change them, so the
        // "must not change" fact is only meaningful for the fenced modes.
        fs.writeFileSync(path.join(foreign, 'foreign.txt'), 'foreign')
        fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside')
        const agent = await session(ctx, root, mode)
        const call = (name, args) => ctx.get('tools').get(publicToolName(name), agent).execute(args, { agent, signal: new AbortController().signal })
        const inside = await call('replace', { path: `inside-${mode}.txt`, pattern: 'inside', replacement: `${mode}-x` })
        const foreignCall = await call('replace', { path: path.join(foreign, 'foreign.txt'), pattern: 'foreign', replacement: 'tampered' })
        const outsideCall = await call('replace', { path: path.join(outside, 'outside.txt'), pattern: 'outside', replacement: 'tampered' })
        const readOutside = await call('inspect_local_file', { path: path.join(outside, 'outside.txt') })
        const credential = await call('inspect_local_file', { path: path.join(home, '.dsh', '.credentials.yaml') })
        const batchOutside = await ptcInvoke(ctx, resolveWorker({}), 'batch', { root: outside, action: 'plan', operations: [{ op: 'remove', path: 'outside.txt' }] }, { agent }, new AbortController().signal, {})
        const record = {
          inside: inside.error?.code ?? inside.changed,
          insideAfter: fs.readFileSync(path.join(root, `inside-${mode}.txt`), 'utf8'),
          foreign: foreignCall.error?.code ?? foreignCall.changed,
          outside: outsideCall.error?.code ?? outsideCall.changed,
          batchOutside: batchOutside.error?.code ?? batchOutside.status,
          readOutside: readOutside.status,
          credential: credential.error?.code ?? credential.status,
        }
        console.log(`  MATRIX ${mode}: ${JSON.stringify(record)}`)
        if (mode === 'read-only') {
          assert.equal(record.inside, 'POLICY_DENIED', JSON.stringify(record))
          assert.equal(record.insideAfter, 'inside')
        } else {
          assert.equal(record.inside, 1, JSON.stringify(record))
          assert.equal(record.insideAfter, `${mode}-x`)
        }
        assert.equal(record.credential, 'POLICY_DENIED', `${mode}: the credential fence holds in every mode`)
        assert.equal(record.readOutside, 'completed', `${mode}: OS-readable paths stay readable`)
        if (mode !== 'danger-full-access') {
          assert.equal(fs.readFileSync(path.join(foreign, 'foreign.txt'), 'utf8'), 'foreign', `${mode}: a foreign session temp file must not change`)
          assert.equal(fs.readFileSync(path.join(outside, 'outside.txt'), 'utf8'), 'outside', `${mode}: an outside file must not change`)
        } else {
          assert.equal(fs.readFileSync(path.join(foreign, 'foreign.txt'), 'utf8'), 'tampered', 'full access adds no fence, including on another session\'s temp file')
        }
        if (mode === 'workspace-write') {
          assert.equal(record.foreign, 'POLICY_DENIED', 'workspace-write must refuse another session\'s temp directory')
          assert.equal(record.outside, 'POLICY_DENIED', 'workspace-write must refuse paths outside the workspace')
          assert.equal(record.batchOutside, 'POLICY_DENIED', 'the batch root must be fenced the same way')
        }
        if (mode === 'danger-full-access') {
          assert.equal(record.outside, 1, 'full access adds no write fence')
        }
      }
    } finally { await shutdown(ctx); fs.rmSync(outside, { recursive: true, force: true }); fs.rmSync(foreign, { recursive: true, force: true }) }
  })
})

await test('a confined command cannot leave the workspace, except through the host temp grant', async () => {
  if (process.platform !== 'linux') return
  await withTempDir('sandbox-bash', async root => {
    const outsideBase = os.tmpdir() === '/tmp' ? '/var/tmp' : os.tmpdir()
    const outside = fs.mkdtempSync(path.join(outsideBase, 'ops-bash-'))
    const { ctx } = await bootHost()
    try {
      await mount(ctx)
      const agent = await session(ctx, root, 'workspace-write')
      const bash = ctx.get('tools').get(BASH_TOOL, agent)
      const run = command => bash.execute({ command, workdir: root, timeoutMs: 20_000 }, { agent, signal: new AbortController().signal })

      const workspace = await run('printf w > bash-workspace.txt && echo WROTE')
      assert.equal(workspace.exitCode, 0, JSON.stringify(workspace))
      assert.ok(['full', 'partial'].includes(workspace.sandbox.enforcement), JSON.stringify(workspace.sandbox))

      // Full access legitimately reaches these paths, so the fenced mode must
      // leave nothing behind for a later full-access row to inherit.
      for (const residue of ['/etc/dsh-ops-sandbox-residue.txt', path.join(os.homedir(), 'dsh-ops-sandbox-residue.txt')]) fs.rmSync(residue, { force: true })
      const outsideWrite = await run(`printf o > ${JSON.stringify(path.join(outside, 'escape.txt'))} 2>&1; echo rc=$?`)
      assert.equal(fs.existsSync(path.join(outside, 'escape.txt')), false, `a confined command escaped the workspace: ${outsideWrite.stdout.text}`)
      const etcWrite = await run('printf e > /etc/dsh-ops-sandbox-residue.txt 2>&1; echo rc=$?')
      assert.equal(fs.existsSync('/etc/dsh-ops-sandbox-residue.txt'), false, `a confined command wrote to /etc: ${etcWrite.stdout.text}`)
      const homeWrite = await run(`printf h > ${JSON.stringify(path.join(os.homedir(), 'dsh-ops-sandbox-residue.txt'))} 2>&1; echo rc=$?`)
      assert.equal(fs.existsSync(path.join(os.homedir(), 'dsh-ops-sandbox-residue.txt')), false, `a confined command wrote to the home directory: ${homeWrite.stdout.text}`)
      const network = await run('timeout 5 bash -c "exec 3<>/dev/tcp/1.1.1.1/443" 2>&1; echo rc=$?')
      assert.equal(network.stdout.text.trim(), 'rc=124', `a confined command reached the network: ${network.stdout.text}`)
      // The host's Landlock profile grants the whole temporary root, so this is
      // recorded as the host's grant rather than asserted as a plugin promise.
      const tempWrite = await run(`printf t > ${JSON.stringify(path.join(os.tmpdir(), 'dsh-ops-sandbox-temp-probe.txt'))} 2>&1; echo rc=$?`)
      console.log(`  MATRIX host-temp-grant: ${JSON.stringify(tempWrite.stdout.text.trim())} (the host grants /tmp to workspace-write; the plugin's file tools do not)`)
      fs.rmSync(path.join(os.tmpdir(), 'dsh-ops-sandbox-temp-probe.txt'), { force: true })
      fs.rmSync(path.join(root, 'bash-workspace.txt'), { force: true })
    } finally { await shutdown(ctx); fs.rmSync(outside, { recursive: true, force: true }) }
  })
})

report('linux-sandbox')
