/**
 * The background tools' argument contract.
 *
 * Issue #14: `ops_job_output {"id": "j-..."}` answered "This job was not started
 * by this session on the current connection." while `ops_job_list` listed that
 * same job as owned. The ownership check read `args?.job_id` before anything
 * validated the key, so a mistyped or missing field was reported as a lost job —
 * and the caller was pointed at session ownership instead of at its own
 * arguments.
 *
 * These checks pin the three outcomes apart (undeclared key, missing field,
 * genuinely foreign job), prove an argument error never reaches the server, and
 * prove the ownership check itself is untouched. No FastCtx executable is
 * needed: the surface is driven through its own registration path with a
 * stand-in client, which is exactly the seam the bug lived on.
 *
 * @module dsh-ops/test/jobs-args
 */

import { resolveConfig } from '../lib/config.js'
import { BACKGROUND_TOOLS, publicToolName } from '../lib/policy.js'
import { FastCtxTools } from '../lib/tools.js'
import { assert, report, test } from './lib/harness.mjs'

/**
 * The background schemas as FastCtx publishes them (properties + required).
 *
 * The property ORDER is part of the fixture, not decoration: the refusal in
 * `lib/tools.js` lists the accepted keys in schema order, and FastCtx
 * publishes them alphabetically (serde_json's map is a BTreeMap, and the
 * vendored fork does not enable `preserve_order`). A fixture in Rust field
 * order would make the suite assert a string the running server never
 * produces — a real-machine check caught exactly that drift.
 */
const RUNTIME_TOOLS = Object.freeze([
  {
    name: 'run_background',
    description: 'Start a bash command as a background job.',
    inputSchema: {
      type: 'object',
      properties: { command: {}, cwd: {}, encoding: {}, login_shell: {} },
      required: ['command'],
    },
  },
  {
    name: 'job_output',
    description: 'Query a background job.',
    inputSchema: {
      type: 'object',
      properties: { after_seq: {}, encoding: {}, job_id: {}, wait_ms: {} },
      required: ['job_id'],
    },
  },
  {
    // Every field carries a serde default upstream, so nothing is required here.
    name: 'job_list',
    description: 'List persistent background jobs.',
    inputSchema: { type: 'object', properties: { limit: {}, offset: {}, status: {} } },
  },
  {
    name: 'job_kill',
    description: 'Kill a background job.',
    inputSchema: { type: 'object', properties: { job_id: {} }, required: ['job_id'] },
  },
])

/** The job id the stand-in server hands back for a launch. */
const STARTED = 'j-abc123'

/**
 * One background surface over a stand-in server.
 *
 * The surface is the plugin's own `FastCtxTools`, driven through the tool
 * definitions it really registers, so the checks cover the shipping code path
 * rather than a copy of it.
 * @param {ReadonlyArray<object>} [tools] - the schemas the server publishes.
 * @returns {{surface: FastCtxTools, session: object, calls: object[], call: (rawName: string, args: object) => Promise<{ok: boolean, value?: object, message?: string}>}} the harness.
 */
function harness(tools = RUNTIME_TOOLS) {
  const registered = new Map()
  const toolsService = {
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
    schemas: () => [],
  }
  const calls = []
  const client = {
    callTool: async (name, args) => {
      calls.push({ name, args })
      const text = name === 'run_background'
        ? `started\n\n(Complete: job ${STARTED} started; log at /logs/${STARTED}.log.)`
        : `server ran ${name}`
      return { content: [{ type: 'text', text }] }
    },
  }
  const surface = new FastCtxTools({
    ctx: {
      tools: toolsService,
      get: (name) => name === 'sandboxPolicy'
        ? { resolve: () => ({ mode: 'danger-full-access' }) }
        : name === 'tools' ? toolsService : undefined,
    },
    config: resolveConfig({ enableShellTools: true, toolCallTimeoutMs: 5000 }),
    runtime: { file: '/nonexistent-fastctx', source: 'suite', version: 'stand-in' },
  })
  surface.client = client
  surface.bashAvailable = true
  surface.authorityAvailable = true
  surface.tools = tools
  surface.commandTools = BACKGROUND_TOOLS
  const session = { header: { cwd: '/session-cwd' } }
  surface.attachAgent({
    session,
    ctx: {
      plugin(body) {
        body({ inject: (_deps, publish) => publish({ tools: toolsService }) })
        return { dispose() {} }
      },
    },
  })
  const call = async (rawName, args) => {
    const definition = registered.get(publicToolName(rawName))
    if (!definition) throw new Error(`no registered definition for ${publicToolName(rawName)}`)
    try { return { ok: true, value: await definition.execute(args, { agent: { session } }) } }
    catch (error) { return { ok: false, message: error.message } }
  }
  return { surface, session, calls, call }
}

await test('a mistyped job_id is an argument error, not a lost job', async () => {
  const h = harness()
  h.surface.ownedJobs.set(h.session, new Set([STARTED]))
  const result = await h.call('job_output', { id: STARTED })
  assert.equal(result.ok, false)
  assert.match(result.message, /unknown key "id"/u)
  assert.match(result.message, /this tool accepts after_seq, encoding, job_id, wait_ms/u)
  assert.doesNotMatch(result.message, /not started by this session/u)
  assert.equal(h.calls.length, 0, 'an argument error must not reach the server')
})

await test('a missing job_id names the missing field', async () => {
  const h = harness()
  const result = await h.call('job_output', {})
  assert.equal(result.ok, false)
  assert.match(result.message, /missing required field "job_id"/u)
  assert.doesNotMatch(result.message, /not started by this session/u)
  assert.equal(h.calls.length, 0)
})

await test('job_kill rejects the same mistake before reaching the server', async () => {
  const h = harness()
  const result = await h.call('job_kill', { id: STARTED })
  assert.equal(result.ok, false)
  assert.match(result.message, /unknown key "id"/u)
  assert.equal(h.calls.length, 0)
})

await test('an undeclared extra key is refused instead of forwarded', async () => {
  const h = harness()
  h.surface.ownedJobs.set(h.session, new Set([STARTED]))
  const result = await h.call('job_output', { job_id: STARTED, bogus: 1 })
  assert.equal(result.ok, false)
  assert.match(result.message, /unknown key "bogus"/u)
  assert.equal(h.calls.length, 0)
})

await test('job_list rejects an undeclared key and still answers a valid call', async () => {
  const h = harness()
  const rejected = await h.call('job_list', { status: 'all', bogus: 1 })
  assert.equal(rejected.ok, false)
  assert.match(rejected.message, /unknown key "bogus"/u)
  const accepted = await h.call('job_list', { status: 'all' })
  assert.equal(accepted.ok, true, accepted.message)
})

await test("a well-formed call for another session's job is still refused", async () => {
  const h = harness()
  h.surface.ownedJobs.set(h.session, new Set([STARTED]))
  const result = await h.call('job_kill', { job_id: 'j-zzzzzz' })
  assert.equal(result.ok, false)
  assert.match(result.message, /not started by this session/u)
  assert.equal(h.calls.length, 0, 'ownership must still be decided before the server call')
})

await test('a well-formed owned call reaches the server', async () => {
  const h = harness()
  h.surface.ownedJobs.set(h.session, new Set([STARTED]))
  const result = await h.call('job_output', { job_id: STARTED })
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(h.calls.map(entry => entry.name), ['job_output'])
  assert.deepEqual(h.calls[0].args, { job_id: STARTED })
})

await test('a start becomes owned, and the plugin-injected cwd is not refused', async () => {
  const h = harness()
  const started = await h.call('run_background', { command: 'echo hi' })
  assert.equal(started.ok, true, started.message)
  assert.deepEqual(h.calls[0].args, { command: 'echo hi', cwd: '/session-cwd' })
  const output = await h.call('job_output', { id: STARTED })
  assert.match(output.message, /unknown key "id"/u, 'the reported contradiction: owned by job_list, foreign to job_output')
  assert.equal(h.calls.length, 1, 'the mistyped read must not reach the server')
})

await test('an undeclared key on run_background is refused before the launch', async () => {
  const h = harness()
  const result = await h.call('run_background', { command: 'echo hi', run_in_background: true })
  assert.equal(result.ok, false)
  assert.match(result.message, /unknown key "run_in_background"/u)
  assert.equal(h.calls.length, 0)
})

await test('a tool with no published object schema is passed through untouched', async () => {
  const tools = RUNTIME_TOOLS.map(tool => tool.name === 'job_output' ? { name: 'job_output', inputSchema: { type: 'object' } } : tool)
  const h = harness(tools)
  h.surface.ownedJobs.set(h.session, new Set([STARTED]))
  const result = await h.call('job_output', { job_id: STARTED, anything: true })
  assert.equal(result.ok, true, result.message)
  assert.equal(h.calls.length, 1)
})

report('jobs-args')
