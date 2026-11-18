/** An unrecoverable replacement executor failure must fail open to the official tools (#962). */
import { createScope } from '@deepseek-ai/dsh-scope'
import { mountReplacements } from '../lib/publication/replacements.js'
import { mountConsumer } from '../lib/consumer/mount.js'
import { resolveConfig } from '../lib/config.js'
import { resolveShells } from '../lib/shells.js'
import { BASH_TOOL } from '../lib/policy.js'
import { assert, test, report } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { prepareStep, executeCall } from './lib/executor.mjs'

const official = name => ({ name, description: 'fixture ' + name, parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({ ran: name }) })
/** One settled host-shaped Bash failure value for a preparation stage. */
const bashFailureValue = stage => ({ kind: 'foreground', status: 'failed',
  error: 'EXECUTOR_UNAVAILABLE: ' + stage + ': fixture payload refused. No command was executed.',
  timedOut: false, timeoutMs: 120000, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } })

async function fixture(counterpartValue) {
  const { ctx, tools } = await bootHost()
  const agents = []
  ctx.provide('agents', { list: () => agents })
  const removeOfficial = tools.register(official('pwsh'))
  const bash = { ...official(BASH_TOOL), execute: async () => counterpartValue }
  const removeBash = tools.register(bash)
  await ctx.plugin({ apply(inner) {
    mountReplacements(inner, { id: 'fail-open', targets: new Map([['pwsh', BASH_TOOL]]), gate: { allows: () => true }, keepOfficial: () => false })
  } })
  await new Promise(resolve => setImmediate(resolve))
  const agent = { id: 'fail-open', session: { id: 'fail-open', header: { cwd: process.cwd() } } }
  agent.ctx = createScope(ctx, agent).ctx
  agents.push(agent)
  await ctx.serial('agent/created', { agent })
  return { ctx, tools, agent, dispose: () => { removeOfficial(); removeBash() } }
}

const names = step => step.assembly.tools.map(tool => tool.name)
const dispatch = (ctx, agent, step, name) => executeCall(ctx, { agent, toolSet: step.toolSet, name, arguments: {}, callId: name })

await test('an unrecoverable counterpart runtime failure lifts the official fallback on the next step', async () => {
  const { ctx, agent, dispose } = await fixture(bashFailureValue('bash-runtime-missing'))
  try {
    const first = await prepareStep(ctx, agent)
    try {
      assert.equal(new Set(names(first)).has('pwsh'), false, 'the replacement is active before any failure')
      const result = await dispatch(ctx, agent, first, BASH_TOOL)
      assert.equal(result.isError, false, JSON.stringify(result))
      assert.match(result.value.error, /EXECUTOR_UNAVAILABLE: bash-runtime-missing/)
    } finally { first.dispose() }
    const second = await prepareStep(ctx, agent)
    try {
      assert.equal(new Set(names(second)).has('pwsh'), true, 'the official fallback must return after an unrecoverable executor failure')
      assert.deepEqual((await dispatch(ctx, agent, second, 'pwsh')).value, { ran: 'pwsh' })
    } finally { second.dispose() }
  } finally { dispose(); await shutdown(ctx) }
})

await test('a retryable staging failure keeps the replacement in place', async () => {
  const { ctx, agent, dispose } = await fixture(bashFailureValue('bash-staging-failed'))
  try {
    const first = await prepareStep(ctx, agent)
    try { await dispatch(ctx, agent, first, BASH_TOOL) } finally { first.dispose() }
    const second = await prepareStep(ctx, agent)
    try {
      assert.equal(new Set(names(second)).has('pwsh'), false, 'a staging interruption is repaired by the next call, not by lifting the shadow')
    } finally { second.dispose() }
  } finally { dispose(); await shutdown(ctx) }
})

await test('only preparation stages no retry can repair are classified unrecoverable', async () => {
  const { unrecoverableCounterpartRuntime } = await import('../lib/publication/replacements.js')
  assert.equal(unrecoverableCounterpartRuntime(bashFailureValue('bash-runtime-missing')), true)
  assert.equal(unrecoverableCounterpartRuntime(bashFailureValue('bash-ipc-mismatch')), true)
  assert.equal(unrecoverableCounterpartRuntime(bashFailureValue('bash-lifecycle-lock-busy')), true)
  assert.equal(unrecoverableCounterpartRuntime(bashFailureValue('bash-cache-unusable')), true)
  assert.equal(unrecoverableCounterpartRuntime(bashFailureValue('bash-staging-failed')), false)
  assert.equal(unrecoverableCounterpartRuntime(bashFailureValue('bash-generation-quarantine-failed')), false)
  // The Bash tool description contract quotes remedies; a successful value never classifies.
  assert.equal(unrecoverableCounterpartRuntime({ kind: 'foreground', exitCode: 0, stdout: { text: 'EXECUTOR_UNAVAILABLE: bash-runtime-missing: quoted', truncated: false } }), false)
  // PTC Outcome failures carry a structured error, not the host message; they stay out of scope.
  assert.equal(unrecoverableCounterpartRuntime({ status: 'error', error: { code: 'EXECUTOR_UNAVAILABLE', message: 'DSH authority is unavailable' } }), false)
  // 'bash-runtime-incompatible' keeps its own complete message without the EXECUTOR_UNAVAILABLE prefix.
  assert.equal(unrecoverableCounterpartRuntime({ error: 'bash-runtime-incompatible: the resolved bash is not the pinned build.' }), true)
  assert.equal(unrecoverableCounterpartRuntime({ error: 'EXIT_CODE: command failed' }), false)
})

await test('a shell slot whose executor never resolved never hides the official tools', async () => {
  const { ctx, tools } = await bootHost()
  const agents = []
  try {
    ctx.provide('agents', { list: () => agents })
    const removeOfficial = tools.register(official('pwsh'))
    // A foreign same-name registration is the #934 host shape: the shadow used to trust its presence.
    const removeForeign = tools.register({ ...official(BASH_TOOL), execute: async () => bashFailureValue('bash-runtime-missing') })
    const core = resolveConfig({ promptPolicy: true, publishBashTool: true, bashPath: process.platform === 'win32' ? 'C:/definitely-not-here/niu.exe' : '/definitely-not-here/bash' })
    const bash = resolveShells(core).bash
    assert.equal(bash.available, false, 'the fixture must fail resolution')
    await ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) {
      mountConsumer(inner, { id: 'fail-open-unavailable', gate: { allows: () => true }, core, shell: true,
        presentation: 'native', files: false, residentTools: false, discovery: false,
        native: { alwaysLoaded: [] }, external: { allowed: [], alwaysLoaded: [], disabled: [] },
        replaceOfficial: true, replacementTargets: new Map([['pwsh', BASH_TOOL]]), section: null })
    } })
    await new Promise(resolve => setImmediate(resolve))
    const agent = { id: 'fail-open-unavailable', session: { id: 'fail-open-unavailable', header: { cwd: process.cwd() } } }
    agent.ctx = createScope(ctx, agent).ctx
    agents.push(agent)
    await ctx.serial('agent/created', { agent })
    const step = await prepareStep(ctx, agent)
    try {
      assert.equal(new Set(names(step)).has('pwsh'), true, 'an unresolvable Bash executor must keep the official tool visible')
      assert.deepEqual((await dispatch(ctx, agent, step, 'pwsh')).value, { ran: 'pwsh' })
    } finally { step.dispose() }
    removeOfficial(); removeForeign()
  } finally { await shutdown(ctx) }
})

report('publication-fail-open')
