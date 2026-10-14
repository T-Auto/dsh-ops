/**
 * Real Linux acceptance: one workspace, the whole tool loop, the real host.
 *
 * The linux suite proves the surface is published and the modes are honoured.
 * This suite drives the same tools end to end the way a session does - glob,
 * grep, inspect, replace, bash - against real files under the real DSH sandbox,
 * so a passing run is evidence about the shipped composition rather than about
 * a fixture.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createScope } from '@deepseek-ai/dsh-scope'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { applyComponent } from '../lib/index.js'
import { BASH_TOOL, publicToolName } from '../lib/policy.js'
import { assert, report, test, waitFor, withTempDir } from './lib/harness.mjs'
import { bootHost, publicToolNames, shutdown } from './lib/host.mjs'

const FILE_TOOLS = ['glob', 'grep', 'inspect_local_file', 'replace'].map(publicToolName)

async function mountLinux(ctx) {
  await ctx.plugin(Subprocess)
  await ctx.plugin(Sandbox, {})
  await ctx.plugin(inner => inner.provide('sandboxPolicy', {
    resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: session.header.cwd, sessionId: session.id }),
  }))
  await ctx.plugin({ name: 'fixture-linux-acceptance', apply(inner) {
    return applyComponent(inner, { promptPolicy: false, publishBashTool: true, allowSystemShellFallback: true, configUpdateVersion: 1 }, 'linux')
  } })
  await waitFor(() => FILE_TOOLS.every(name => publicToolNames(ctx).includes(name)), 10_000)
}

async function sessionFor(ctx, root, mode) {
  const agent = { id: `accept-${mode}`, session: { id: `accept-${mode}`, mode, header: { cwd: root } } }
  agent.ctx = createScope(ctx, agent).ctx
  await ctx.serial('agent/created', { agent })
  await waitFor(() => ctx.get('tools').get(BASH_TOOL, agent) !== undefined, 10_000)
  return agent
}

function callTool(ctx, name, agent, args) {
  const tool = ctx.get('tools').get(name, agent)
  assert.ok(tool, `${name} is not visible to the session`)
  return tool.execute(args, { agent, signal: new AbortController().signal })
}

await test('a real session walks the whole Linux tool loop', async () => {
  if (process.platform !== 'linux') return
  await withTempDir('linux-accept', async root => {
    const outsideBase = os.tmpdir() === '/tmp' ? '/var/tmp' : os.tmpdir()
    const outside = fs.mkdtempSync(path.join(outsideBase, 'ops-accept-outside-'))
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'alpha.js'), 'export const ALPHA_MARKER = 1\n')
    fs.writeFileSync(path.join(root, 'src', 'beta.txt'), 'plain text\n')
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'outside\n')
    const { ctx } = await bootHost()
    try {
      await mountLinux(ctx)
      const agent = await sessionFor(ctx, root, 'workspace-write')

      const found = await callTool(ctx, publicToolName('glob'), agent, { path: 'src', pattern: ['**/*.js'] })
      assert.equal(found.status, 'completed', JSON.stringify(found))
      assert.deepEqual(found.items.map(item => path.basename(String(item))), ['alpha.js'])

      const searched = await callTool(ctx, publicToolName('grep'), agent, { path: '.', pattern: 'ALPHA_MARKER', outputMode: 'content' })
      assert.equal(searched.status, 'completed', JSON.stringify(searched))
      assert.equal(searched.matched, 1, JSON.stringify(searched))

      const read = await callTool(ctx, publicToolName('inspect_local_file'), agent, { path: 'src/alpha.js' })
      assert.equal(read.status, 'completed', JSON.stringify(read))
      assert.match(read.items.map(item => item.text).join('\n'), /ALPHA_MARKER/)

      const dry = await callTool(ctx, publicToolName('replace'), agent, { path: 'src/alpha.js', pattern: 'ALPHA_MARKER', replacement: 'BETA_MARKER', dryRun: true })
      assert.equal(dry.changed, 0, JSON.stringify(dry))
      assert.match(fs.readFileSync(path.join(root, 'src', 'alpha.js'), 'utf8'), /ALPHA_MARKER/, 'dryRun never writes')

      const written = await callTool(ctx, publicToolName('replace'), agent, { path: 'src/alpha.js', pattern: 'ALPHA_MARKER', replacement: 'BETA_MARKER' })
      assert.equal(written.changed, 1, JSON.stringify(written))
      assert.match(fs.readFileSync(path.join(root, 'src', 'alpha.js'), 'utf8'), /BETA_MARKER/)

      const ran = await callTool(ctx, BASH_TOOL, agent, { command: "printf 'ACCEPT_OK' && mkdir -p made && printf x > made/file.txt", workdir: root, timeoutMs: 30_000 })
      assert.equal(ran.exitCode, 0, JSON.stringify(ran))
      assert.equal(ran.stdout.text, 'ACCEPT_OK')
      assert.equal(fs.readFileSync(path.join(root, 'made', 'file.txt'), 'utf8'), 'x')
      assert.ok(['full', 'partial'].includes(ran.sandbox.enforcement), JSON.stringify(ran.sandbox))

      // The sandbox may report a denial in its own dialect; the fact that must
      // hold either way is that nothing outside the authorized roots changed.
      const fenced = await callTool(ctx, BASH_TOOL, agent, { command: `printf bad > ${JSON.stringify(path.join(outside, 'escape.txt'))}`, workdir: root, timeoutMs: 30_000 })
      assert.equal(fs.existsSync(path.join(outside, 'escape.txt')), false, `sandbox let a write escape: ${JSON.stringify(fenced)}`)

      agent.session.mode = 'read-only'
      const refused = await callTool(ctx, BASH_TOOL, agent, { command: 'printf bad > readonly.txt', workdir: root, timeoutMs: 30_000 })
      assert.notEqual(refused.exitCode, 0, JSON.stringify(refused))
      assert.equal(refused.permission?.code, 'POLICY_DENIED', JSON.stringify(refused))
      assert.equal(fs.existsSync(path.join(root, 'readonly.txt')), false)
    } finally { await shutdown(ctx); fs.rmSync(outside, { recursive: true, force: true }) }
  })
})

await test('a real repository workload: search, edit a copy, run real commands', async () => {
  if (process.platform !== 'linux') return
  await withTempDir('linux-workload', async root => {
    const repo = path.resolve('.')
    const { ctx } = await bootHost()
    try {
      await mountLinux(ctx)
      const agent = await sessionFor(ctx, root, 'workspace-write')
      const call = (name, args) => callTool(ctx, name, agent, args)

      // Search a real repository, not a fixture.
      const counted = await call(publicToolName('grep'), { path: repo, pattern: 'function ', outputMode: 'count', limit: 5000 })
      assert.equal(counted.status, 'completed', JSON.stringify(counted))
      assert.ok(counted.matched > 100, JSON.stringify(counted))
      const summary = await call(publicToolName('grep'), { path: repo, pattern: 'POLICY_DENIED', outputMode: 'summary' })
      assert.equal(summary.status, 'completed', JSON.stringify(summary))
      assert.ok(summary.files > 0, JSON.stringify(summary))
      const libFiles = await call(publicToolName('glob'), { path: repo, pattern: ['lib/**/*.js'], limit: 5000 })
      assert.ok(libFiles.total > 20, JSON.stringify(libFiles))

      // Edit a real directory that contains a binary file. The icon used to fail
      // the whole call; it must now be reported as skipped while the text files
      // around it are edited.
      const copy = path.join(root, 'lib-copy')
      fs.cpSync(path.join(repo, 'lib'), copy, { recursive: true })
      const applied = await call(publicToolName('replace'), { path: 'lib-copy', pattern: 'TOOLING_SECTION', replacement: 'TOOLING_SECTION' })
      assert.equal(applied.status, 'completed', JSON.stringify(applied))
      assert.ok(applied.changed > 0, JSON.stringify(applied))
      assert.ok(applied.skipped > 0, 'the binary icon is reported as skipped, not as a failure')
      assert.ok(Array.isArray(applied.skippedPaths) && applied.skippedPaths.length > 0, 'the skipped files are named')

      // Real commands through the confined bash.
      const node = await call(BASH_TOOL, { command: 'node -e "console.log(process.version)"', workdir: root, timeoutMs: 30_000 })
      assert.equal(node.exitCode, 0, JSON.stringify(node))
      assert.match(node.stdout.text, /^v\d+/)
      const git = await call(BASH_TOOL, { command: `git -C ${JSON.stringify(repo)} log --oneline -1`, workdir: root, timeoutMs: 30_000 })
      assert.equal(git.exitCode, 0, JSON.stringify(git))
      assert.ok(git.stdout.text.trim().length > 0)
      const failing = await call(BASH_TOOL, { command: 'node -e "process.exit(3)"', workdir: root, timeoutMs: 30_000 })
      assert.equal(failing.exitCode, 3, JSON.stringify(failing))
      const piped = await call(BASH_TOOL, { command: `grep -c "export function" ${JSON.stringify(path.join(repo, 'lib', 'shells.js'))}`, workdir: root, timeoutMs: 30_000 })
      assert.equal(piped.exitCode, 0, JSON.stringify(piped))
      assert.ok(Number(piped.stdout.text.trim()) > 0, JSON.stringify(piped))
    } finally { await shutdown(ctx) }
  })
})

report('linux-acceptance')
