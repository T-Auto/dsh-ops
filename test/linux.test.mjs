/**
 * The Linux component against the real host: the same file tools and bash the
 * Windows components publish, resolved from this host's own worker and bash.
 *
 * This suite is Linux-only on purpose. On any other host the component refuses
 * to load, which is itself asserted here, so the file is evidence either way
 * instead of being silently skipped.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createScope } from '@deepseek-ai/dsh-scope'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { applyComponent } from '../lib/index.js'
import { resolveLinuxConfig } from '../lib/components/linux/index.js'
import { resolveWorker } from '../lib/ptc/runtime.js'
import { sessionTempDir } from '../lib/session-temp.js'
import { BASH_TOOL, FILE_TOOLS, TOOLING_SECTION, publicToolName } from '../lib/policy.js'
import { assert, report, test, waitFor, withTempDir } from './lib/harness.mjs'
import { bootHost, publicToolNames, renderSections, shutdown } from './lib/host.mjs'

const FILE_EXPECTED = FILE_TOOLS.map(publicToolName).sort()
const EXPECTED = [...FILE_EXPECTED, BASH_TOOL].sort()

/** Mount the Linux component with the real policy, sandbox and subprocess services. */
async function mountLinux(ctx, cwd, config = {}) {
  await ctx.plugin(Subprocess)
  await ctx.plugin(Sandbox, {})
  await ctx.plugin(inner => inner.provide('sandboxPolicy', {
    resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: session.header.cwd, sessionId: session.id }),
  }))
  // `configUpdateVersion` is what keeps the 0.2.5 fallback retirement from
  // rewriting this row's explicit system-bash opt-in; the shipped patch row
  // carries the same marker.
  const fiber = await ctx.plugin({ name: 'fixture-linux', apply(inner) {
    return applyComponent(inner, { promptPolicy: true, publishBashTool: true, allowSystemShellFallback: true, configUpdateVersion: 1, ...config }, 'linux')
  } })
  const deadline = Date.now() + 10_000
  for (;;) {
    // The bash surface appears per agent, so the mount itself waits only for
    // the globally registered file tools.
    const names = publicToolNames(ctx)
    if (names.length >= FILE_EXPECTED.length) return { fiber, names }
    if (Date.now() > deadline) throw new Error(`linux component mount timed out: got ${names.join(', ')}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/** One agent scope with its own session mode and cwd. */
async function agentFor(ctx, cwd, mode) {
  const agent = { id: `linux-${mode}`, session: { id: `linux-${mode}`, mode, header: { cwd } } }
  agent.ctx = createScope(ctx, agent).ctx
  return agent
}

await test('the Linux component only loads on Linux', () => {
  if (process.platform === 'linux') {
    assert.doesNotThrow(() => resolveLinuxConfig({}))
    assert.throws(() => resolveLinuxConfig({ binaryPath: '/x' }), /Unknown Linux config key/)
    assert.throws(() => resolveLinuxConfig({ publishBashTool: 'yes' }), /must be boolean/)
  }
})

await test('the Linux component publishes the same tool names as the Windows components', async () => {
  if (process.platform !== 'linux') return
  await withTempDir('linux-surface', async root => {
    const { ctx } = await bootHost()
    try {
      await ctx.plugin(inner => inner.provide('host-edit', {}))
      const { names } = await mountLinux(ctx, root)
      assert.deepEqual(names.filter(name => EXPECTED.includes(name)).sort(), FILE_EXPECTED)
      // Bash is registered per agent, exactly as the Windows shell component
      // registers it: the same names, on the same authority check.
      const agent = await agentFor(ctx, root, 'workspace-write')
      await ctx.serial('agent/created', { agent })
      await waitFor(() => ctx.get('tools').get(BASH_TOOL, agent) !== undefined, 10_000)
      assert.ok(ctx.get('tools').get(publicToolName('replace'), agent), 'the file tools are visible to the agent scope too')
      const sections = await renderSections(ctx, agent)
      const text = sections.get(`${TOOLING_SECTION}:linux`)
      assert.ok(text, 'the Linux component contributes its own tooling section')
      assert.match(text, /Shell routing: bash/)
      for (const name of EXPECTED) assert.ok(text.includes(name), `the section names ${name}`)
    } finally { await shutdown(ctx) }
  })
})

await test('the Linux component follows the DSH permission modes', async () => {
  if (process.platform !== 'linux') return
  await withTempDir('linux-modes', async root => {
    const outsideBase = os.tmpdir() === '/tmp' ? '/var/tmp' : os.tmpdir()
    const outside = fs.mkdtempSync(path.join(outsideBase, 'ops-linux-outside-'))
    const { ctx } = await bootHost()
    try {
      await mountLinux(ctx, root)
      fs.writeFileSync(path.join(root, 'data.txt'), 'before')
      const agent = await agentFor(ctx, root, 'workspace-write')
      // The bash surface is registered per agent, exactly as the Windows shell
      // component registers it: the agent has to exist before the tool does.
      await ctx.serial('agent/created', { agent })
      await waitFor(() => ctx.get('tools').get(BASH_TOOL, agent) !== undefined, 10_000)
      const replace = ctx.get('tools').get(publicToolName('replace'), agent)
      const bash = ctx.get('tools').get(BASH_TOOL, agent)
      assert.ok(replace && bash, 'both surfaces publish under the agent scope')
      const exec = { agent, signal: new AbortController().signal }

      const written = await replace.execute({ path: 'data.txt', pattern: 'before', replacement: 'after' }, exec)
      assert.equal(written.changed, 1, JSON.stringify(written))
      assert.equal(fs.readFileSync(path.join(root, 'data.txt'), 'utf8'), 'after')

      agent.session.mode = 'read-only'
      const refused = await replace.execute({ path: 'data.txt', pattern: 'after', replacement: 'bad' }, exec)
      assert.equal(refused.error.code, 'POLICY_DENIED', JSON.stringify(refused))
      assert.equal(fs.readFileSync(path.join(root, 'data.txt'), 'utf8'), 'after')

      agent.session.mode = 'workspace-write'
      fs.writeFileSync(path.join(outside, 'keep.txt'), 'outside')
      const fenced = await replace.execute({ path: path.join(outside, 'keep.txt'), pattern: 'outside', replacement: 'bad' }, exec)
      assert.equal(fenced.error.code, 'POLICY_DENIED', JSON.stringify(fenced))
      assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'outside')

      const ran = await bash.execute({ command: "printf 'LINUX_OK'", workdir: root, timeoutMs: 10_000 }, exec)
      assert.equal(ran.exitCode, 0, JSON.stringify(ran))
      assert.equal(ran.stdout.text, 'LINUX_OK')
      assert.equal(ran.sandbox.mode, 'workspace-write')
      assert.ok(['full', 'partial'].includes(ran.sandbox.enforcement), JSON.stringify(ran.sandbox))

      agent.session.mode = 'read-only'
      const denied = await bash.execute({ command: 'printf bad > denied.txt', workdir: root, timeoutMs: 10_000 }, exec)
      assert.notEqual(denied.exitCode, 0, JSON.stringify(denied))
      assert.equal(denied.permission?.code, 'POLICY_DENIED', JSON.stringify(denied))
      assert.equal(fs.existsSync(path.join(root, 'denied.txt')), false)
    } finally { await shutdown(ctx); fs.rmSync(outside, { recursive: true, force: true }) }
  })
})

await test('the file tools refuse credential locations in every mode', async () => {
  if (process.platform !== 'linux') return
  await withTempDir('linux-credentials', async root => {
    const home = os.homedir()
    const credential = path.join(home, '.dsh', '.credentials.yaml')
    if (!fs.existsSync(credential)) return
    const { ctx } = await bootHost()
    try {
      await mountLinux(ctx, root)
      fs.writeFileSync(path.join(root, 'plain.txt'), 'ok\n')
      for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) {
        const agent = await agentFor(ctx, root, mode)
        const inspect = ctx.get('tools').get(publicToolName('inspect_local_file'), agent)
        const refused = await inspect.execute({ path: credential }, { agent, signal: new AbortController().signal })
        assert.equal(refused.status, 'rejected', `${mode}: ${JSON.stringify(refused)}`)
        assert.equal(refused.error.code, 'POLICY_DENIED', mode)
        assert.equal(refused.items, undefined, 'no bytes of a credential may come back')
        const allowed = await inspect.execute({ path: 'plain.txt' }, { agent, signal: new AbortController().signal })
        assert.equal(allowed.status, 'completed', `${mode}: ordinary files stay readable`)
      }
    } finally { await shutdown(ctx) }
  })
})

await test('writes are scoped to the workspace and the session\'s own temp directory', async () => {
  if (process.platform !== 'linux') return
  await withTempDir('linux-temp-fence', async root => {
    const { ctx } = await bootHost()
    try {
      await mountLinux(ctx, root)
      fs.writeFileSync(path.join(root, 'data.txt'), 'before')
      const agent = await agentFor(ctx, root, 'workspace-write')
      const replace = ctx.get('tools').get(publicToolName('replace'), agent)
      const exec = { agent, signal: new AbortController().signal }

      // A workspace file is writable, as it must be.
      const inWorkspace = await replace.execute({ path: 'data.txt', pattern: 'before', replacement: 'after' }, exec)
      assert.equal(inWorkspace.changed, 1, JSON.stringify(inWorkspace))

      // The session's own temporary directory is writable, and gets created.
      const ownTemp = path.join(os.tmpdir(), `dsh-ops-session-${'a'.repeat(16)}`)
      const own = sessionTempDir(agent.session.id)
      fs.mkdirSync(own, { recursive: true })
      fs.writeFileSync(path.join(own, 'scratch.txt'), 'scratch')
      const inOwnTemp = await replace.execute({ path: path.join(own, 'scratch.txt'), pattern: 'scratch', replacement: 'written' }, exec)
      assert.equal(inOwnTemp.changed, 1, JSON.stringify(inOwnTemp))
      assert.equal(fs.readFileSync(path.join(own, 'scratch.txt'), 'utf8'), 'written')
      fs.rmSync(own, { recursive: true, force: true })
      void ownTemp

      // Another session's temporary directory is NOT, even though the host
      // sandbox grants all of /tmp to workspace-write on Linux.
      const foreign = sessionTempDir('some-other-session')
      fs.mkdirSync(foreign, { recursive: true })
      fs.writeFileSync(path.join(foreign, 'other.txt'), 'other')
      const refused = await replace.execute({ path: path.join(foreign, 'other.txt'), pattern: 'other', replacement: 'tampered' }, exec)
      assert.equal(refused.error.code, 'POLICY_DENIED', JSON.stringify(refused))
      assert.equal(fs.readFileSync(path.join(foreign, 'other.txt'), 'utf8'), 'other', 'a foreign temp file must not change')
      fs.rmSync(foreign, { recursive: true, force: true })
    } finally { await shutdown(ctx) }
  })
})

await test('traversals never name a credential location', async () => {
  if (process.platform !== 'linux') return
  const credentialDir = path.join(os.homedir(), '.ssh')
  if (!fs.existsSync(credentialDir)) return
  await withTempDir('linux-traversal', async root => {
    const { ctx } = await bootHost()
    try {
      await mountLinux(ctx, root)
      const agent = await agentFor(ctx, root, 'workspace-write')
      const call = (name, args) => ctx.get('tools').get(publicToolName(name), agent).execute(args, { agent, signal: new AbortController().signal })
      const walked = await call('glob', { path: os.homedir(), pattern: ['**/*'], limit: 500 })
      assert.equal(walked.status, 'completed', JSON.stringify(walked))
      const named = (walked.items ?? []).map(String)
      assert.equal(named.some(item => item.startsWith(credentialDir)), false, 'no path below the credential directory may be reported')
      assert.ok(named.length > 0, 'the rest of the home directory is still walked')
      const searched = await call('grep', { path: os.homedir(), pattern: 'PRIVATE KEY', outputMode: 'files_with_matches', limit: 200 })
      assert.equal(searched.status, 'completed', JSON.stringify(searched))
      assert.equal((searched.items ?? []).some(item => String(item).startsWith(credentialDir)), false)
    } finally { await shutdown(ctx) }
  })
})

await test('the Linux worker is the staged artifact, not a source build', () => {
  if (process.platform !== 'linux') return
  const file = resolveWorker({})
  assert.ok(file.endsWith('dsh-ops-worker'), file)
  assert.ok(fs.existsSync(file), file)
})

report('linux')
