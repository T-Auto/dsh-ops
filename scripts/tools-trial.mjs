#!/usr/bin/env node
/**
 * Tools trial: call every tool this build publishes, against real files, and print a table.
 *
 * Why a script and not a suite: `test/*.test.mjs` is the inventory the release gate asserts was
 * collected, and this trial is deliberately **not** a gate — it reports what each tool actually did
 * on a real host. CI runs it in its own job with `continue-on-error`, so a broken tool is visible
 * without blocking a merge.
 *
 * Exit code: 0 when every attempted tool behaved, 1 when any of them did not. Tools this build does
 * not publish, and published tools without a scenario yet, are reported as `skipped` with a reason.
 *
 * Run it locally as `DSH_HOME=$(mktemp -d) node scripts/tools-trial.mjs`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { publicToolName } from '../lib/policy.js'

// The suite harness refuses to run when `DSH_HOME` points outside the system temp directory, and
// mounting the plugin touches its own home. Own a throwaway one here — assigned *before* the harness
// is imported — so the script runs anywhere, and print it so a report is reproducible.
// The harness refuses any `DSH_HOME` outside the system temp directory, and a trial must never touch
// a real profile home — so a caller-supplied path outside `os.tmpdir()` is replaced, not trusted.
const tempRoot = tmpdir()
const foreignHome = process.env.DSH_HOME !== undefined
  && !path.resolve(process.env.DSH_HOME).startsWith(path.resolve(tempRoot))
const ownedHome = process.env.DSH_HOME === undefined || foreignHome
if (ownedHome) process.env.DSH_HOME = mkdtempSync(path.join(tempRoot, 'dsh-ops-trial-home-'))
const { bootHost, callTool, scopedToolNames, shutdown } = await import('../test/lib/host.mjs')

const REPORT = 'tools-trial-report.md'
const results = []
const record = (tool, outcome, detail) => {
  results.push({ tool, outcome, detail })
  process.stdout.write(`  ${outcome === 'ok' ? 'ok   ' : outcome === 'failed' ? 'FAIL ' : 'skip '} ${tool}${detail === undefined ? '' : ` — ${detail}`}\n`)
}

process.stdout.write(`  home: ${process.env.DSH_HOME}\n`)
const workspace = mkdtempSync(path.join(tmpdir(), 'dsh-ops-trial-'))
mkdirSync(path.join(workspace, 'nested'), { recursive: true })
writeFileSync(path.join(workspace, 'alpha.txt'), 'alpha line\nsecond line\n')
writeFileSync(path.join(workspace, 'beta.txt'), 'beta only\n')
writeFileSync(path.join(workspace, 'nested', 'gamma.txt'), 'gamma\n')

const { ctx } = await bootHost()
let exited = 0
/** Hoisted: the report below is written after the `try`, where a block-scoped binding is gone. */
let published = []
let agent
let agentScope
try {
  // The file component needs the host services a real profile provides; without them the mount is
  // the thing that failed, not the tool, so the trial says so instead of reporting tool failures.
  const Subprocess = (await import('@deepseek-ai/dsh-subprocess-local')).default
  const Sandbox = (await import('@deepseek-ai/dsh-sandbox-local')).default
  if (!ctx.get('subprocess')) await ctx.plugin(Subprocess)
  if (!ctx.get('sandbox')) await ctx.plugin(Sandbox, {})
  if (!ctx.get('sandboxPolicy')) {
    await ctx.plugin(inner => inner.provide('sandboxPolicy', {
      resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: session.header.cwd, sessionId: session.id }),
    }))
  }

  // Exercise the shipped merged entry, not its retained legacy component rows.
  const plugin = await import('../lib/index.js')
  await ctx.plugin(plugin, {
    minimal: { enabled: false }, ptc: { enabled: false }, cordis: { enabled: false },
    standard: { residentTools: true, required: false,
      ...(process.env.DSH_OPS_TEST_BASH ? { bashPath: process.env.DSH_OPS_TEST_BASH } : {}) },
    discovery: { required: true, allowedTools: ['replace'], alwaysLoaded: ['replace'] },
  })

  agent = { id: 'trial', session: { id: 'trial', mode: 'danger-full-access', header: { cwd: workspace, agentPreset: 'standard' } } }
  const { createScope } = await import('@deepseek-ai/dsh-scope')
  await ctx.plugin({ inject: ['tools'], apply(inner) { agentScope = createScope(inner, agent) } })
  agent.ctx = agentScope.ctx
  await ctx.serial('agent/created', { agent, source: 'startup' })
  // Scoped publication is asynchronous. Wait for every file scenario, not a global count;
  // optional Bash may legitimately be absent (for example, on a POSIX bare host).
  const expected = ['read_files', 'inspect_local_file', 'grep', 'glob', 'replace'].map(publicToolName)
  const deadline = Date.now() + 10_000
  for (;;) {
    published = scopedToolNames(ctx, agent)
    if (expected.every(name => published.includes(name))) break
    if (Date.now() >= deadline) throw new Error(
      `scoped publication timed out: missing `
      + expected.filter(name => !published.includes(name)).join(', '))
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  process.stdout.write('  published: ' + (published.join(', ') || '(none)') + '\n')

  /** Call one tool, then judge the whole structured answer — field names differ per tool. */
  const attempt = async (raw, args, expect, note, absent = 'not published by this build') => {
    const name = publicToolName(raw)
    if (!published.includes(name)) {
      record(name, 'skipped', absent)
      return undefined
    }
    try {
      const { value } = await callTool(ctx, name, args, new AbortController().signal, agent)
      const body = JSON.stringify(value)
      if (value?.status !== undefined && value.status !== 'completed') {
        record(name, 'failed', `status=${value.status} ${body.slice(0, 160)}`)
        exited = 1
        return value
      }
      if (!body.includes(expect)) {
        record(name, 'failed', `expected ${JSON.stringify(expect)} in the answer, got ${body.slice(0, 160)}`)
        exited = 1
        return value
      }
      record(name, 'ok', note ?? `${body.length} bytes of structured answer`)
      return value
    } catch (error) {
      record(name, 'failed', error.message.split('\n')[0])
      exited = 1
      return undefined
    }
  }

  await attempt('read_files', { files: [{ path: 'alpha.txt' }, { path: 'beta.txt' }] }, 'alpha line', 'read two real files in one call')
  await attempt('inspect_local_file', { path: 'alpha.txt' }, 'alpha line', 'read a real file')
  await attempt('grep', { pattern: 'gamma', path: '.' }, 'gamma', 'found a match in a nested file')
  await attempt('glob', { pattern: ['*.txt'], path: '.' }, 'alpha.txt', 'listed the top-level glob')
  // The receipt reports counts, not the new text; the disk assertion below is the behaviour check.
  const replacement = await attempt('replace', { path: 'alpha.txt', pattern: 'alpha', replacement: 'ALPHA' }, '"changed":1', 'replaced one literal match')
  const replaced = readFileSync(path.join(workspace, 'alpha.txt'), 'utf8')
  if (replacement !== undefined && !replaced.includes('ALPHA')) {
    record(publicToolName('replace'), 'failed', 'the file on disk did not change')
    exited = 1
  }
  await attempt('bash', { description: 'Print the trial success marker', command: 'node -e "console.log(\'trial-ok\')"' }, 'trial-ok', 'ran a real command',
    'merged Standard mode did not publish Bash on this host (platform policy or optional shell unavailable)')

  // Anything published but not yet in the table above is reported honestly rather than ignored.
  const attempted = new Set(results.map(result => result.tool))
  for (const name of published) if (!attempted.has(name)) record(name, 'skipped', 'published, no trial scenario yet')
} catch (error) {
  record('mount', 'failed', error.message.split('\n')[0])
  exited = 1
} finally {
  if (agent?.ctx) await ctx.serial('agent/disposed', { agent }).catch(error => {
    record('lifecycle', 'failed', error.message.split('\n')[0])
    exited = 1
  })
  await agentScope?.dispose().catch(error => {
    record('scope', 'failed', error.message.split('\n')[0])
    exited = 1
  })
  await shutdown(ctx).catch(() => {})
  rmSync(workspace, { recursive: true, force: true })
  if (ownedHome) rmSync(process.env.DSH_HOME, { recursive: true, force: true })
}

const ok = results.filter(result => result.outcome === 'ok').length
const failed = results.filter(result => result.outcome === 'failed').length
const skipped = results.filter(result => result.outcome === 'skipped').length
const lines = [
  '# Tools trial report',
  '',
  `- attempted: **${ok + failed}** (ok ${ok}, failed ${failed})`,
  `- skipped: **${skipped}**`,
  `- host: ${process.platform}-${process.arch}, node ${process.version}`,
  `- DSH_HOME: ${process.env.DSH_HOME}`,
  `- published by this build: ${published.join(', ') || '(none)'}`,
  '',
  '| tool | outcome | detail |',
  '| --- | --- | --- |',
  ...results.map(result => `| \`${result.tool}\` | ${result.outcome} | ${result.detail ?? ''} |`),
  '',
]
writeFileSync(REPORT, lines.join('\n'))
process.stdout.write(`\ntools trial: ${ok + failed} attempted, ${ok} ok, ${failed} failed, ${skipped} skipped → ${REPORT}\n`)
process.exit(exited)
