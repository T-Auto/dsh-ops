/**
 * The session bash layer on a real host, with the machine's own bash: what #235
 * and #237 look like at the boundary the caller sees.
 *
 * Nothing here is a fake. `mountSessionBash` publishes `ops_bash` into a real
 * scoped registry, the host's own subprocess service spawns a real bash, and the
 * request travels through `ctx.get('tools').execute` -- the path that once
 * reported "returned invalid output" because a folded argument refusal failed
 * the registered output schema (#235).
 *
 * @module dsh-ops/test/shells-session
 */

import fs from 'node:fs'
import path from 'node:path'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import LocalJobs from '@deepseek-ai/dsh-jobs-local'
import { Service } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { assert, report, scenarioDir, skipSuite, test, waitFor, withTempDir } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { resolveShells } from '../lib/shells.js'
import { hostForeground } from '../lib/shells/host-contract.js'
import { BASH_ARGUMENT_ERROR_CODE } from '../lib/shells/argument-error.js'
import { bashRefusalValue, mountSessionBash } from '../lib/session-shells.js'

const bash = resolveShells(process.env.DSH_OPS_TEST_BASH ? { bashPath: process.env.DSH_OPS_TEST_BASH } : {}).bash
if (!bash.available) {
  skipSuite('shells-session', 'this suite needs a real bash to run a command through the session layer: ' + bash.detail)
}

const signal = () => new AbortController().signal

await test('Bash follows live cwd without changing the header and exposes its base through the registry', async () => {
  const { ctx } = await bootHost()
  try {
    await withTempDir('bash-live-cwd', async root => {
      const live = path.join(root, 'tools'); fs.mkdirSync(live)
      fs.mkdirSync(path.join(live, 'child')); fs.writeFileSync(path.join(live, 'probe.txt'), 'TOOLS')
      fs.writeFileSync(path.join(root, 'probe.txt'), 'ROOT')
      let calls = 0
      await ctx.plugin(inner => inner.provide('workingDirectory', {
        async ensure(_agent, control) { await Promise.resolve(); control.throwIfAborted(); calls++; return live },
        get: () => live,
      }))
      const { agent, scope } = await publishOpsBash(ctx, 'bash-live-cwd', root)
      try {
        const tools = ctx.get('tools'), tool = tools.get('ops_bash', agent)
        const exec = { agent, signal: signal() }
        const args = { command: 'cat probe.txt', description: 'Read the live directory marker' }
        const value = await tool.execute(args, exec)
        assert.equal(value.status, 'completed', JSON.stringify(value)); assert.equal(value.stdout.text.trim(), 'TOOLS')
        assert.equal(value.resolvedFrom, live); assert.equal(value.cwdSource, 'workingDirectory')
        assert.ok(tool.output.render(args, value)[0].text.includes('resolvedFrom='))
        const child = await tool.execute({ command: 'echo CHILD', description: 'Resolve a relative child directory', workdir: 'child' }, exec)
        assert.equal(child.status, 'completed', JSON.stringify(child))
        assert.equal(calls, 2); assert.equal(agent.session.header.cwd, root)
        const service = ctx.get('workingDirectory')
        service.ensure = async () => { throw new Error('live directory unavailable') }
        const failed = await tool.execute(args, exec)
        assert.equal(failed.status, 'failed'); assert.equal(failed.failure.effectState, 'none')
        assert.ok(!failed.stdout.text.includes('ROOT'))
      } finally { await scope.dispose() }
    })
  } finally { await shutdown(ctx) }
})

/**
 * Publish `ops_bash` into one real agent scope, the way the component row does.
 * @param {object} ctx - the booted host context.
 * @param {string} id - the session id.
 * @param {string} workspace - the session workspace.
 * @returns {Promise<{agent: object, scope: object, tool: object}>} the scoped call surface.
 */
async function publishOpsBash(ctx, id, workspace) {
  const agent = { id, session: { id, header: { cwd: workspace } } }
  const scope = createScope(ctx, agent)
  agent.ctx = scope.ctx
  await ctx.plugin(Subprocess)
  await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: workspace }) }))
  await ctx.plugin({ inject: ['tools'], apply(inner) { mountSessionBash(inner, { publishBashTool: true }, { bash }) } })
  await ctx.serial('agent/created', { agent, source: 'startup' })
  await waitFor(() => ctx.get('tools').get('ops_bash', agent) !== undefined, { what: 'ops_bash publication to the session' })
  const tool = ctx.get('tools').get('ops_bash', agent)
  assert.deepEqual(tool.parameters.required, ['description'], 'the real session publishes the host projection, not the legacy helper')
  return { agent, scope, tool }
}

/** The real-shell check for #237; registered on POSIX only, for the reason at its registration. */
async function relativeWorkdirRunsInTheSession() {
  const { ctx } = await bootHost()
  const previous = process.cwd()
  try {
    await withTempDir('shells-session-workspace', async workspace => {
      const child = path.join(workspace, 'retest-dir')
      fs.mkdirSync(child)
      // The helper directory is deliberately NOT a `withTempDir`. On Windows a directory a process
      // has used as its working directory cannot be removed while the handle is still open, and the
      // fixture's `rmSync` then fails with EPERM before any assertion is reported (windows-latest
      // validate). A scenario directory goes away with the rest of the suite home, after this
      // process has exited, which is when Windows lets it go.
      const helper = scenarioDir('shells-session-helper')
      {
        // The same directory name exists under the helper cwd, so a wrong resolution would succeed
        // in the wrong place: only the resolved path proves which one the command ran in.
        fs.mkdirSync(path.join(helper, 'retest-dir'))
        process.chdir(helper)
        try {
          const { agent, scope, tool } = await publishOpsBash(ctx, 'shells-session-relative', workspace)
          try {
            for (const [workdir, expected] of [
              [undefined, workspace],
              ['', workspace],
              ['.', workspace],
              ['retest-dir', child],
              ['./retest-dir', child],
              ['retest-dir/../retest-dir', child],
              [child, child],
            ]) {
              const value = await tool.execute({ command: 'pwd -P', description: 'Check session working directory', workdir }, { agent, signal: signal() })
              assert.equal(value.status, 'completed', JSON.stringify(value))
              assert.equal(value.stdout.text.trim(), expected, 'workdir=' + JSON.stringify(workdir))
            }
          } finally { await scope.dispose() }
        } finally { process.chdir(previous) }
      }
    })
  } finally {
    process.chdir(previous)
    await shutdown(ctx)
  }
}

// Registered on POSIX only. The bundled bash on Windows answers `pwd -P` with a POSIX path
// (`/d/a/...`) for the same directory this suite builds as `D:\a\...`, so a comparison there
// would assert the shell's path rendering rather than the anchoring. The Windows resolution rules
// (session-drive relative, cross-drive refusal) are asserted without a shell in
// `test/shells-guards.test.mjs`, which runs everywhere.
if (process.platform !== 'win32') await test('a relative workdir runs in the session workspace, not the helper cwd (#237)', relativeWorkdirRunsInTheSession)

await test('a wrong argument reaches the caller as itself, not as invalid output (#235)', async () => {
  const { ctx } = await bootHost()
  try {
    await withTempDir('shells-session-args', async workspace => {
      const { agent, scope, tool } = await publishOpsBash(ctx, 'shells-session-args', workspace)
      try {
        let call = 0
        for (const [args, pattern, argument] of [
          [{ command: 'echo hi', graceMs: -1 }, /invalid graceMs/, 'graceMs'],
          [{ command: 'echo hi', run_in_background: true }, /unknown key "run_in_background"/, 'run_in_background'],
          [{ command: 'echo hi', script_path: 'x.sh' }, /exactly one of command or script_path/, 'script_path'],
          [{ command: 'echo hi', workdir: path.join(workspace, 'missing') }, /invalid workdir: must be an existing directory/, 'workdir'],
        ]) {
          const input = { ...args, description: 'Report the precise invalid argument' }
          const value = await tool.execute(input, { agent, signal: signal() })
          assert.equal(value.status, 'failed'); assert.equal(value.failure.code, BASH_ARGUMENT_ERROR_CODE)
          assert.equal(value.failure.effectState, 'none'); assert.equal(value.failure.retry, 'after-input-change')
          assert.match(value.error, pattern); assert.ok(value.error.includes(argument))
          // Through the real registry the caller reads the refusal itself; the pre-fix path ended
          // in "returned invalid output" and the argument was never named.
          const result = await ctx.get('tools').execute({
            name: 'ops_bash', callId: 'shells-session-args-' + call++, agent, signal: signal(), arguments: input,
          })
          assert.equal(result.isError, false, JSON.stringify(result))
          assert.equal(result.value.status, 'failed')
          assert.match(result.value.error, pattern)
          assert.doesNotMatch(result.value.error, /invalid output/)
        }
      } finally { await scope.dispose() }
    })
  } finally { await shutdown(ctx) }
})

await test('a vanished session workspace is named as the missing directory (#180)', async () => {
  const { ctx } = await bootHost()
  try {
    await withTempDir('shells-session-gone', async workspace => {
      const { agent, scope, tool } = await publishOpsBash(ctx, 'shells-session-gone', workspace)
      try {
        fs.rmSync(workspace, { recursive: true, force: true })
        const input = { command: 'echo hi', description: 'Report the missing session workspace' }
        const value = await tool.execute(input, { agent, signal: signal() })
        assert.equal(value.failure.code, BASH_ARGUMENT_ERROR_CODE)
        assert.equal(value.failure.effectState, 'none')
        assert.match(value.error, /invalid workdir: must be an existing directory/)
        assert.ok(value.error.includes(workspace), value.error)
        assert.doesNotMatch(value.error, /bash executable|provision-shells/)
        const result = await ctx.get('tools').execute({
          name: 'ops_bash', callId: 'shells-session-gone', agent, signal: signal(), arguments: input,
        })
        assert.equal(result.isError, false, JSON.stringify(result))
        assert.equal(result.value.status, 'failed')
        assert.ok(result.value.error.includes(workspace), result.value.error)
      } finally { await scope.dispose() }
    })
  } finally { await shutdown(ctx) }
})

await test('every value the session layer settles on satisfies its registered schema (#235)', async () => {
  const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools')
  const { ctx } = await bootHost()
  try {
    await withTempDir('shells-session-schema', async workspace => {
      const { agent, scope, tool } = await publishOpsBash(ctx, 'shells-session-schema', workspace)
      try {
        for (const command of ['printf ok', 'exit 7']) {
          const value = await tool.execute({ command, description: 'Check the registered result schema' }, { agent, signal: signal() })
          assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, 'value'), [], JSON.stringify(value))
        }
        // The refusal shape the session layer folds a runtime failure into: this is the value that
        // must not fail the host's own validation.
        const folded = hostForeground(bashRefusalValue(new Error('EXECUTOR_UNAVAILABLE: probe')))
        assert.deepEqual(validateJsonSchemaValue(tool.output.schema, folded, 'value'), [])
        assert.equal(folded.status, 'failed')
      } finally { await scope.dispose() }
    })
  } finally { await shutdown(ctx) }
})


/** A tracked `jobs` service, the way the host provides it: every `ctx.get('jobs')` is a new proxy. */
class TrackedJobs extends Service {
  constructor(ctx) {
    super(ctx, 'jobs')
    this.records = []
  }

  start(spec) {
    const hooks = spec.run({ updateProgress() {} })
    this.records.push({ id: 'ops-job-1', spec, hooks })
    return 'ops-job-1'
  }

  wait() { return this.records[0].hooks.done }

  kill(_id, _owner, reason) { this.records[0].hooks.cancel(reason) }

  remove() {}

  read() { return { chunks: [], lossy: false, job: { output: { spillPaths: [] } } } }
}

await test('host jobs mount and teardown update the scoped background schema', async () => {
  const { ctx } = await bootHost()
  try {
    await withTempDir('shells-session-jobs', async workspace => {
      const { agent, scope } = await publishOpsBash(ctx, 'shells-session-jobs', workspace)
      try {
        const current = () => ctx.get('tools').get('ops_bash', agent)
        assert.equal(current().parameters.properties.run_in_background, undefined)
        let registry
        const jobs = await ctx.plugin(inner => { registry = new TrackedJobs(inner) })
        await waitFor(() => current()?.parameters.properties.run_in_background !== undefined, { what: 'background Bash schema publication' })
        // The registry is a tracked service: a fresh traceable proxy answers every `ctx.get('jobs')`,
        // so an identity check against the definition-time value can never hold. The bound registry
        // must serve the call instead — this is the production failure the fix removes.
        const value = await current().execute({ command: 'printf NPM_BG', description: 'Run a real background command', run_in_background: true }, { agent, signal: signal() })
        assert.equal(value.kind, 'background', JSON.stringify(value))
        assert.equal(value.jobId, 'ops-job-1')
        assert.equal((await registry.records[0].hooks.done).status, 'completed')
        await jobs.dispose()
        await waitFor(() => current()?.parameters.properties.run_in_background === undefined, { what: 'background Bash schema removal' })
      } finally { await scope.dispose() }
    })
  } finally { await shutdown(ctx) }
})

await test('real background and promoted jobs expose their description in the host list and result (#322)', async () => {
  const { ctx } = await bootHost()
  try {
    await withTempDir('shells-session-labels', async workspace => {
      const { agent, scope } = await publishOpsBash(ctx, 'shells-session-labels', workspace)
      let jobs
      try {
        // Only session lookup is a fixture; jobs, subprocesses, schemas and rendering are real.
        await ctx.plugin(inner => inner.provide('agents', { get: id => id === agent.id ? agent : undefined }))
        await ctx.plugin(LocalJobs, {})
        await ctx.plugin(inner => { jobs = inner.get('jobs'); jobs.attachController('shells-session-labels') })
        await waitFor(() => ctx.get('tools').get('ops_bash', agent)?.parameters.properties.run_in_background !== undefined,
          { what: 'real host jobs publication' })
        for (const background of [true, false]) {
          const description = background ? '后台 "测试" task' : 'Wait for a promoted test task'
          const result = await ctx.get('tools').execute({
            name: 'ops_bash', callId: `shells-session-label-${background}`, agent, signal: signal(),
            arguments: { command: 'printf LABEL_READY; sleep 30', description,
              ...(background ? { run_in_background: true } : { timeoutMs: 500 }) },
          })
          assert.equal(result.isError, false, JSON.stringify(result))
          assert.equal(result.value.kind, background ? 'background' : 'promoted', JSON.stringify(result.value))
          assert.equal(result.value.label, description)
          const job = jobs.list(agent.id).find(job => job.id === result.value.jobId)
          assert.equal(job.label, description)
          const tool = ctx.get('tools').get('ops_bash', agent)
          assert.ok(tool.output.render({}, result.value)[0].text.includes(JSON.stringify(description)))
          jobs.kill(job.id, agent.id, 'label test completed')
          const settled = await jobs.wait(job.id, 10000, agent.id)
          assert.ok(['completed', 'failed', 'killed'].includes(settled.status))
          jobs.remove(job.id, agent.id)
        }
      } finally { await scope.dispose() }
    })
  } finally { await shutdown(ctx) }
})

report('shells-session')
